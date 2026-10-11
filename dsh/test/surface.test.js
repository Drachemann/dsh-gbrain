/**
 * Tests for the result mapper and the declared surface.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, sections
 * "The Operation Surface" and "How a degraded result reaches the model".
 *
 * The clauses that carry the most weight here:
 *   - "gbrain's exit code 3 means 'stop and ask the user', and a tool result that
 *      swallows it would be the most likely first user-visible failure of this plugin."
 *   - "[gbrain notice …] and [AGENT] blocks pass through as their own rendered text,
 *      never stripped."
 *   - "The tool surface is exactly the fourteen tools in dsh/lib/tools.js."
 *
 * Run: node --test dsh/test/
 *
 * Not generated. No banner applies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeError, needsHuman, renderFix, renderSuccess, renderError,
  summarise, project, toContentBlocks, toErrorBlocks, EXIT_STOP_AND_ASK,
} from '../lib/result.js';
import { TOOLS, TOOL_NAMES, TOOL_GROUPS, assertSurfaceIntegrity } from '../lib/tools.js';

// ── the declared surface ───────────────────────────────────────────────────

test('surface: exactly fourteen tools, and the groups account for all of them', () => {
  assert.equal(TOOLS.length, 14);
  assert.equal(TOOL_NAMES.length, 14);
  const grouped = Object.values(TOOL_GROUPS).flat();
  assert.equal(grouped.length, 14);
  assert.deepEqual([...grouped].sort(), [...TOOL_NAMES].sort());
  assert.doesNotThrow(() => assertSurfaceIntegrity());
});

test('surface: the six code-graph reads are present and named as the design names them', () => {
  assert.deepEqual(
    [...TOOL_GROUPS['code-graph']].sort(),
    ['code_blast', 'code_callees', 'code_callers', 'code_def', 'code_flow', 'code_refs'],
  );
});

test('surface: the five coding memory verbs and the three other groups', () => {
  assert.deepEqual([...TOOL_GROUPS.memory].sort(), ['context_pack', 'delta', 'forget', 'recall', 'remember']);
  assert.deepEqual([...TOOL_GROUPS.pages].sort(), ['get_page', 'put_page']);
  assert.deepEqual([...TOOL_GROUPS.retrieval], ['query']);
});

test('surface: reindex-code is deliberately NOT a tool', () => {
  assert.equal(TOOL_NAMES.includes('reindex-code'), false);
  assert.equal(TOOL_NAMES.includes('reindex_code'), false);
});

test('surface: every tool has a selection-grade description and typed params', () => {
  for (const t of TOOLS) {
    assert.ok(t.description.length > 60, `${t.name} description is too thin to select on`);
    assert.ok(Object.keys(t.parameters).length > 0, `${t.name} has no parameters`);
    for (const [k, p] of Object.entries(t.parameters)) {
      assert.ok(p.type, `${t.name}.${k} has no type`);
      assert.ok(p.description, `${t.name}.${k} has no description`);
    }
  }
});

// ── the error envelope reaching the model ──────────────────────────────────

test('describeError: reads gbrain toJSON and prefers the canonical code', () => {
  const d = describeError({
    code: 'frozen',
    toJSON: () => ({ code: 'permission_denied', message: 'suspended', why: 'policy', suggestion: 'run the CLI' }),
  });
  assert.equal(d.code, 'permission_denied');
  assert.equal(d.message, 'suspended');
  assert.equal(d.why, 'policy');
  assert.equal(d.suggestion, 'run the CLI');
});

test('describeError: a plain Error still yields a usable envelope', () => {
  const d = describeError(new Error('boom'));
  assert.equal(d.code, 'internal_error');
  assert.equal(d.message, 'boom');
});

test('needsHuman: ask_user and tell_user_to_run mean the model cannot proceed alone', () => {
  assert.equal(needsHuman({ fix: { next: 'ask_user' } }), true);
  assert.equal(needsHuman({ fix: { next: 'tell_user_to_run' } }), true);
  assert.equal(needsHuman({ fix: { next: 'run' } }), false);
  assert.equal(needsHuman({ fix: { next: 'wait' } }), false);
  assert.equal(needsHuman({ fix: { exit_code: EXIT_STOP_AND_ASK } }), true);
  assert.equal(needsHuman({}), false);
});

test('renderError: a refusal keeps code, why and the suggested next step', () => {
  const text = renderError({
    code: 'permission_denied',
    message: 'remote code reads stay suspended',
    why: 'raw code fragments lack the remote read policy',
    suggestion: 'run gbrain call code_def locally',
    fix: { next: 'run', command: 'gbrain call code_def \'{"symbol":"x"}\'' },
    notices: ['degraded: search served from keyword index'],
  });
  assert.match(text, /permission_denied: remote code reads stay suspended/);
  assert.match(text, /why: raw code fragments lack the remote read policy/);
  assert.match(text, /suggested next step: run gbrain call code_def locally/);
  assert.match(text, /fix: next: run \| run: gbrain call code_def/);
  assert.match(text, /notice: degraded: search served from keyword index/);
});

test('renderError: an ask-the-user refusal says so PLAINLY and forbids working around it', () => {
  const text = renderError({ code: 'x', message: 'needs an operator', fix: { next: 'ask_user', message: 'Confirm the delete.' } });
  assert.match(text, /THIS NEEDS THE USER/);
  assert.match(text, /Do not retry it or work around it/);
  assert.match(text, /Confirm the delete\./);
});

test('renderError: a runnable refusal does NOT claim a human is needed', () => {
  const text = renderError({ code: 'x', message: 'y', fix: { next: 'run', command: 'gbrain sync' } });
  assert.doesNotMatch(text, /THIS NEEDS THE USER/);
});

test('renderFix: renders each fix shape the agent contract uses', () => {
  assert.equal(renderFix({ next: 'run', argv: ['gbrain', 'sync'] }), 'next: run | command: gbrain sync');
  assert.match(renderFix({ next: 'wait', wait_ms: 500 }), /retry after 500ms/);
  assert.match(renderFix({ next: 'run', mcp: { name: 'sync' } }), /mcp: /);
  assert.equal(renderFix(null), null);
  assert.equal(renderFix({}), null);
});

// ── healthy results, including the degraded ones ───────────────────────────

test('renderSuccess: a code answer leads with the answer and keeps the raw envelope', () => {
  const value = { symbol: 'performSync', count: 2, status: 'ready', ready: true, callers: [{ id: 1 }, { id: 2 }] };
  const text = renderSuccess('code_callers', value);
  assert.match(text, /performSync: 2 callers/);
  assert.match(text, /"callers"/, 'the machine-readable envelope must survive');
});

test('renderSuccess: zero results is called out as a real answer, not a miss', () => {
  const text = renderSuccess('code_callers', { symbol: 'ghost', count: 0, status: 'ready', callers: [] });
  assert.match(text, /0 callers/);
  assert.match(text, /not the same as no callers/);
});

test('renderSuccess: a non-ready graph status is surfaced, never hidden behind an empty list', () => {
  const text = renderSuccess('code_def', { symbol: 'x', count: 0, status: 'not_built', ready: false, hint: 'run gbrain sync', defs: [] });
  assert.match(text, /graph status: not_built \(not ready\)/);
  assert.match(text, /hint: run gbrain sync/);
});

test('renderSuccess: staleness warns rather than masquerading as an empty graph', () => {
  const text = renderSuccess('code_def', { symbol: 'x', count: 1, status: 'ready', possibly_stale: true, indexed_at: '2026-01-01', defs: [{}] });
  assert.match(text, /WARNING: possibly stale/);
  assert.match(text, /indexed_at 2026-01-01/);
});

test('summarise: the three walk-result arms are distinguishable', () => {
  assert.match(summarise('code_blast', { result: 'ok', depth_groups: [{ nodes: [1, 2] }, { nodes: [3] }], truncation: 'max_nodes' }), /reached 3 node\(s\) \(truncated: max_nodes\)/);
  assert.match(summarise('code_blast', { result: 'not_found', did_you_mean: [{ symbol_qualified: 'a' }] }), /did you mean: a/);
  assert.match(summarise('code_blast', { result: 'ambiguous', candidates: [{ symbol_qualified: 'a' }, { symbol_qualified: 'b' }] }), /ambiguous, 2 candidates/);
  assert.match(summarise('code_blast', { result: 'unsupported_language', supported: ['typescript'] }), /does not support this language/);
});

test('project: distinguishes ok, error and needs_user without parsing text', () => {
  assert.equal(project('code_def', { ok: true, value: { symbol: 'x', count: 1, defs: [{}] } }).status, 'ok');
  assert.equal(project('code_def', { ok: false, error: { code: 'internal_error', message: 'x' } }).status, 'error');
  const human = project('put_page', { ok: false, error: { code: 'consent_required', message: 'x', fix: { next: 'ask_user' } } });
  assert.equal(human.status, 'needs_user');
  assert.equal(human.code, 'consent_required');
});

test('content blocks: every render path produces a non-empty text block', () => {
  for (const blocks of [
    toContentBlocks('code_def', { symbol: 'x', count: 0, defs: [] }),
    toErrorBlocks(new Error('boom')),
    project('code_def', { ok: false, error: { code: 'e', message: 'm' } }).blocks,
  ]) {
    assert.equal(Array.isArray(blocks), true);
    assert.ok(blocks.length > 0);
    assert.equal(blocks[0].type, 'text');
    assert.ok(blocks[0].text.length > 0);
  }
});
