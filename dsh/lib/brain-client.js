/**
 * The Node-side client for the helper socket. RUNS UNDER NODE, inside DSH.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section "The Wire Contract".
 *
 * Every clause this enforces, and where it comes from:
 *   - request limit 1 MiB, refused CLIENT-side before it is written
 *   - hello is the first line; requests are sent only when v, build and db all match
 *   - a mismatch of any of the three is FATAL to the session: stop the helper by the
 *     pid in owner.json and start a fresh one
 *   - deadline_ms is relative and on the wire
 *   - a response frame over the limit fails that request with payload_too_large
 *   - while the helper is restarting, requests queue with the same deadline; if the
 *     deadline expires first the caller gets helper_unavailable carrying the restart
 *     count
 *   - three failed restarts inside sixty seconds stops the restarting and reports
 *     degraded rather than flapping
 *
 * Not generated. No banner applies.
 */

import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  encodeFrame, frameBytes, splitFrames, helloMismatch, makeRequest, makeErr,
  payloadTooLargeError, MAX_LINE_BYTES, databaseFingerprint,
} from './protocol.js';
import { socketPath, ownerPath, readOwner, stopOwner, ensureDir, dshBrainDir } from './paths.js';

export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS = 60_000;
export const NO_DATABASE_CODE = 'brain_not_configured';
export const UNAVAILABLE_CODE = 'helper_unavailable';
export const VERSION_SKEW_CODE = 'helper_version_skew';

/** The env var a caller may set instead of config.databaseUrl. */
export const DATABASE_URL_ENV = 'GBRAIN_DATABASE_URL';

/**
 * Resolve the connection string. Design: "Resolution order is config, then
 * GBRAIN_DATABASE_URL. ... the row activates, publishes gbrainBrain in a DEGRADED
 * state that reports a named reason, and every brain tool call fails with
 * brain_not_configured whose fix text names both remedies."
 */
export function resolveDatabaseUrl(config = {}, env = process.env) {
  const fromConfig = config.databaseUrl;
  if (typeof fromConfig === 'string' && fromConfig.length > 0) return { url: fromConfig, from: 'config' };
  const fromEnv = env[DATABASE_URL_ENV];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { url: fromEnv, from: 'env' };
  return { url: null, from: 'none' };
}

export function notConfiguredError(config = {}) {
  const e = new Error(
    `no brain database is configured for dsh-gbrain${config.databaseUrl ? '' : ''}`,
  );
  e.code = NO_DATABASE_CODE;
  e.suggestion = `set config.databaseUrl in the profile patch for the dsh-gbrain row, or export ${DATABASE_URL_ENV}`;
  e.why = 'the plugin ships no database URL, because the harness process cwd is ~/.dsh and not the session project';
  return e;
}

export class BrainClient {
  /**
   * @param {object} opts
   * @param {string} opts.databaseUrl
   * @param {string} [opts.helperEntry] absolute path to engine-host.js
   * @param {string} [opts.bunPath]
   * @param {(msg: string) => void} [opts.onWarn]
   */
  constructor(opts) {
    this.databaseUrl = opts.databaseUrl;
    this.fingerprint = databaseFingerprint(opts.databaseUrl);
    this.socketFile = socketPath(opts.databaseUrl);
    this.ownerFile = ownerPath(opts.databaseUrl);
    this.helperEntry = opts.helperEntry ?? join(dirname(new URL(import.meta.url).pathname), 'engine-host.js');
    this.bunPath = opts.bunPath ?? 'bun';
    this.onWarn = opts.onWarn ?? (() => {});
    this.socket = null;
    this.hello = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.restarts = [];
    this.degraded = null;
    this.connecting = null;
  }

  get connected() {
    return Boolean(this.socket && this.hello && !this.socket.destroyed);
  }

  /** Start the helper and wait for a verified hello. Fatal on a mismatch. */
  async start() {
    if (this.connected) return this.hello;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connectOnce().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connectOnce() {
    ensureDir(dshBrainDir());

    if (existsSync(this.socketFile)) {
      // A socket file with a live owner from a DIFFERENT build is stale by contract.
      const owner = readOwner(this.ownerFile);
      if (owner && owner.build !== undefined && owner.build !== (await this.#localBuild())) {
        this.onWarn(`stopping stale helper pid=${owner.pid} build=${owner.build}`);
        stopOwner(this.ownerFile, { timeoutMs: 2000 });
      }
    }

    let spawned = null;
    if (!existsSync(this.socketFile)) {
      spawned = spawn(this.bunPath, [this.helperEntry, '--database-url', this.databaseUrl], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      spawned.stdout.setEncoding('utf8');
      spawned.stderr.setEncoding('utf8');
      spawned.stderr.on('data', (d) => this.onWarn(`helper: ${String(d).trim()}`));
      spawned.on('error', (e) => this.onWarn(`helper spawn failed: ${e.message}`));
    }

    const socket = await this.#dial(this.socketFile, spawned);
    this.socket = socket;
    this.buffer = '';

    const hello = await this.#readHello(socket);
    const verdict = helloMismatch(hello, { db: this.fingerprint });
    if (!verdict.ok) {
      // Fatal, not negotiated. Stop it and let the next call start a clean one.
      this.onWarn(`helper hello mismatch: ${verdict.reason}`);
      const e = new Error(`helper hello mismatch: ${verdict.reason}`);
      e.code = VERSION_SKEW_CODE;
      e.suggestion = 'the running helper was built for a different plugin build or database; it has been stopped';
      stopOwner(this.ownerFile, { timeoutMs: 2000 });
      try { socket.destroy(); } catch { /* already gone */ }
      this.socket = null;
      throw e;
    }

    this.hello = hello;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => { this.socket = null; this.hello = null; });
    socket.on('error', (err) => this.onWarn(`socket error: ${err.message}`));
    return hello;
  }

  async #localBuild() {
    // The hello carries build; this is the value recorded in owner.json. Imported
    // lazily so the constant has one definition.
    const { HELPER_BUILD } = await import('./protocol.js');
    return HELPER_BUILD;
  }

  #dial(path, child) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const attempt = () => {
        const s = connect(path);
        s.once('connect', () => resolve(s));
        s.once('error', (e) => {
          s.destroy();
          if (Date.now() > deadline) {
            reject(new Error(`could not connect to helper socket ${path}: ${e.message}`));
            return;
          }
          setTimeout(attempt, 120);
        });
      };
      if (child) child.once('exit', (code) => this.onWarn(`helper exited code=${code}`));
      attempt();
    });
  }

  #readHello(socket) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk;
        const { frames, rest } = splitFrames(buf);
        buf = rest;
        if (frames.length === 0) return;
        cleanup();
        try {
          resolve(JSON.parse(frames[0]));
        } catch (e) {
          reject(new Error(`helper hello was not JSON: ${e.message}`));
        }
      };
      const onErr = (e) => { cleanup(); reject(new Error(`helper died before hello: ${e.message}`)); };
      const cleanup = () => { socket.off('data', onData); socket.off('error', onErr); };
      socket.on('data', onData);
      socket.on('error', onErr);
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    // A response over the limit is measured BEFORE it can be trusted; the client
    // reads a line, so an over-limit line is dropped and every in-flight request
    // fails with payload_too_large rather than being buffered unbounded.
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES * 2) {
      this.buffer = '';
      this.#failAll(payloadTooLargeError(-1, -1));
      this.onWarn('dropped an over-limit helper response and failed in-flight requests');
      try { this.socket?.destroy(); } catch { /* already gone */ }
      return;
    }
    const { frames, rest } = splitFrames(this.buffer);
    this.buffer = rest;
    for (const f of frames) {
      let msg;
      try { msg = JSON.parse(f); } catch { this.onWarn('helper sent a non-JSON frame'); continue; }
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else {
        const err = new Error(msg.error?.message ?? 'helper error');
        Object.assign(err, msg.error ?? {});
        entry.reject(err);
      }
    }
  }

  #failAll(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      const err = new Error(error.message);
      Object.assign(err, error);
      entry.reject(err);
    }
  }

  /**
   * Send one request. `sourceId` is REQUIRED for every brain op and must already
   * have passed assertSourceAllowed — this method does not decide routing.
   */
  async request(op, params = {}, opts = {}) {
    if (this.degraded) throw this.degraded;
    await this.start();

    const id = this.nextId++;
    let req;
    try {
      req = makeRequest({ id, op, params, sourceId: opts.sourceId ?? null, deadlineMs: opts.deadlineMs });
    } catch (e) {
      return Promise.reject(e);
    }

    // Client-side size refusal, per the contract: the CLIENT refuses an oversized
    // request before it is written.
    if (frameBytes(req) > MAX_LINE_BYTES) {
      const err = new Error('request exceeds the 1 MiB frame limit');
      err.code = 'payload_too_large';
      err.suggestion = 'lower limit/max_nodes/depth, or narrow the request';
      throw err;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`request ${id} (${op}) exceeded deadline_ms=${req.deadline_ms}`);
        err.code = 'deadline_exceeded';
        err.suggestion = 'raise deadline_ms or narrow the request';
        reject(err);
      }, req.deadline_ms + 500);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeFrame(req));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /**
   * Restart with the documented budget: three failures inside sixty seconds stops
   * the restarting and reports degraded rather than flapping.
   */
  async restart(reason) {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    this.restarts.push(now);
    if (this.restarts.length > RESTART_LIMIT) {
      const err = new Error(`helper failed ${this.restarts.length} restarts inside ${RESTART_WINDOW_MS}ms`);
      err.code = UNAVAILABLE_CODE;
      err.why = `restart budget exhausted, last reason: ${reason}`;
      err.suggestion = 'check the helper log at ' + this.ownerFile.replace(/owner\.json$/, '') + ' and the database container';
      this.degraded = err;
      throw err;
    }
    stopOwner(this.ownerFile, { timeoutMs: 2000 });
    try { this.socket?.destroy(); } catch { /* already gone */ }
    this.socket = null;
    this.hello = null;
    return this.start();
  }

  /** Graceful stop: the shutdown control op, then a socket close. */
  async stop() {
    if (!this.socket) { stopOwner(this.ownerFile, { timeoutMs: 2000 }); return { stopped: false, reason: 'not_connected' }; }
    try {
      await this.request('shutdown', {}, { deadlineMs: 3000 });
    } catch {
      // The helper answers then leaves; a closed socket here is expected.
    }
    try { this.socket.destroy(); } catch { /* already gone */ }
    this.socket = null;
    this.hello = null;
    return { stopped: true, reason: 'shutdown_op' };
  }
}

export { makeErr };
