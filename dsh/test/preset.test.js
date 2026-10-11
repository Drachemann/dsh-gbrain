/**
 * Tests for the PRESET row and the tool executor.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, sections "The Chosen Shape" and
 * "The Operation Surface".
 *
 * The failure this file is built to catch, in the design's words: a copy of the shipped
 * preset that goes stale — "overriding `preset-standard` instead *'would silently drop
 * every tool a future DSH adds.'*" Nothing errors when that happens; the preset just
 * quietly lacks a plugin. So the assertions below compare our copy against the SHIPPED
 * file rather than against our own output.
 *
 * Run: node --test dsh/test/
 *
 * Not generated. No banner applies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { TOOLS, TOOL_NAMES } from '../lib/tools.js';
import { makeExecutor, normaliseParams, isWriteTool, registerTools, sessionContext } from '../lib/tools-exec.js';
import { apply as applyToolsRow, name as toolsRowName, inject as rowInject } from '../lib/tools-entry.js';

const dshRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const presetPath = join(dshRoot, 'presets', 'gbrain-tools.patch.yml');
const pkg = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'));

/**
 * Strip comments so the inject scan reads CODE, not prose about code.
 *
 * Without this the scan is wrong in both directions: this repository documents the
 * `ctx.session` defect in the very comments that explain why it is gone, and a scan that
 * cannot tell an explanation from a read would fail on the explanation. It is a
 * deliberate approximation — a string literal containing `//` or `/*` would confuse it —
 * and that is acceptable because this file contains no such literal, while a real parser
 * would be a dependency the repository does not need for a test guard.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

// ── the preset row ─────────────────────────────────────────────────────────

test('preset: the file exists and carries a generated banner naming its source', () => {
  assert.equal(existsSync(presetPath), true, 'run `node dsh/scripts/gen-preset.mjs`');
  const text = readFileSync(presetPath, 'utf8');
  assert.match(text, /^# GENERATED FILE — do not edit\./);
  assert.match(text, /^# SHIPPED_FROM: \S+standard\.patch\.yml$/m, 'the source file must be named');
  assert.match(text, /^# Generator: dsh\/scripts\/gen-preset\.mjs$/m);
});

test('preset: declares OUR preset id and does NOT override preset-standard', () => {
  const text = readFileSync(presetPath, 'utf8');
  assert.match(text, /^\s+- id: preset-dsh-gbrain$/m);
  assert.match(text, /^\s+id: dsh-gbrain$/m);
  assert.doesNotMatch(
    text,
    /^\s+- id: preset-standard$/m,
    'overriding preset-standard would give every mode in the profile the gbrain tools',
  );
});

test('preset: its order is after the shipped preset it copies', () => {
  const text = readFileSync(presetPath, 'utf8');
  const shipped = Number((text.match(/^# SHIPPED_PRESET_ORDER: (\d+)$/m) ?? [])[1]);
  const ours = Number((text.match(/^\s+order: (\d+)$/m) ?? [])[1]);
  assert.ok(Number.isFinite(shipped) && Number.isFinite(ours));
  assert.ok(ours > shipped, `ours (${ours}) should sort after the shipped preset (${shipped})`);
});

test('preset: carries the SHIPPED plugin list verbatim, plus exactly one row of ours', () => {
  const text = readFileSync(presetPath, 'utf8');
  const shippedPath = (text.match(/^# SHIPPED_FROM: (.+)$/m) ?? [])[1];
  const shipped = readFileSync(shippedPath, 'utf8');

  // The DECLARATION row is `- id: preset-...`; plugin rows are everything else.
  // Excluding by id PREFIX instead was a bug: our own `preset-dsh-gbrain` declaration
  // row also starts with `preset-`, so it looked like an added plugin row.
  const declOf = (src) => (src.match(/^\s+- id: (preset-\S+)$/m) ?? [])[1];
  const rowIds = (src) => [...src.matchAll(/^\s+- id: (\S+)$/gm)].map((m) => m[1]);
  const pluginRows = (src) => {
    const decl = declOf(src);
    return rowIds(src).filter((id) => id !== decl);
  };

  const shippedPlugins = pluginRows(shipped);
  const ourPlugins = pluginRows(text);

  // 1. Nothing the shipped preset carries may be missing from our copy.
  const missing = shippedPlugins.filter((id) => !ourPlugins.includes(id));
  assert.deepEqual(missing, [], `our copy is missing shipped rows: ${missing.join(', ')}`);

  // 2. And ours adds exactly the one row it exists to add.
  const added = ourPlugins.filter((id) => !shippedPlugins.includes(id));
  assert.deepEqual(added, ['gbrain-tools'], `unexpected extra rows: ${added.join(', ')}`);

  // 3. Sanity: the shipped preset really does carry a substantial list, so a broken
  //    parse cannot make the two assertions above pass vacuously.
  assert.ok(shippedPlugins.length >= 15, `parsed only ${shippedPlugins.length} shipped plugin rows`);
  assert.equal(ourPlugins.length, shippedPlugins.length + 1);
});

test('preset: the tools row names a specifier this package actually resolves', () => {
  const text = readFileSync(presetPath, 'utf8');
  const name = (text.match(/^\s+- id: gbrain-tools\n\s+name: (\S+)$/m) ?? [])[1];
  assert.ok(name, 'the gbrain-tools row must carry a name');
  const [pkgName, subpath] = name.split('/');
  assert.equal(pkgName, pkg.name, `the row names package "${pkgName}" but this package is "${pkg.name}"`);
  assert.ok(pkg.exports[`./${subpath}`], `"./${subpath}" is not in package.json exports`);
});

test('preset: the bundle manifest declares the preset patch, not only the host patch', () => {
  assert.deepEqual(pkg.dsh.bundle.patch, ['./cordis.patch.yml', './presets/gbrain-tools.patch.yml']);
  for (const p of pkg.dsh.bundle.patch) {
    assert.equal(existsSync(join(dshRoot, p)), true, `declared patch is missing on disk: ${p}`);
  }
});

test('preset: the generator --check passes on the committed file', () => {
  // This is the real drift gate: it re-reads the SHIPPED preset, so a DSH release that
  // adds a plugin fails here instead of silently depriving our preset of it.
  const out = execFileSync(process.execPath, [join(dshRoot, 'scripts', 'gen-preset.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /ok\s+presets\/gbrain-tools\.patch\.yml/);
});

// ── the tool executor ──────────────────────────────────────────────────────

test('executor: a model-supplied source_id is DROPPED, never honoured', () => {
  // The design: "A tool handler never accepts a source_id parameter." Dropping it means a
  // model cannot widen its own scope even by inventing the argument.
  const out = normaliseParams('code_def', { symbol: 'x', source_id: 'someone-elses-repo' });
  assert.equal(out.source_id, undefined);
  assert.equal(out.symbol, 'x');

  const out2 = normaliseParams('put_page', { slug: 'a', content: 'b', sourceId: 'foreign' });
  assert.equal(out2.sourceId, undefined);
  assert.equal(out2.slug, 'a');
});

test('executor: reads go through request, writes through write', async () => {
  const calls = [];
  const brain = {
    request: async (op, params) => { calls.push(['request', op, params]); return { result: { ok: true } }; },
    write: async (op, params) => { calls.push(['write', op, params]); return { result: { slug: 'a' }, routing: { landedIn: 'mem' } }; },
  };
  const getBrain = () => brain;

  await makeExecutor('code_def', getBrain)({ symbol: 'x' });
  await makeExecutor('remember', getBrain)({ content: 'note' });
  await makeExecutor('put_page', getBrain)({ slug: 'a', content: 'b' });
  await makeExecutor('forget', getBrain)({ slug: 'a' });

  assert.deepEqual(calls.map((c) => c[0]), ['request', 'write', 'write', 'write']);
  assert.equal(isWriteTool('remember'), true);
  assert.equal(isWriteTool('code_def'), false);
});

test('executor: a write returns where it landed so a misroute is visible', async () => {
  const brain = {
    request: async () => ({ result: {} }),
    write: async () => ({ result: { slug: 'a' }, routing: { landedIn: 'memory-src', sourceId: 'memory-src' } }),
  };
  const out = await makeExecutor('put_page', () => brain)({ slug: 'a', content: 'b' });
  assert.equal(out._routing.landedIn, 'memory-src');
});

test('executor: a refusal keeps its code, why, fix and the needs-user signal on the throw', async () => {
  const brain = {
    request: async () => {
      const e = new Error('remote code reads stay suspended');
      e.toJSON = () => ({
        code: 'permission_denied',
        message: 'remote code reads stay suspended',
        why: 'raw code fragments lack the remote read policy',
        suggestion: 'run gbrain call code_def locally',
        fix: { next: 'ask_user', message: 'Confirm the local read.' },
      });
      throw e;
    },
  };
  await assert.rejects(() => makeExecutor('code_def', () => brain)({ symbol: 'x' }), (e) => {
    assert.equal(e.code, 'permission_denied');
    assert.match(e.why, /remote read policy/);
    assert.match(e.suggestion, /gbrain call/);
    assert.equal(e.needsUser, true, 'an ask-the-user refusal must be marked so, not flattened');
    return true;
  });
});

test('executor: a missing service fails by name rather than as undefined', async () => {
  await assert.rejects(() => makeExecutor('code_def', () => null)({ symbol: 'x' }), (e) => {
    assert.equal(e.code, 'brain_service_unavailable');
    return true;
  });
});

test('registerTools: registers exactly the declared tools with a render projection', () => {
  const registered = [];
  const ctx = { tools: { register: (d) => registered.push(d) } };
  const brain = { request: async () => ({ result: { symbol: 'x', count: 0, defs: [] } }), write: async () => ({ result: {}, routing: {} }) };

  const names = registerTools({ ctx, tools: TOOLS, defineTool: (d) => d, getBrain: () => brain });

  assert.equal(registered.length, 14);
  assert.deepEqual(names, TOOL_NAMES);
  for (const d of registered) {
    assert.ok(d.name && d.description && d.parameters);
    assert.equal(typeof d.execute, 'function');
    assert.equal(d.output.schema.type, 'object');
    assert.equal(typeof d.output.render, 'function');
    // The render projection must produce content blocks, not a bare string.
    const blocks = d.output.render({}, { value: 1 });
    assert.equal(Array.isArray(blocks), true);
    assert.equal(blocks[0].type, 'text');
  }
});

test('registerTools: codeTools false withdraws exactly the six code-graph tools', () => {
  const registered = [];
  const ctx = { tools: { register: (d) => registered.push(d) } };
  const brain = { request: async () => ({ result: {} }), write: async () => ({ result: {}, routing: {} }) };
  const kept = TOOLS.filter((t) => t.group !== 'code-graph');
  registerTools({ ctx, tools: kept, defineTool: (d) => d, getBrain: () => brain });
  assert.equal(registered.length, 8);
  for (const d of registered) {
    assert.equal(['code_def', 'code_refs', 'code_callers', 'code_callees', 'code_blast', 'code_flow'].includes(d.name), false);
  }
});

// ── the row's MANDATORY config: defineTool ─────────────────────────────────
//
// REGRESSION (2026-10-11). `lib/tools-entry.js` takes `defineTool` from its row config by
// design: the row lives outside the profile tree, so it cannot resolve the peer
// `@deepseek-ai/dsh-tools` from its own real path, and the composition supplies the
// harness's real one instead. No composition did.
//
// Consequence, measured: `registerTools` called `undefined(...)`, `apply()` threw
// "defineTool is not a function", the agent-preset registry recorded that as the preset's
// `broken` reason, and BOTH `preset-dsh-gbrain` and `preset-dsh-drache-technik` showed
// "Failed to load" in the mode roster and could not be selected. Nothing above caught it
// because every test called `registerTools` directly with an identity `defineTool`; none
// called `apply()` with a config shaped like the one the preset actually ships.

test('preset: the tools row SUPPLIES defineTool, because the row cannot resolve it itself', () => {
  const text = readFileSync(presetPath, 'utf8');
  const row = text.slice(text.indexOf('- id: gbrain-tools'));
  assert.match(
    row,
    /^\s+defineTool: !!js \S/m,
    'without defineTool the row throws and the whole preset fails to load',
  );
});

test('entry: apply() names a missing defineTool rather than dying as "not a function"', () => {
  const ctx = {
    get: () => ({ ok: true }), // the Host row published gbrainBrain
    tools: { register: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  assert.throws(
    () => applyToolsRow(ctx, { codeTools: true }),
    (e) => {
      assert.ok(e.message.includes(toolsRowName), `the row must name itself: ${e.message}`);
      assert.ok(e.message.includes('config.defineTool is not a function'), e.message);
      return true;
    },
  );
});

test('entry: apply() registers all fourteen tools once the composition supplies defineTool', () => {
  const registered = [];
  const ctx = {
    get: () => ({ ok: true }),
    tools: { register: (d) => registered.push(d) },
    logger: { info: () => {}, warn: () => {} },
  };
  const out = applyToolsRow(ctx, { codeTools: true, defineTool: (d) => d });
  assert.equal(registered.length, 14);
  assert.deepEqual(out.registered, TOOL_NAMES);
});

// ── the row's inject contract ──────────────────────────────────────────────
//
// REGRESSION (second layer). Cordis raises
//   cannot get property "<name>" without inject
// for any service read as a plain `ctx.<name>` property that is not declared in the
// row's `inject` list. This row reaches the registry as `ctx.tools.register(...)`
// (lib/tools-exec.js) but declared only `gbrainBrain`, so on a real Host the row threw
// during activation and the preset showed "Failed to load" again.
//
// WHY NOTHING CAUGHT IT: every test above drives a FAKE ctx object, and a fake ctx does
// not enforce the inject contract — it answers `ctx.tools` for a service that was never
// injected. Both fatal activation bugs in this row (the missing `defineTool`, then this)
// hid behind exactly that gap. The assertion below is therefore deliberately STATIC: it
// compares the services the source reads as plain properties against the declared inject
// list, which is the invariant Cordis actually enforces.
//
// A runtime mount cannot stand in for it. A locally constructed Context resolves the
// property through the prototype chain and short-circuits the gate, so a scratch
// cordis mount activates this row even with the BROKEN inject list — it is more
// permissive than the Host and must not be used as evidence here.
//
// Every sibling that registers tools declares it: `dsh-wyrmbrain`
// (`['tools', 'wyrmbrainJev', 'modelPolicy']`), `dsh-gstack`
// (`['tools', 'llm', 'agentDefaultModel']`), the shipped `dsh-tool-todo`.

test('entry: the row injects every service it reads as a plain ctx property', () => {
  // `lib/index.js` is the file that reads `ctx` most, and omitting it is how this scan
  // missed the defect it was written for: the Host row read `ctx.session.dir` and
  // `ctx.session.id`, neither declared and neither a real service, so every one of the
  // fourteen tools threw `cannot get property "session" without inject`. A scan that
  // looks at two of the three files that touch `ctx` proves nothing about the third.
  const sources = ['lib/index.js', 'lib/tools-entry.js', 'lib/tools-exec.js']
    .map((rel) => stripComments(readFileSync(join(dshRoot, rel), 'utf8')));

  // Ambient Cordis members live on the proxy/handler, not the service registry, so
  // reading them needs no inject.
  const AMBIENT = new Set([
    'get', 'set', 'provide', 'accessor', 'mixin', 'effect', 'plugin', 'inject',
    'fiber', 'root', 'reflect', 'registry', 'events', 'scope', 'isolate',
    'on', 'once', 'emit', 'parallel', 'serial', 'bail', 'waterfall', 'logger',
  ]);

  const bare = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
      if (!AMBIENT.has(m[1])) bare.add(m[1]);
    }
  }

  assert.ok(
    bare.has('tools'),
    'the scan must find the ctx.tools.register call, or it proves nothing',
  );
  for (const service of bare) {
    assert.ok(
      rowInject.includes(service),
      `ctx.${service} is read as a plain property but "${service}" is not in the inject list `
      + `([${rowInject.join(', ')}]) — Cordis throws here on a real Host`,
    );
  }
  assert.ok(rowInject.includes('gbrainBrain'), 'the Host half must publish the brain first');
});

// ── the session context: where the calling session's project root comes from ──
//
// REGRESSION. These three carry the defect that killed all fourteen tools: the Host
// row read the session root off `ctx.session`, a Cordis property that is neither
// declared in `inject` nor a real service in DSH 0.2.0-rc.2, so every call threw
// `cannot get property "session" without inject` and the failure named no row.
//
// The root is a property of the CALL, not of the plugin, so it must arrive through the
// tool execution context. `execute(args, exec)` is the contract; the field is
// `exec.agent.session.header.cwd`, read that way by the harness's own `dsh-tool-bash`.

test('exec: the session root is read from exec.agent.session.header.cwd', () => {
  const shape = {
    agent: { id: 'agent-42', session: { header: { cwd: '/home/matt/src/dsh-gstack' } } },
    callId: 'call-1',
    signal: new AbortController().signal,
  };
  assert.deepEqual(
    sessionContext(shape),
    { projectRoot: '/home/matt/src/dsh-gstack', sessionId: 'agent-42' },
  );
});

test('exec: a call with no session resolves to null, which is the DESIGNED refusal', () => {
  // Not `undefined`: routing distinguishes "no project is known" from "no project is
  // set", and only the former is refused before any dial. This test pins the value the
  // guard switches on.
  assert.deepEqual(sessionContext(undefined), { projectRoot: null, sessionId: null });
  assert.deepEqual(sessionContext({}), { projectRoot: null, sessionId: null });
  assert.deepEqual(
    sessionContext({ agent: { id: 'a', session: { header: {} } } }),
    { projectRoot: null, sessionId: 'a' },
  );
  assert.deepEqual(
    sessionContext({ agent: { session: { header: { cwd: '' } } } }),
    { projectRoot: null, sessionId: null },
    'an empty cwd is absent, not a project called ""',
  );
});

test('exec: the executor forwards the session from exec into the brain service', async () => {
  // The executor used to take only `(args)` and call `brain.request(op, params)`, so the
  // Host row had nowhere to learn the caller's project from. This fails if that
  // signature regresses.
  const seen = [];
  const brain = {
    request: async (op, params, session) => { seen.push({ op, session }); return { ok: true }; },
    write: async (op, params, session) => { seen.push({ op, session }); return { result: {}, routing: {} }; },
  };
  const exec = { agent: { id: 'agent-7', session: { header: { cwd: '/repo' } } } };

  await makeExecutor('code_def', () => brain)({ symbol: 'x' }, exec);
  assert.deepEqual(seen[0], { op: 'code_def', session: { projectRoot: '/repo', sessionId: 'agent-7' } });

  await makeExecutor('put_page', () => brain)({ slug: 's' }, exec);
  assert.deepEqual(seen[1], { op: 'put_page', session: { projectRoot: '/repo', sessionId: 'agent-7' } });
});
