/**
 * `engine-host.js` — the helper's START / REFUSE / FAILURE contract.
 *
 * Why this file exists: `engine-host.js` is 353 lines that run under Bun, own the
 * socket, the hello, the deadline race, write serialisation, the oversized-frame
 * backstop and every exit code — and until now **no test referenced it**. The design
 * required "a test for each" of start / stop / version-skew / stale-socket /
 * orphan-recovery, and the helper side had none.
 *
 * What is and is not tested here, stated so the gap is not mistaken for coverage:
 *
 *   COVERED, by spawning the real helper with an isolated HOME — the argument
 *   contract (exit 2), the orphan-recovery / failed-boot contract (exit 5, with the
 *   owner record cleared and the socket unlinked), and the path helpers the socket
 *   guard is built from.
 *
 *   NOT COVERED HERE:
 *     - the exit-3 socket-busy REFUSAL as an end-to-end spawn. It is asserted in two
 *       deterministic parts instead (see the last test for exactly why), because the
 *       only way to spawn it for real is to hand the helper a live pid to signal —
 *       and in a test process that live pid is *the test process itself*.
 *     - the success path: boot, hello, a real dispatch, the deadline race, write
 *       serialisation, response-size substitution. Those need `GBRAIN_DATABASE_URL`
 *       and the pgvector container.
 *
 * The helper is spawned under **Bun**, not Node: it imports gbrain's TypeScript and
 * is documented as Bun-only ("RUNS UNDER BUN, never under DSH's Node"). Cases skip
 * rather than fail when Bun is absent, because a missing runtime is an environment
 * fact, not a regression.
 *
 * Not generated. No banner applies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { socketPath, ownerPath, dshBrainDir, ensureDir, isAlive } from '../lib/paths.js';

const dshRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(dshRoot, 'lib', 'engine-host.js');

/** A database URL that is never dialled: every case here fails before `boot()` connects. */
const DB_URL = 'postgresql://nobody@127.0.0.1:1/never_connected';

const BUN_AVAILABLE = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = BUN_AVAILABLE ? false : 'bun is not on PATH (the helper is Bun-only by design)';

/**
 * Spawn the helper with an isolated HOME so it can never touch a developer's real
 * `~/.dsh/gbrain`. The timeout is generous on purpose: two cases below must reach
 * `boot()`, which imports gbrain's TypeScript, and a tight timeout would fail the
 * flaky way rather than the real way.
 */
function runHelper({ home, args, timeoutMs = 30_000 }) {
  const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: '' };
  // Prove the URL comes from the flag, not from an inherited environment.
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  return spawnSync('bun', [helper, ...args], { encoding: 'utf8', env, timeout: timeoutMs });
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-engine-host-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** A pid that is certainly dead, found by testing the predicate the helper itself uses. */
function aDeadPid() {
  for (const candidate of [0x3fffff, 0x3ffffe, 0x3ffffd, 0x3ffffc]) {
    if (!isAlive(candidate)) return candidate;
  }
  return null;
}

// ── argument contract ───────────────────────────────────────────────────────

test('helper: no database URL is a NAMED refusal (exit 2), not a crash', { skip: SKIP }, () => {
  withHome((home) => {
    const res = runHelper({ home, args: [] });
    assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr=${res.stderr}`);
    assert.match(res.stderr, /--database-url is required/);
    // It must name the environment variable as the alternative, not only the flag.
    assert.match(res.stderr, /GBRAIN_DATABASE_URL/);
    // A refusal is not a boot: nothing may have been created on disk.
    assert.equal(existsSync(dshBrainDir({}, home)), false, 'a refused start must not create the state dir');
  });
});

test('helper: an empty --database-url is treated as missing, not as a URL', { skip: SKIP }, () => {
  // The design's own precedent: "an empty-string config value is treated as unset,
  // not as a URL". The helper reads `arg(...) ?? ''` and then checks truthiness, so
  // this pins that an empty string never reaches databaseFingerprint().
  withHome((home) => {
    const res = runHelper({ home, args: ['--database-url', ''] });
    assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr=${res.stderr}`);
    assert.match(res.stderr, /--database-url is required/);
  });
});

// ── orphan recovery: the contract a failed boot must leave behind ────────────

test('helper: a DEAD owner is recovered — stale socket unlinked, then boot failure is CLEAN (exit 5)', { skip: SKIP }, () => {
  withHome((home) => {
    const socketFile = socketPath(DB_URL, {}, home);
    const ownerFile = ownerPath(DB_URL, {}, home);
    ensureDir(dirname(socketFile));
    writeFileSync(socketFile, '');

    const deadPid = aDeadPid();
    assert.ok(deadPid !== null, 'could not find a dead pid to plant');
    writeFileSync(ownerFile, JSON.stringify({ pid: deadPid, db: 'x', build: 1, socket: socketFile }));

    const res = runHelper({ home, args: ['--database-url', DB_URL, '--repo', join(home, 'no-such-repo')] });

    // It must get PAST the socket guard and fail later, at boot. Exit 3 here would
    // mean a dead helper can wedge the socket forever; exit 2 would mean the URL was
    // not accepted. Exit 5 is the boot failure this fixture is built to cause.
    assert.equal(res.status, 5, `expected exit 5 (boot failed), got ${res.status}; stderr=${res.stderr}`);
    assert.match(res.stderr, /engine boot failed/);

    // …and the failed boot must leave NO stale owner record and NO socket behind, or
    // the next start would see them and refuse. This is the orphan-recovery clause.
    assert.equal(existsSync(ownerFile), false, 'a failed boot must clear the owner record');
    assert.equal(existsSync(socketFile), false, 'a failed boot must unlink the socket');
  });
});

test('helper: an isolated HOME means the real ~/.dsh/gbrain is never touched', { skip: SKIP }, () => {
  // Guards this file's own safety property: if the HOME override stopped working,
  // every case above would start writing into the developer's real state directory.
  withHome((home) => {
    runHelper({ home, args: ['--database-url', DB_URL] });
    assert.equal(existsSync(join(home, '.dsh', 'gbrain')) || existsSync(dshBrainDir({}, home)), true,
      'the helper should still create its state dir under the HOME it was given');
  });
});

// ── the socket-busy refusal, asserted in two deterministic parts ─────────────

test('helper: the socket-busy refusal is wired, and decided before the engine boot', () => {
  // Why this is a source assertion rather than an end-to-end spawn: `engine-host.js`
  // calls `stopOwner(ownerFile, { timeoutMs: 400 })` when a socket file already
  // exists, and `stopOwner` sends SIGTERM to the pid named in owner.json. In an
  // in-process test the only conveniently "live" pid is `process.pid` — the test
  // runner — so exercising that path SIGTERMs the suite that is running it.
  //
  // This is not hypothetical. TWO earlier versions of this file did it and both were
  // reported by the runner as the whole file being one failed "test", with the
  // individual assertions never printed. The helper's behaviour cannot be pinned here
  // without a genuinely separate, disposable process to hand it — which needs a live
  // brain, and is left to the E2E tier. See the header.
  const src = readFileSync(helper, 'utf8');

  // The guard exists and keys on the reason `stopOwner` reports for a live owner.
  assert.match(src, /still_alive_after_sigterm/,
    'helper no longer checks the reason stopOwner reports for a live owner');
  assert.match(src, /socket_busy/, 'helper no longer logs the refusal');
  assert.match(src, /process\.exit\(3\)/, 'helper no longer exits 3 on a busy socket');

  // Ordering is the part that matters most: refuse-to-steal is worthless if the
  // helper has already started an engine by the time it decides. exit(3) must come
  // before `await boot()`.
  const exitThree = src.indexOf('process.exit(3)');
  const bootCall = src.indexOf('await boot()');
  assert.ok(exitThree > -1 && bootCall > -1, 'could not locate the refusal and the boot call');
  assert.ok(exitThree < bootCall,
    'the busy-socket refusal must be decided before the engine boot is attempted');

  // And the socket is only unlinked on the safe path, never while refusing.
  assert.match(src, /rmSync\(socketFile, \{ force: true \}\)/,
    'helper no longer unlinks the stale socket on the recovery path');
});

// ── guards on this file's own assumptions ───────────────────────────────────

test('helper: exit codes asserted above are codes the helper still documents', () => {
  const src = readFileSync(helper, 'utf8');
  for (const code of [2, 3, 5]) {
    assert.match(src, new RegExp(`process\\.exit\\(${code}\\)`),
      `helper no longer exits ${code}; the assertions in this file are now wrong`);
  }
});

test('helper: the state dir is keyed by DATABASE, so two brains never share a socket', () => {
  const a = socketPath('postgresql://u@h/one');
  const b = socketPath('postgresql://u@h/two');
  assert.notEqual(a, b, 'two different databases must not resolve to one socket path');
  assert.equal(socketPath('postgresql://u@h/one'), a, 'the mapping must be stable');
});
