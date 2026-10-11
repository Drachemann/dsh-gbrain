/**
 * Routing and trust contract tests.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section
 * "Routing and Trust Contract".
 *
 * These carry Success Criterion 2: a request naming a source outside the session's
 * allowed set is refused, and no silent fallback to 'default' ever happens.
 *
 * Run: node --test dsh/test/
 *
 * Not generated. No banner applies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RoutingError, ROUTING_CODES, readGbSourceFile, resolveSessionSource,
  allowedSources, assertSourceAllowed, writeTargetFor, provenanceStamp,
  matchSourceByPath, sourceLookupFrom,
} from '../lib/brain-routing.js';
import { resolveDatabaseUrl, notConfiguredError, NO_DATABASE_CODE, DATABASE_URL_ENV } from '../lib/brain-client.js';

// ── the .gbrain-source tier ────────────────────────────────────────────────

test('dotfile: takes the first non-empty, non-comment line', () => {
  assert.equal(readGbSourceFile('dsh-gbrain\n'), 'dsh-gbrain');
  assert.equal(readGbSourceFile('# a comment\ndsh-gbrain\n'), 'dsh-gbrain');
  assert.equal(readGbSourceFile('\n\n  spaced-id  \n'), 'spaced-id');
});

test('dotfile: an absent or blank file is NOT a source', () => {
  assert.equal(readGbSourceFile(''), null);
  assert.equal(readGbSourceFile('\n\n'), null);
  assert.equal(readGbSourceFile(undefined), null);
  assert.equal(readGbSourceFile('# only a comment\n'), null);
});

// ── resolution order ───────────────────────────────────────────────────────

test('resolve: tier 1 is the project root .gbrain-source', () => {
  const out = resolveSessionSource({
    projectRoot: '/repo',
    gbSourceContent: 'pinned-source\n',
    lookupByPath: () => 'path-source',
    knownSources: ['pinned-source', 'path-source'],
  });
  assert.deepEqual(out, { sourceId: 'pinned-source', tier: 'dotfile' });
});

test('resolve: tier 2 is the source registered against the project path', () => {
  const out = resolveSessionSource({
    projectRoot: '/repo',
    gbSourceContent: null,
    lookupByPath: (p) => (p === '/repo' ? 'path-source' : null),
    knownSources: ['path-source'],
  });
  assert.deepEqual(out, { sourceId: 'path-source', tier: 'local_path' });
});

test('resolve: no project root is a NAMED ABSENCE, never a default source', () => {
  assert.throws(
    () => resolveSessionSource({ projectRoot: null, lookupByPath: () => 'ignored' }),
    (e) => {
      assert.ok(e instanceof RoutingError);
      assert.equal(e.code, ROUTING_CODES.NO_PROJECT_ROOT);
      assert.match(e.suggestion, /gbrain sources add/);
      return true;
    },
  );
});

test('resolve: an unresolvable source NEVER falls back to default', () => {
  try {
    resolveSessionSource({ projectRoot: '/repo', gbSourceContent: null, lookupByPath: () => null });
    assert.fail('expected a refusal');
  } catch (e) {
    assert.equal(e.code, ROUTING_CODES.NO_SOURCE);
    assert.doesNotMatch(e.message, /default/, 'the refusal must not name a fallback source');
    assert.match(e.suggestion, /sources add/);
  }
});

test('resolve: a .gbrain-source naming an unknown source is refused, not guessed', () => {
  assert.throws(
    () => resolveSessionSource({ projectRoot: '/repo', gbSourceContent: 'ghost\n', knownSources: ['real'] }),
    (e) => {
      assert.equal(e.code, ROUTING_CODES.NO_SOURCE);
      assert.match(e.message, /ghost/);
      return true;
    },
  );
});

// ── the allowed set ────────────────────────────────────────────────────────

test('allowed set: exactly the project source plus the configured memory source', () => {
  const set = allowedSources('project-src', 'memory-src');
  assert.deepEqual([...set].sort(), ['memory-src', 'project-src']);
  assert.equal(set.size, 2);
});

test('allowed set: with no memory source it is the project source alone', () => {
  const set = allowedSources('project-src', null);
  assert.deepEqual([...set], ['project-src']);
});

test('allowed set: a foreign source is refused with source_not_allowed', () => {
  const allowed = allowedSources('project-src', 'memory-src');
  assert.throws(
    () => assertSourceAllowed('someone-elses-repo', allowed),
    (e) => {
      assert.equal(e.code, ROUTING_CODES.NOT_ALLOWED);
      assert.match(e.message, /someone-elses-repo/);
      assert.match(e.suggestion, /project-src/, 'the refusal names what IS allowed');
      return true;
    },
  );
});

test('allowed set: each allowed member passes the guard', () => {
  const allowed = allowedSources('project-src', 'memory-src');
  assert.equal(assertSourceAllowed('project-src', allowed), 'project-src');
  assert.equal(assertSourceAllowed('memory-src', allowed), 'memory-src');
});

test('allowed set: an empty candidate is a named absence too', () => {
  assert.throws(() => assertSourceAllowed(null, allowedSources('a', 'b')), (e) => e.code === ROUTING_CODES.NO_SOURCE);
  assert.throws(() => assertSourceAllowed('', allowedSources('a', 'b')), (e) => e.code === ROUTING_CODES.NO_SOURCE);
});

// ── write targeting, the MEM-3 fix ─────────────────────────────────────────

test('write target: prefers the memory source so a write never lands in a code mirror', () => {
  assert.equal(writeTargetFor('project-src', 'memory-src'), 'memory-src');
  assert.equal(writeTargetFor('project-src', null), 'project-src');
});

test('write target: is always inside the allowed set', () => {
  const project = 'project-src';
  const memory = 'memory-src';
  const allowed = allowedSources(project, memory);
  for (const target of [writeTargetFor(project, memory), writeTargetFor(project, null)]) {
    assert.doesNotThrow(() => assertSourceAllowed(target, allowed));
  }
});

test('provenance: stamps session, project, version and tool', () => {
  const stamp = provenanceStamp({ sessionId: 's1', projectRoot: '/repo', pluginVersion: '1.0.0', tool: 'put_page' });
  assert.equal(stamp.session_id, 's1');
  assert.equal(stamp.project_path, '/repo');
  assert.equal(stamp.plugin_version, '1.0.0');
  assert.equal(stamp.tool, 'put_page');
  assert.match(stamp.written_at, /^\d{4}-\d{2}-\d{2}T/);
});

// ── configuration, and the degraded path ───────────────────────────────────

test('config: resolves config.databaseUrl first, then the environment', () => {
  const fromConfig = resolveDatabaseUrl({ databaseUrl: 'postgresql://config' }, { [DATABASE_URL_ENV]: 'postgresql://env' });
  assert.deepEqual(fromConfig, { url: 'postgresql://config', from: 'config' });

  const fromEnv = resolveDatabaseUrl({}, { [DATABASE_URL_ENV]: 'postgresql://env' });
  assert.deepEqual(fromEnv, { url: 'postgresql://env', from: 'env' });
});

test('config: unset is a NAMED absence naming both remedies, not an activation failure', () => {
  const none = resolveDatabaseUrl({}, {});
  assert.deepEqual(none, { url: null, from: 'none' });

  const err = notConfiguredError({});
  assert.equal(err.code, NO_DATABASE_CODE);
  assert.match(err.suggestion, /databaseUrl/, 'names the config remedy');
  assert.match(err.suggestion, new RegExp(DATABASE_URL_ENV), 'names the env remedy');
});

test('config: an empty-string config value is treated as unset, not as a URL', () => {
  assert.equal(resolveDatabaseUrl({ databaseUrl: '' }, { [DATABASE_URL_ENV]: 'postgresql://env' }).from, 'env');
  assert.equal(resolveDatabaseUrl({ databaseUrl: '' }, {}).from, 'none');
});

// ── ROUTING TIER 2: which source is registered against this path ───────────
// These exist because tier 2 was MISSING and every call on an ordinarily-registered
// project refused with no_source_for_project, even when the source was correct.

test('tier2: an exact path match resolves the source', () => {
  const sources = [
    { source_id: 'other', local_path: '/repos/other' },
    { source_id: 'mine', local_path: '/repos/mine' },
  ];
  assert.equal(matchSourceByPath(sources, '/repos/mine'), 'mine');
});

test('tier2: trailing slashes do not defeat the match', () => {
  const sources = [{ source_id: 'mine', local_path: '/repos/mine/' }];
  assert.equal(matchSourceByPath(sources, '/repos/mine'), 'mine');
  assert.equal(matchSourceByPath(sources, '/repos/mine/'), 'mine');
});

test('tier2: a PATH PREFIX is NOT a match — the sibling trap', () => {
  // '/repos/mine-other' must never resolve to the source rooted at '/repos/mine'.
  const sources = [{ source_id: 'mine', local_path: '/repos/mine' }];
  assert.equal(matchSourceByPath(sources, '/repos/mine-other'), null);
  assert.equal(matchSourceByPath(sources, '/repos/miner'), null);
});

test('tier2: a nested checkout resolves to the enclosing source on a segment boundary', () => {
  const sources = [{ source_id: 'mono', local_path: '/repos/mono' }];
  assert.equal(matchSourceByPath(sources, '/repos/mono/packages/app'), 'mono');
});

test('tier2: the DEEPEST enclosing source wins when sources nest', () => {
  const sources = [
    { source_id: 'outer', local_path: '/repos/mono' },
    { source_id: 'inner', local_path: '/repos/mono/packages/app' },
  ];
  assert.equal(matchSourceByPath(sources, '/repos/mono/packages/app/src'), 'inner');
  assert.equal(matchSourceByPath(sources, '/repos/mono/other'), 'outer');
});

test('tier2: no match returns null so tier 3 stays a named absence', () => {
  assert.equal(matchSourceByPath([{ source_id: 'x', local_path: '/a' }], '/b'), null);
  assert.equal(matchSourceByPath([], '/b'), null);
  assert.equal(matchSourceByPath(null, '/b'), null);
  assert.equal(matchSourceByPath([{ source_id: 'x', local_path: '/a' }], null), null);
});

test('tier2: a source with no local_path is skipped, not matched as empty', () => {
  const sources = [{ source_id: 'no-path' }, { source_id: 'mine', local_path: '/repos/mine' }];
  assert.equal(matchSourceByPath(sources, '/repos/mine'), 'mine');
  assert.equal(matchSourceByPath([{ source_id: 'no-path' }], '/repos/mine'), null);
});

test('tier2: sourceLookupFrom binds a fetched registry into a tier-2 lookup', async () => {
  const lookup = sourceLookupFrom([{ source_id: 'mine', local_path: '/repos/mine' }]);
  const out = resolveSessionSource({ projectRoot: '/repos/mine', gbSourceContent: null, lookupByPath: lookup });
  assert.deepEqual(out, { sourceId: 'mine', tier: 'local_path' });
});

test('tier2: an UNRESOLVED tier 2 still refuses with no_source_for_project', () => {
  const lookup = sourceLookupFrom([{ source_id: 'mine', local_path: '/repos/mine' }]);
  assert.throws(
    () => resolveSessionSource({ projectRoot: '/repos/nowhere', gbSourceContent: null, lookupByPath: lookup }),
    (e) => {
      assert.equal(e.code, ROUTING_CODES.NO_SOURCE);
      assert.match(e.suggestion, /sources add/);
      return true;
    },
  );
});

test('tier2: tier 1 still beats tier 2 when a dotfile pin exists', () => {
  const out = resolveSessionSource({
    projectRoot: '/repos/mine',
    gbSourceContent: 'pinned\n',
    lookupByPath: () => 'from-path',
    knownSources: ['pinned', 'from-path'],
  });
  assert.equal(out.tier, 'dotfile');
  assert.equal(out.sourceId, 'pinned');
});

test('tier2: the row field is `id` — the shape a live sources_list actually returns', () => {
  // Verified against a live call: rows are {id, name, local_path, remote_url, federated,
  // page_count, last_sync_at} and carry NO source_id. A matcher that read source_id
  // first only worked through a fallback, which is luck rather than a contract.
  const live = [
    { id: 'default', name: 'default', local_path: '/content/default', remote_url: null, federated: true, page_count: 0, last_sync_at: null },
    { id: 'dsh-gbrain', name: 'dsh-gbrain', local_path: '/repos/dsh-gbrain', remote_url: null, federated: false, page_count: 8031, last_sync_at: null },
  ];
  assert.equal(matchSourceByPath(live, '/repos/dsh-gbrain'), 'dsh-gbrain');
  assert.equal(matchSourceByPath(live, '/repos/dsh-gbrain/dsh/lib'), 'dsh-gbrain');
  assert.equal(matchSourceByPath(live, '/content/default'), 'default');
});
