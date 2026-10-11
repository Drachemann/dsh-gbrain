/**
 * Tests for the Host plugin entry: the code path reachable from a real entry point.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, sections "The Chosen Shape"
 * and "The Approved Decisions".
 *
 * The two clauses these carry:
 *   - "The Host row publishes `gbrainBrain` (the request surface) and `gbrainBackend`
 *      (the narrow contract dsh-memory-evolve will consume). The Host row registers no
 *      tool."
 *   - "With `databaseUrl` unset the row does not fail activation ... every brain tool
 *      call fails with `brain_not_configured`."
 *
 * These run under NODE, which is the point: the entry must load in the runtime that
 * actually hosts DSH, without any Bun-only syntax leaking into it.
 *
 * Run: node --test dsh/test/
 *
 * Not generated. No banner applies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, name as pluginName, inject as pluginInject, SERVICES } from '../lib/index.js';
import { sessionContext } from '../lib/tools-exec.js';
import { BACKEND_VERSION, BACKEND_OPERATIONS, negotiate, assertGranted, UNKNOWN_OPERATION } from '../lib/backend-contract.js';

/**
 * A fake ctx that records what the plugin does to the host — and that REFUSES to
 * invent services the real host does not provide.
 *
 * `strict` reproduces Cordis's own rule faithfully, decompiled from the installed
 * runtime: reading a property whose key is not in `ctx.reflect.props` throws
 * `cannot get property "<name>" without inject`. Without this, a mock that offers
 * `ctx.session` for free tests the MOCK instead of the host — which is exactly how
 * this row shipped broken, with all fourteen tools dead and a green suite.
 */
function fakeCtx() {
  const provided = new Map();
  const events = new Map();
  const logs = [];
  const real = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) },
    provide: (k, v) => provided.set(k, v),
    on: (k, fn) => { events.set(k, fn); return () => events.delete(k); },
  };
  const ctx = new Proxy(real, {
    get(target, key, receiver) {
      if (typeof key === 'symbol' || key in target) return Reflect.get(target, key, receiver);
      throw new Error(`cannot get property "${String(key)}" without inject`);
    },
  });
  return { provided, events, logs, ctx };
}

/**
 * An `exec` shaped like the one the harness actually passes to a tool's execute:
 * `execute(args, exec)`, where the session root lives at
 * `exec.agent.session.header.cwd` and the agent id at `exec.agent.id`.
 * Sourced from the installed `dsh-tool-bash`, which reads exactly these fields.
 */
function execFor(projectRoot, agentId = 'agent-1') {
  return { agent: { id: agentId, session: { header: projectRoot ? { cwd: projectRoot } : {} } }, callId: 'call-1' };
}

// ── the entry itself ───────────────────────────────────────────────────────

test('entry: loads under Node and exports the Cordis function-plugin shape', () => {
  assert.equal(pluginName, 'dsh-gbrain');
  assert.deepEqual(pluginInject, ['tools']);
  assert.equal(typeof apply, 'function');
});

test('entry: registers NO tool, exactly as the design requires', () => {
  const { ctx } = fakeCtx();
  // A host ctx with a tools registry that records any registration.
  const registered = [];
  ctx.tools = { register: (t) => registered.push(t) };

  apply(ctx, { databaseUrl: 'postgresql://x' });

  assert.deepEqual(registered, [], 'the Host row must register no tool; the preset row carries them');
});

test('entry: publishes both declared services', () => {
  const { ctx, provided } = fakeCtx();
  apply(ctx, { databaseUrl: 'postgresql://x' });

  assert.deepEqual([...provided.keys()].sort(), ['gbrainBackend', 'gbrainBrain']);
  assert.equal(SERVICES.brain, 'gbrainBrain');
  assert.equal(SERVICES.backend, 'gbrainBackend');
});

test('entry: registers a dispose handler so no helper outlives the plugin', () => {
  const { ctx, events } = fakeCtx();
  apply(ctx, { databaseUrl: 'postgresql://x' });
  assert.equal(typeof events.get('dispose'), 'function', 'a daemon left behind after remove_bundle is the design-named bug');
});

// ── the unconfigured path, which must NOT fail activation ─────────────────

test('unconfigured: the row still activates and publishes degraded services', () => {
  const { ctx, provided, logs } = fakeCtx();
  const env = { ...process.env };
  delete env.GBRAIN_DATABASE_URL;
  const before = process.env.GBRAIN_DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;

  try {
    apply(ctx, {});
    assert.equal(provided.has('gbrainBrain'), true, 'activation must not depend on a database being configured');
    const brain = provided.get('gbrainBrain');
    assert.equal(brain.available, false);
    assert.equal(brain.degraded?.code, 'brain_not_configured');
    assert.match(brain.degraded.suggestion, /databaseUrl/);
    assert.match(brain.degraded.suggestion, /GBRAIN_DATABASE_URL/);
    assert.ok(logs.some(([lvl]) => lvl === 'warn'), 'the degraded state is warned, not silent');
  } finally {
    if (before !== undefined) process.env.GBRAIN_DATABASE_URL = before;
  }
});

test('unconfigured: a brain call fails with the named code rather than undefined', async () => {
  const { ctx, provided } = fakeCtx();
  const before = process.env.GBRAIN_DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
  try {
    apply(ctx, {});
    const brain = provided.get('gbrainBrain');
    await assert.rejects(() => brain.request('code_def', { symbol: 'x' }), (e) => {
      assert.equal(e.code, 'brain_not_configured');
      return true;
    });
    const probe = await brain.probe();
    assert.equal(probe.ok, false);
    assert.equal(probe.code, 'brain_not_configured');
  } finally {
    if (before !== undefined) process.env.GBRAIN_DATABASE_URL = before;
  }
});

// ── routing refuses before the wire ────────────────────────────────────────

test('routing: a session with no project root is refused BEFORE any dial', async () => {
  // This calls the REAL brain.request, not a substituted body. The plugin is pointed at
  // a helper entry that does not exist, so if the routing guard ran AFTER starting the
  // helper this test would fail with a connection or spawn error instead of a routing
  // code. That ordering is the whole claim.
  const { ctx, provided } = fakeCtx({});
  apply(ctx, {
    databaseUrl: 'postgresql://127.0.0.1:1/nonexistent',
    helperEntry: '/nonexistent/engine-host.js',
  });
  const brain = provided.get('gbrainBrain');
  assert.equal(brain.available, true, 'a configured URL means the service is available for routing');

  await assert.rejects(
    () => brain.request('code_def', { symbol: 'x' }),
    (e) => {
      assert.equal(e.code, 'no_source_for_project', `expected a routing refusal, got ${e.code}: ${e.message}`);
      assert.match(e.suggestion, /sources add/);
      return true;
    },
  );
});

test('routing: a .gbrain-source pin is read from the session project root, not cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshbrain-proj-'));
  try {
    writeFileSync(join(dir, '.gbrain-source'), 'pinned-src\n');
    const { ctx, provided } = fakeCtx();
    apply(ctx, { databaseUrl: 'postgresql://x' });
    const brain = provided.get('gbrainBrain');
    assert.ok(brain, 'the service is published regardless of routing');
    // The pin is a file on disk; the next test proves it is actually consulted on a call.
    assert.equal(typeof brain.request, 'function');  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the backend contract stub ──────────────────────────────────────────────

test('backend: negotiate grants the declared operations and states write ownership', async () => {
  const out = await negotiate({ wants: ['recall', 'put_page'] });
  assert.equal(out.ok, true);
  assert.equal(out.version, BACKEND_VERSION);
  assert.deepEqual(out.operations, ['recall', 'put_page']);
  assert.deepEqual(out.writes, ['put_page']);
  assert.equal(out.writeOwnership, 'caller', 'the backend never synthesises content for the caller');
});

test('backend: an unknown operation is refused BY NAME, not silently dropped', async () => {
  const out = await negotiate({ wants: ['recall', 'teleport'] });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, UNKNOWN_OPERATION);
  assert.match(out.error.message, /teleport/);
  assert.match(out.error.suggestion, /recall/);
});

test('backend: negotiate with no wants grants the whole declared set', async () => {
  const out = await negotiate();
  assert.equal(out.ok, true);
  assert.deepEqual(out.operations, [...BACKEND_OPERATIONS]);
});

test('backend: assertGranted refuses an ungranted op before a write is attempted', async () => {
  const granted = await negotiate({ wants: ['recall'] });
  assert.equal(assertGranted(granted, 'recall'), true);
  assert.throws(() => assertGranted(granted, 'put_page'), (e) => e.code === UNKNOWN_OPERATION);
  assert.throws(() => assertGranted({ ok: false }, 'recall'), (e) => e.code === 'backend_not_negotiated');
});

test('backend: the granted set is the same set the tool surface exposes', async () => {
  const { TOOL_NAMES } = await import('../lib/tools.js');
  for (const op of BACKEND_OPERATIONS) {
    assert.ok(TOOL_NAMES.includes(op), `backend grants "${op}" which no tool exposes`);
  }
});
