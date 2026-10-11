/**
 * The dsh-gbrain engine host. RUNS UNDER BUN, never under DSH's Node.
 *
 * Why a separate process: DSH executes under Node, and gbrain's TypeScript cannot
 * load there at all — 72 parameter properties across 65 files fail Node's
 * strip-only mode, and 11 modules use Bun-only `with { type: 'file' }` imports.
 * This process exists so the plugin touches gbrain's EXPORTED SUBPATHS
 * (engine-factory, operations) and never its internal module paths, which is what
 * keeps an upstream merge cheap.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, sections "The Chosen Shape"
 * and "The Wire Contract".
 *
 * Usage: bun dsh/lib/engine-host.js --database-url <url> [--repo <gbrain root>] [--level info]
 *
 * Not generated. No banner applies.
 */

import { createServer } from 'node:net';
import { rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PROTOCOL_VERSION, HELPER_BUILD, MAX_LINE_BYTES,
  encodeFrame, frameBytes, makeHello, makeOk, makeErr,
  payloadTooLargeError, splitFrames, toWireError, validateRequest,
  databaseFingerprint,
} from './protocol.js';
import { FILE_MODE, ensureDir, socketPath, ownerPath, logPath, writeOwner, clearOwner, stopOwner, dshBrainDir } from './paths.js';
import { createLogger } from './log.js';

// ── arguments ───────────────────────────────────────────────────────────────

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const databaseUrl = arg('database-url') ?? process.env.GBRAIN_DATABASE_URL ?? '';
if (!databaseUrl) {
  process.stderr.write('[dsh-gbrain helper] --database-url is required (or set GBRAIN_DATABASE_URL)\n');
  process.exit(2);
}
// The gbrain root: this file is <root>/dsh/lib/engine-host.js
const repoRoot = arg('repo') ?? join(import.meta.dir, '..', '..');
const level = arg('level', 'info');

const fingerprint = databaseFingerprint(databaseUrl);
const socketFile = socketPath(databaseUrl);
const ownerFile = ownerPath(databaseUrl);
const logFile = logPath(databaseUrl);
ensureDir(dshBrainDir());

const log = createLogger(logFile, { level });
log.lifecycle('helper_start', { pid: process.pid, build: HELPER_BUILD, protocol: PROTOCOL_VERSION, repo: repoRoot, socket: socketFile });

// ── engine bootstrap ────────────────────────────────────────────────────────

/**
 * Import gbrain through its EXPORTED subpaths. A relative file URL is used rather
 * than the bare specifier so the helper works whether or not gbrain is installed
 * as a package in the profile — and it is the only form that resolves when the
 * plugin runs from the fork's own checkout.
 */
async function loadGbrain(root) {
  const core = pathToFileURL(join(root, 'src', 'core')).href + '/';
  const engineFactory = await import(`${core}engine-factory.ts`);
  const operations = await import(`${core}operations.ts`);
  return { createEngine: engineFactory.createEngine, operationsByName: operations.operationsByName };
}

let engine = null;
let operationsByName = null;
let schemaVersion = null;

async function readSchemaVersion(eng) {
  // gbrain's DB schema version, not the wire version. It lives in the `config`
  // table under key 'version' — verified against a live brain, where it reads 215.
  // Best effort, and a null is honest rather than inventing a number.
  try {
    const rows = await eng.executeRaw(`SELECT value FROM config WHERE key = 'version' LIMIT 1`);
    const v = rows?.[0]?.value;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function boot() {
  const { createEngine, operationsByName: ops } = await loadGbrain(repoRoot);
  operationsByName = ops;
  const cfg = { engine: 'postgres', database_url: databaseUrl };
  engine = await createEngine(cfg);
  await engine.connect(cfg);
  schemaVersion = await readSchemaVersion(engine);
  log.lifecycle('engine_ready', { schema: schemaVersion, ops: Object.keys(ops).length });
}

// ── request handling ────────────────────────────────────────────────────────

/** Build the per-op OperationContext. `remote: false` is the whole point. */
function contextFor() {
  return {
    engine,
    // gbrain's own ops tolerate an empty config for the read paths this plugin
    // exposes; anything needing more will throw and reach the model
    // envelope rather than being silently defaulted here.
    config: {},
    logger: {
      info: (...a) => log.info('gbrain_info', { args: a.map(String) }),
      warn: (...a) => log.warn('gbrain_warn', { args: a.map(String) }),
      error: (...a) => log.error('gbrain_error', { args: a.map(String) }),
    },
    dryRun: false,
    // THE TRUST POSTURE. gbrain refuses every code read to a caller whose remote is
    // not exactly false; this helper is the trusted local lane that refusal names,
    // so it must never relax this, and the Routing and Trust Contract re-implements
    // the equivalent guard one layer up in the Host row.
    remote: false,
    sourceId: null,
  };
}

/**
 * Writes are serialised through one promise chain so two put_page calls for one
 * slug cannot interleave. Reads run concurrently.
 */
let writeChain = Promise.resolve();

async function dispatch(request) {
  const { op, params, source_id: sourceId } = request;

  if (op === 'probe') {
    return {
      ok: true,
      build: HELPER_BUILD,
      protocol: PROTOCOL_VERSION,
      schema: schemaVersion,
      engine: engine ? 'connected' : 'not_connected',
      started_at: startedAt,
    };
  }
  if (op === 'shutdown') {
    // Answer first, then leave. The caller must be able to observe the ack.
    setImmediate(() => gracefulExit('shutdown_op'));
    return { ok: true, stopping: true };
  }

  const operation = operationsByName?.[op];
  if (!operation) {
    const e = new Error(`unknown op "${op}"`);
    e.code = 'unknown_op';
    e.suggestion = `available ops: ${Object.keys(operationsByName ?? {}).slice(0, 40).join(', ')}...`;
    throw e;
  }

  const ctx = { ...contextFor(), sourceId };
  const invoke = () => operation.handler(ctx, params);

  if (['put_page', 'remember', 'forget'].includes(op)) {
    const run = writeChain.then(invoke, invoke);
    // Keep the chain alive even if this write rejects.
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
  return invoke();
}

async function handleLine(line, socket) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    socket.write(encodeFrame(makeErr(-1, {
      code: 'invalid_params',
      message: 'frame did not decode',
      why: (error).message,
      fix: { next: 'run', message: 'send one JSON object per line' },
    })));
    return;
  }

  const checked = validateRequest(parsed);
  if (!checked.ok) {
    // Only answer a structurally invalid frame when it carried a usable id;
    // otherwise the client cannot correlate it and hears nothing, which it
    // already treats unhealthy connection.
    const id = typeof parsed?.id === 'number' ? parsed.id : -1;
    socket.write(encodeFrame(makeErr(id, checked.error)));
    return;
  }

  const request = checked.request;
  const started = Date.now();
  let deadlineTimer = null;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      const e = new Error(`request ${request.id} exceeded deadline_ms=${request.deadline_ms}`);
      e.code = 'deadline_exceeded';
      e.why = 'the operation did not finish inside the relative budget the caller sent';
      e.fix = { next: 'run', message: 'raise deadline_ms, or narrow the request (lower limit/max_nodes/depth)' };
      reject(e);
    }, request.deadline_ms);
  });

  try {
    const result = await Promise.race([dispatch(request), deadline]);
    writeFrame(socket, makeOk(request.id, result), request);
    log.request({ op: request.op, source: request.source_id, outcome: 'ok', duration_ms: Date.now() - started, params: request.params });
  } catch (thrown) {
    const error = toWireError(thrown);
    writeFrame(socket, makeErr(request.id, error), request);
    log.request({
      op: request.op, source: request.source_id, outcome: 'error', code: error.code,
      duration_ms: Date.now() - started, params: request.params,
    });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/**
 * Measure before sending. A response over the limit is replaced by a BOUNDED
 * payload_too_large error carrying the same request id, so the client resolves the
 * right promise instead of timing out.
 */
function writeFrame(socket, frame, request) {
  let bytes = frameBytes(frame);
  if (bytes > MAX_LINE_BYTES) {
    const bounded = makeErr(request.id, payloadTooLargeError(request.id, bytes));
    bytes = frameBytes(bounded);
    if (bytes > MAX_LINE_BYTES) {
      // The refusal itself must be deliverable. Truncate the message rather than
      // write an oversized line.
      bounded.error.message = `response for request ${request.id} exceeded the frame limit`;
      delete bounded.error.why;
      delete bounded.error.fix;
    }
    socket.write(encodeFrame(bounded));
    log.warn('payload_too_large', { id: request.id, op: request.op, bytes });
    return;
  }
  socket.write(encodeFrame(frame));
}

// ── server ──────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString();

// A stale socket file from a dead helper would make bind() fail with EADDRINUSE.
// Only unlink after confirming nothing owns it.
if (existsSync(socketFile)) {
  const stopped = stopOwner(ownerFile, { timeoutMs: 400 });
  if (!stopped.stopped && stopped.reason === 'still_alive_after_sigterm') {
    log.error('socket_busy', { reason: stopped.reason, pid: stopped.pid });
    process.stderr.write(`[dsh-gbrain helper] a live helper (pid ${stopped.pid}) already serves ${socketFile}\n`);
    process.exit(3);
  }
  rmSync(socketFile, { force: true });
}

let connections = 0;
const server = createServer((socket) => {
  connections++;
  log.lifecycle('client_connected', { connections });

  let buffer = '';
  socket.setEncoding('utf8');

  // The hello is the first line, always. It carries v/build/schema/db so the client
  // can make the fatal comparison the design requires.
  socket.write(encodeFrame(makeHello({ schema: schemaVersion, db: fingerprint })));

  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES * 2) {
      // An unterminated oversized frame: refuse, then drop the connection. A
      // request over the limit is the client's bug and the design requires the
      // CLIENT to refuse it, so this is only a backstop.
      socket.write(encodeFrame(makeErr(-1, {
        code: 'payload_too_large',
        message: 'inbound frame exceeded the limit before a newline arrived',
        fix: { next: 'run', message: `keep one request under ${MAX_LINE_BYTES} bytes and terminate it with a newline` },
      })));
      buffer = '';
      return;
    }
    const { frames, rest } = splitFrames(buffer);
    buffer = rest;
    for (const f of frames) void handleLine(f, socket);
  });

  socket.on('error', (error) => log.warn('client_error', { message: error.message }));
  socket.on('close', () => { connections--; log.lifecycle('client_disconnected', { connections }); });
});

server.on('error', (error) => {
  log.error('server_error', { message: error.message });
  process.stderr.write(`[dsh-gbrain helper] socket error: ${error.message}\n`);
  process.exit(4);
});

let exiting = false;
function gracefulExit(reason) {
  if (exiting) return;
  exiting = true;
  log.lifecycle('helper_stop', { reason, pid: process.pid });
  try { server.close(); } catch { /* already closing */ }
  Promise.resolve(engine?.disconnect?.())
    .catch((error) => log.warn('disconnect_failed', { message: String(error?.message ?? error) }))
    .finally(() => {
      clearOwner(ownerFile);
      rmSync(socketFile, { force: true });
      process.exit(0);
    });
}

process.on('SIGTERM', () => gracefulExit('sigterm'));
process.on('SIGINT', () => gracefulExit('sigint'));

// ── boot, then bind ─────────────────────────────────────────────────────────

try {
  await boot();
} catch (error) {
  // A failed engine connection is reported, not hidden: the client sees no hello
  // and treats the helper, which is the honest outcome.
  log.error('boot_failed', { message: String(error?.message ?? error) });
  process.stderr.write(`[dsh-gbrain helper] engine boot failed: ${String(error?.message ?? error)}\n`);
  clearOwner(ownerFile);
  rmSync(socketFile, { force: true });
  process.exit(5);
}

server.listen(socketFile, () => {
  try {
    // 0600 inside a 0700 directory, per the design.
    chmodSync(socketFile, FILE_MODE);
  } catch {
    // Covered by a test; on a platform without chmod the directory mode still holds.
  }
  writeOwner(ownerFile, {
    pid: process.pid, db: fingerprint, build: HELPER_BUILD, socket: socketFile, started_at: startedAt,
  });
  log.lifecycle('listening', { socket: socketFile, pid: process.pid });
  // The control protocol is stdout-based on purpose: the Host row reads this line
  // to learn the socket path without guessing at the fingerprint.
  process.stdout.write(encodeFrame({ ready: true, socket: socketFile, pid: process.pid, build: HELPER_BUILD, protocol: PROTOCOL_VERSION }));
});

export {};
