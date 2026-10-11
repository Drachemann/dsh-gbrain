/**
 * Contract tests for the pieces that need no database: the wire protocol, the
 * database fingerprint, the socket layout, and the log redaction rule.
 *
 * Run: node --test dsh/test/
 *
 * These pin the clauses in docs/designs/DSH_NATIVE_PLUGIN.md, section
 * "The Wire Contract" and "Logging". Each test names the clause it pins.
 *
 * Not generated. No banner applies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROTOCOL_VERSION, HELPER_BUILD, MAX_LINE_BYTES, CONTROL_OPS, WRITE_OPS, SOURCE_FREE_OPS,
  READ_DEADLINE_MS, WRITE_DEADLINE_MS, WALK_DEADLINE_MS,
  databaseFingerprint, deadlineFor, isControlOp, isWriteOp,
  encodeFrame, frameBytes, splitFrames, makeHello, helloMismatch,
  makeRequest, validateRequest, makeOk, makeErr, payloadTooLargeError, toWireError,
} from '../lib/protocol.js';
import { FINGERPRINT_LENGTH, fingerprint } from '../lib/hash.js';
import { socketPath, ownerPath, dshBrainDir, ensureDir, DIR_MODE } from '../lib/paths.js';
import { createLogger, redactParams, MAX_LOG_FILES } from '../lib/log.js';

// ── framing ────────────────────────────────────────────────────────────────

test('framing: one object per line, newline-terminated', () => {
  const frame = encodeFrame({ id: 1, op: 'probe' });
  assert.equal(frame, '{"id":1,"op":"probe"}\n');
  assert.equal(frame.endsWith('\n'), true);
});

test('framing: splitFrames returns complete frames and keeps the remainder', () => {
  const { frames, rest } = splitFrames('{"a":1}\n{"b":2}\n{"partial"');
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, '{"partial"');
});

test('framing: size is measured on the encoded line, limit is 1 MiB', () => {
  assert.equal(MAX_LINE_BYTES, 1024 * 1024);
  const big = { id: 1, op: 'x', params: { content: 'y'.repeat(2000) } };
  assert.ok(frameBytes(big) > 2000);
  assert.equal(frameBytes(big), Buffer.byteLength(JSON.stringify(big), 'utf8'));
});

// ── the hello and the fatal comparison ─────────────────────────────────────

test('hello: carries v, hello marker, build, schema and the db fingerprint', () => {
  const hello = makeHello({ schema: 215, db: 'abc' });
  assert.equal(hello.v, PROTOCOL_VERSION);
  assert.equal(hello.hello, 'gbrain-helper');
  assert.equal(hello.build, HELPER_BUILD);
  assert.equal(hello.schema, 215);
  assert.equal(hello.db, 'abc');
});

test('hello: a matching hello is accepted', () => {
  const db = databaseFingerprint('postgresql://x');
  assert.deepEqual(helloMismatch(makeHello({ schema: 1, db }), { db }), { ok: true });
});

test('hello: mismatch on v, build or db is FATAL, not negotiated', () => {
  const db = databaseFingerprint('postgresql://x');
  const base = makeHello({ schema: 1, db });

  assert.equal(helloMismatch({ ...base, v: PROTOCOL_VERSION + 1 }, { db }).ok, false);
  assert.match(helloMismatch({ ...base, v: PROTOCOL_VERSION + 1 }, { db }).reason, /^wire_version_/);

  assert.equal(helloMismatch({ ...base, build: HELPER_BUILD + 1 }, { db }).ok, false);
  assert.match(helloMismatch({ ...base, build: HELPER_BUILD + 1 }, { db }).reason, /^build_/);

  // The db mismatch is the one that stops a second profile silently querying the
  // first profile's brain.
  const other = databaseFingerprint('postgresql://y');
  assert.equal(helloMismatch({ ...base, db: other }, { db }).ok, false);
  assert.equal(helloMismatch({ ...base, db: other }, { db }).reason, 'database_fingerprint_mismatch');

  assert.equal(helloMismatch(null, { db }).ok, false);
  assert.equal(helloMismatch({ v: 1 }, { db }).reason, 'not_a_helper');
});

// ── requests ───────────────────────────────────────────────────────────────

test('request: deadline_ms is a positive relative budget, never absolute', () => {
  const r = makeRequest({ id: 1, op: 'code_def', params: { symbol: 'x' }, sourceId: 's' });
  assert.ok(r.deadline_ms > 0);
  assert.ok(r.deadline_ms < 10 * 60 * 1000, 'a date-like absolute value would be milliseconds since epoch');
  assert.equal(r.deadline_ms, READ_DEADLINE_MS);
});

test('request: walks get the longest deadline, writes the middle, reads the shortest', () => {
  assert.equal(deadlineFor('code_blast'), WALK_DEADLINE_MS);
  assert.equal(deadlineFor('code_flow'), WALK_DEADLINE_MS);
  assert.equal(deadlineFor('put_page'), WRITE_DEADLINE_MS);
  assert.equal(deadlineFor('code_def'), READ_DEADLINE_MS);
  assert.ok(WALK_DEADLINE_MS > WRITE_DEADLINE_MS && WRITE_DEADLINE_MS > READ_DEADLINE_MS);
});

test('request: source_id is required for brain ops and refused for control ops', () => {
  assert.throws(
    () => makeRequest({ id: 1, op: 'code_def', params: {}, sourceId: null }),
    /requires a source_id/,
  );
  for (const control of CONTROL_OPS) {
    const r = makeRequest({ id: 1, op: control, params: {}, sourceId: null });
    assert.equal(r.source_id, null);
    assert.throws(() => makeRequest({ id: 1, op: control, params: {}, sourceId: 's' }), /must not carry a source_id/);
  }
});

test('request: a registry read may omit source_id, and only a named one', () => {
  // sources_list is what IMPLEMENTS routing tier 2, so it cannot require a source to be
  // already resolved. It is a named category, not a hole in the guard.
  assert.deepEqual([...SOURCE_FREE_OPS], ['sources_list']);
  const r = makeRequest({ id: 1, op: 'sources_list', params: {}, sourceId: null });
  assert.equal(r.source_id, null);
  // Everything else still refuses.
  assert.throws(() => makeRequest({ id: 2, op: 'code_def', params: {}, sourceId: null }), /requires a source_id/);
});

test('validateRequest: sources_list is accepted without a source, code_def is not', () => {
  assert.equal(validateRequest({ id: 1, op: 'sources_list', deadline_ms: 1000 }).ok, true);
  const refused = validateRequest({ id: 2, op: 'code_def', deadline_ms: 1000 });
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /source_id/);
});

test('request: write ops are exactly the ones the helper serialises', () => {
  assert.deepEqual([...WRITE_OPS].sort(), ['forget', 'put_page', 'remember']);
  assert.equal(isWriteOp('put_page'), true);
  assert.equal(isWriteOp('code_def'), false);
  assert.equal(isControlOp('probe'), true);
  assert.equal(isControlOp('shutdown'), true);
  assert.equal(isControlOp('code_def'), false);
});

test('validateRequest: rejects a malformed frame with an envelope, not a throw', () => {
  const cases = [
    [null, 'not an object'],
    [{ id: 'x', op: 'probe', deadline_ms: 1 }, 'id'],
    [{ id: 1, op: '', deadline_ms: 1 }, 'op'],
    [{ id: 1, op: 'code_def', deadline_ms: 1 }, 'source_id'],
    [{ id: 1, op: 'probe', deadline_ms: -1 }, 'deadline_ms'],
    [{ id: 1, op: 'code_def', source_id: 's', deadline_ms: 1, params: [] }, 'params'],
  ];
  for (const [raw, needle] of cases) {
    const out = validateRequest(raw);
    assert.equal(out.ok, false, `expected refusal for ${JSON.stringify(raw)}`);
    assert.equal(out.error.code, 'invalid_params');
    assert.match(out.error.message, new RegExp(needle));
  }
});

test('validateRequest: accepts a well-formed brain op and a control op', () => {
  const brain = validateRequest({ id: 1, op: 'code_def', source_id: 's', deadline_ms: 1000, params: { symbol: 'x' } });
  assert.equal(brain.ok, true);
  assert.equal(brain.request.source_id, 's');

  const control = validateRequest({ id: 2, op: 'probe', deadline_ms: 1000 });
  assert.equal(control.ok, true);
  assert.equal(control.request.source_id, null);
  assert.deepEqual(control.request.params, {});
});

// ── the error envelope ─────────────────────────────────────────────────────

test('error envelope: carries code, message, why and fix', () => {
  const frame = makeErr(7, { code: 'permission_denied', message: 'nope', why: 'because', fix: { next: 'run' } });
  assert.equal(frame.id, 7);
  assert.equal(frame.ok, false);
  assert.equal(frame.error.code, 'permission_denied');
  assert.equal(frame.error.why, 'because');
  assert.equal(frame.error.fix.next, 'run');
});

test('toWireError: preserves gbrain toJSON code, suggestion and why', () => {
  const thrown = {
    code: 'frozen_legacy',
    toJSON: () => ({
      error: 'frozen_legacy',
      code: 'permission_denied',
      message: 'remote code reads stay suspended',
      suggestion: 'run gbrain call code_def ...',
      why: 'raw code fragments lack the remote read policy',
      fix: { next: 'run', command: 'gbrain call code_def' },
    }),
  };
  const wire = toWireError(thrown);
  assert.equal(wire.code, 'permission_denied', 'canonical code wins over the frozen one');
  assert.match(wire.message, /stay suspended/);
  assert.match(wire.suggestion, /gbrain call/);
  assert.equal(wire.why, 'raw code fragments lack the remote read policy');
  assert.equal(wire.fix.next, 'run');
});

test('toWireError: a non-error becomes internal_error instead of being lost', () => {
  assert.equal(toWireError('boom').code, 'internal_error');
  assert.match(toWireError('boom').message, /boom/);
});

test('toWireError: a throwing toJSON does not hide the original error', () => {
  const wire = toWireError({ code: 'x', message: 'real', toJSON: () => { throw new Error('bad'); } });
  assert.equal(wire.code, 'x');
  assert.equal(wire.message, 'real');
});

test('payloadTooLargeError: is bounded and carries the request id', () => {
  const err = payloadTooLargeError(42, 5_000_000);
  assert.equal(err.code, 'payload_too_large');
  assert.match(err.message, /42/);
  assert.ok(err.fix, 'a refusal must still name a next step');
});

test('makeOk: success frame shape', () => {
  assert.deepEqual(makeOk(3, { a: 1 }), { id: 3, ok: true, result: { a: 1 } });
});

// ── the fingerprint ────────────────────────────────────────────────────────

test('fingerprint: stable, truncated to 32 hex chars, and URL-sensitive', () => {
  const a = fingerprint('postgresql://one');
  assert.equal(a, fingerprint('postgresql://one'), 'the same URL must always map to the same socket');
  assert.equal(a.length, FINGERPRINT_LENGTH);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, fingerprint('postgresql://two'), 'a different database must get a different socket');
  assert.equal(a, databaseFingerprint('postgresql://one'), 'hash.js and protocol.js agree on one value');
});

test('fingerprint: rejects empty and non-string input rather than hashing it', () => {
  assert.throws(() => fingerprint(''), /non-empty/);
  assert.throws(() => fingerprint(undefined), /string/);
  assert.throws(() => databaseFingerprint(''), /non-empty/);
});

// ── socket layout ──────────────────────────────────────────────────────────

test('paths: the socket is keyed by fingerprint and named .sock', () => {
  const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
  const p = socketPath('postgresql://one', env, '/home/x');
  assert.equal(p, join('/run/user/1000', 'dsh-gbrain', `${fingerprint('postgresql://one')}.sock`));
  assert.equal(ownerPath('postgresql://one', env, '/home/x').endsWith('.owner.json'), true);
});

test('paths: falls back to ~/.dsh/gbrain when XDG_RUNTIME_DIR is unset', () => {
  assert.equal(dshBrainDir({}, '/home/x'), join('/home/x', '.dsh', 'gbrain'));
  assert.equal(dshBrainDir({ XDG_RUNTIME_DIR: '' }, '/home/x'), join('/home/x', '.dsh', 'gbrain'));
  assert.equal(dshBrainDir({ XDG_RUNTIME_DIR: '/run/user/1' }, '/home/x'), join('/run/user/1', 'dsh-gbrain'));
});

test('paths: ensureDir creates 0700 and re-enforces it on every call', () => {
  const base = mkdtempSync(join(tmpdir(), 'dshbrain-'));
  try {
    const dir = join(base, 'nested', 'gbrain');
    ensureDir(dir);
    assert.equal(statSync(dir).mode & 0o777, DIR_MODE);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── the logging contract ───────────────────────────────────────────────────

test('logging: payload values are redacted to their shape, never written', () => {
  const params = {
    slug: 'code/decision-one',
    source_id: 'dsh-gbrain',
    symbol: 'performSync',
    content: 'a secret sentence that must never reach the log',
    nested: { text: 'also secret' },
  };
  const red = redactParams(params);
  assert.equal(red.slug, 'code/decision-one', 'structural args stay readable');
  assert.equal(red.symbol, 'performSync');
  assert.equal(red.source_id, 'dsh-gbrain');
  assert.match(red.content, /^\[redacted \d+B\]$/, 'the payload is replaced by its byte count');
  assert.doesNotMatch(JSON.stringify(red), /secret sentence/);
  assert.doesNotMatch(JSON.stringify(red), /also secret/);
});

test('logging: an array payload keeps its length and drops its contents', () => {
  const red = redactParams({ content: ['a', 'b', 'c'] });
  assert.equal(red.content, '[array len=3]');
});

test('logging: writes JSONL at 0600 and the file really does not hold the payload', () => {
  const base = mkdtempSync(join(tmpdir(), 'dshlog-'));
  try {
    const path = join(base, 'helper-abc.jsonl');
    const log = createLogger(path);
    log.lifecycle('helper_start', { pid: 1 });
    log.request({ op: 'put_page', source: 'dsh-gbrain', outcome: 'ok', duration_ms: 3, params: { slug: 'a', content: 'TOPSECRET' } });
    const raw = readFileSync(path, 'utf8');
    assert.doesNotMatch(raw, /TOPSECRET/);
    assert.match(raw, /"op":"put_page"/);
    assert.match(raw, /"duration_ms":3/);
    for (const line of raw.trim().split('\n')) JSON.parse(line);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('logging: rotates rather than growing without bound', () => {
  assert.equal(MAX_LOG_FILES, 5);
});

test('logging: an UNLISTED text field is redacted — the denylist hole QA found', () => {
  // The original redaction was a denylist of payload keys. `content` was redacted
  // correctly while `title` sailed through into the log, because nobody had listed
  // `title`. This test pins the allowlist inversion: a field nobody anticipated is
  // redacted BY DEFAULT, not by luck.
  const red = redactParams({
    slug: 'qa/dsh-gbrain-smoke',      // structural: kept
    content: 'the payload',           // payload: redacted
    title: 'QA smoke',                // unlisted free text: MUST be redacted
    some_future_field: 'also free text',
    nested: { text: 'deep payload' },
  });
  assert.equal(red.slug, 'qa/dsh-gbrain-smoke', 'an identifier is structural and stays');
  assert.doesNotMatch(JSON.stringify(red), /the payload/);
  assert.doesNotMatch(JSON.stringify(red), /QA smoke/, 'an unlisted field must not leak');
  assert.doesNotMatch(JSON.stringify(red), /also free text/);
  assert.doesNotMatch(JSON.stringify(red), /deep payload/);
  assert.match(red.title, /^\[redacted \d+B\]$/);
});

test('logging: a structural key holding an OBJECT is still recursed', () => {
  // `provenance` and `items` ride under names that look structural but carry free text.
  const red = redactParams({ provenance: { session_id: 'qa', note: 'a free-text note' } });
  assert.doesNotMatch(JSON.stringify(red), /a free-text note/);
});

test('logging: numbers, booleans and null on structural keys survive for diagnosis', () => {
  const red = redactParams({ limit: 3, expand: false, since: null, depth: 2 });
  assert.equal(red.limit, 3);
  assert.equal(red.expand, false);
  assert.equal(red.since, null);
  assert.equal(red.depth, 2);
});
