/**
 * Filesystem layout, ownership records, and helper liveness.
 *
 * Companion to protocol.js (the wire contract) and hash.js (fingerprints).
 * Every rule here cites docs/designs/DSH_NATIVE_PLUGIN.md, section
 * "Routing and Trust Contract" > "Who may reach the socket":
 *
 *   - the socket lives at $XDG_RUNTIME_DIR/dsh-gbrain/<database-fingerprint>.sock,
 *     or ~/.dsh/gbrain/ when XDG_RUNTIME_DIR is unset
 *   - mode 0600 inside a 0700 directory
 *   - a second profile pointing at a DIFFERENT database gets its own helper rather
 *     than silently querying the first profile's brain; a second profile on the
 *     SAME database reuses the helper, which is correct because it is shared state
 *   - a helper that outlives its plugin is detected by the version handshake and
 *     stopped by the pid recorded in owner.json
 *
 * Not generated. No banner applies.
 */

import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { databaseFingerprint } from './protocol.js';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** The per-user directory holding sockets, owner records and logs. */
export function dshBrainDir(env = process.env, home = homedir()) {
  const runtime = env.XDG_RUNTIME_DIR;
  // The runtime dir is where a socket belongs. Logs go here too, which means a
  // reboot clears them; that is the correct trade for a per-user runtime surface
  // and the README says so.
  return runtime && runtime.length > 0 ? join(runtime, 'dsh-gbrain') : join(home, '.dsh', 'gbrain');
}

/** Full socket path for a database URL. Keyed by fingerprint, never by profile name. */
export function socketPath(databaseUrl, env = process.env, home = homedir()) {
  return join(dshBrainDir(env, home), `${databaseFingerprint(databaseUrl)}.sock`);
}

/** owner.json path for a database URL. */
export function ownerPath(databaseUrl, env = process.env, home = homedir()) {
  return join(dshBrainDir(env, home), `${databaseFingerprint(databaseUrl)}.owner.json`);
}

/** Per-database log path. */
export function logPath(databaseUrl, env = process.env, home = homedir()) {
  return join(dshBrainDir(env, home), `helper-${databaseFingerprint(databaseUrl)}.jsonl`);
}

/**
 * Create the directory at 0700. The mode is enforced on EVERY call, not only on
 * creation, because a directory made by an older build or by hand must not stay wide.
 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // A read-only or foreign-owned dir: the caller's connect will fail loudly.
  }
  return dir;
}

/**
 * @typedef {object} OwnerRecord
 * @property {number} pid
 * @property {string} db
 * @property {number} build
 * @property {string} socket
 * @property {string} started_at
 */

export function writeOwner(path, record) {
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // Best effort; the file was created 0600.
  }
}

export function readOwner(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed?.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearOwner(path) {
  rmSync(path, { force: true });
}

/** True when a process with this pid is alive. Signal 0 probes without delivering. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = gone. EPERM = alive but not ours, which still counts
    return error?.code === 'EPERM';
  }
}

/**
 * Stop a helper recorded in owner.json. Used when the version handshake says the
 * running helper is stale, and on plugin dispose.
 *
 * Returns what actually happened so the caller can report it rather than assume.
 */
export function stopOwner(path, opts = {}) {
  const owner = readOwner(path);
  if (!owner) return { stopped: false, pid: null, reason: 'no_owner_record' };
  if (!isAlive(owner.pid)) {
    clearOwner(path);
    return { stopped: false, pid: owner.pid, reason: 'already_dead' };
  }
  try {
    process.kill(owner.pid, 'SIGTERM');
  } catch (error) {
    return { stopped: false, pid: owner.pid, reason: `signal_failed:${error?.message ?? error}` };
  }
  // Caller-visible synchrony is deliberate: the caller is about to bind the same
  // socket path, so it must not race a dying helper. A short bounded wait, then
  // report honestly rather than claiming success.
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  while (Date.now() < deadline) {
    if (!isAlive(owner.pid)) {
      clearOwner(path);
      return { stopped: true, pid: owner.pid, reason: 'sigterm' };
    }
    // Busy-wait with a synchronous sleep: this whole module is sync by design so
    // the Host row can run it without async plumbing.
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    } catch {
      break;
    }
  }
  return { stopped: false, pid: owner.pid, reason: 'still_alive_after_sigterm' };
}
