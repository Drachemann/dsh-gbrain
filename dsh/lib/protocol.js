/**
 * THE WIRE CONTRACT for the dsh-gbrain helper socket.
 *
 * This file is written before any tool, and BOTH sides import it: the Bun helper
 * that owns the engine connection, and the Host-row client that talks to it.
 * A clause that is not implemented in here is not part of the contract.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section "The Wire Contract".
 * Every clause below cites the sentence it implements so a divergence is visible.
 *
 * Not generated. No banner applies.
 */

import { createHash } from 'node:crypto';

/** Wire-protocol version. Fatal on mismatch — never negotiated. */
export const PROTOCOL_VERSION = 1;

/**
 * Bumped whenever the helper's BEHAVIOUR changes. A monotonic integer rather than
 * a semver, because this fork's versions are 0.x and a semantic version could
 * never produce a detectable mismatch against a stale helper.
 */
export const HELPER_BUILD = 1;

/** The only two ops that may carry a null source_id. */
export const CONTROL_OPS = Object.freeze(['probe', 'shutdown']);

/**
 * Registry reads: brain ops that must run BEFORE a source can be resolved.
 *
 * `sources_list` is why this category exists — it is the query that IMPLEMENTS routing
 * tier 2 ("the source registered against that project path"), so it cannot itself
 * require a source_id without being circular. Naming it as its own category rather than
 * quietly letting a null through is the difference between a designed exception and a
 * hole in the guard.
 */
export const SOURCE_FREE_OPS = Object.freeze(['sources_list']);

/** True for any op permitted to omit source_id. */
export function isSourceFree(op) {
  return CONTROL_OPS.includes(op) || SOURCE_FREE_OPS.includes(op);
}

/**
 * Ops that mutate the brain. The helper serialises these through a single queue,
 * so two put_page calls for one slug cannot interleave.
 */
export const WRITE_OPS = Object.freeze(['put_page', 'remember', 'forget']);

/** Per-op deadline defaults, in milliseconds. Relative, measured from receipt. */
export const READ_DEADLINE_MS = 15_000;
export const WRITE_DEADLINE_MS = 120_000;
export const WALK_DEADLINE_MS = 180_000;

/** The two ops allowed the longer walk deadline, because they traverse a graph. */
export const WALK_OPS = Object.freeze(['code_blast', 'code_flow']);

/** 1 MiB, applied to the encoded line in both directions. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** Terminal sentinel the helper writes first line. */
export const HELLO_MARKER = 'gbrain-helper';

/**
 * Database fingerprint: a truncated SHA-256 of the database_url.
 *
 * This is what keys the socket path, so a second profile pointing at a DIFFERENT
 * database gets its own helper instead of silently querying the first profile's
 * brain. It is also carried in the hello, so a client can refuse a helper that is
 * serving the wrong database.
 */
export function databaseFingerprint(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw new TypeError('databaseFingerprint requires a non-empty connection string');
  }
  return createHash('sha256').update(databaseUrl).digest('hex').slice(0, 32);
}

/** The default relative deadline for an op. */
export function deadlineFor(op) {
  if (WALK_OPS.includes(op)) return WALK_DEADLINE_MS;
  if (WRITE_OPS.includes(op)) return WRITE_DEADLINE_MS;
  return READ_DEADLINE_MS;
}

/** True for the ops permitted to omit source_id. */
export function isControlOp(op) {
  return CONTROL_OPS.includes(op);
}

/** True for the ops the helper must serialise. */
export function isWriteOp(op) {
  return WRITE_OPS.includes(op);
}

/** One NDJSON frame: exactly one object, terminated by a newline. */
export function encodeFrame(obj) {
  return JSON.stringify(obj) + '\n';
}

/**
 * Byte length of a frame goes on the wire. Measured on the ENCODED line,
 * because that is what the limit applies to.
 */
export function frameBytes(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

/**
 * The bounded, size-bounded refusal the helper substitutes for a result it cannot
 * deliver. It carries the id of the request it replaces, so the client resolves
 * the right promise rather than timing out.
 *
 * The design requires this to be bounded: a refusal that could itself exceed the
 * limit would be undeliverable, so the message is truncated by contract.
 */
export function payloadTooLargeError(id, observedBytes) {
  return {
    code: 'payload_too_large',
    message: `response for request ${id} exceeded the ${MAX_LINE_BYTES} byte frame limit`,
    why: `the helper serialised ${observedBytes} bytes; it does not stream, and it will not buffer beyond the limit`,
    fix: {
      next: 'run',
      message: 'narrow the request: lower limit/max_nodes/depth, or scope it with source_id',
    },
  };
}

/**
 * The error envelope. gbrain's own code/why/fix shape, passed through, never flattened.
 *
 * `suggestion` and `notices` are carried because gbrain's agent contract puts the
 * agent's next step there, and the design requires the envelope to survive the
 * adapter: a degraded result is not proof of "no notes".
 */
/**
 * @typedef {object} WireError
 * @property {string} code
 * @property {string} message
 * @property {string} suggestion
 * @property {string} why
 * @property {string} reason
 * @property {string} detail
 * @property {Record<string, unknown>} fix
 * @property {unknown} notices
 */

/** The first line the helper writes on connect. */
/**
 * @typedef {object} Hello
 * @property {number} v
 * @property {typeof HELLO_MARKER} hello
 * @property {number} build
 * @property {number | null} schema
 * @property {string} db
 */

export function makeHello(args) {
  return { v: PROTOCOL_VERSION, hello: HELLO_MARKER, build: HELPER_BUILD, schema: args.schema, db: args.db };
}

/**
 * Fatal comparison, stated positively: the client sends requests only when v,
 * build and db all match. A mismatch of any of the three is fatal to the session,
 * not negotiated — the client stops the helper by pid and starts a fresh one.
 */
export function helloMismatch(hello, local) {
  if (!hello || hello.hello !== HELLO_MARKER) return { ok: false, reason: 'not_a_helper' };
  if (hello.v !== PROTOCOL_VERSION) return { ok: false, reason: `wire_version_${hello.v}_expected_${PROTOCOL_VERSION}` };
  if (hello.build !== HELPER_BUILD) return { ok: false, reason: `build_${hello.build}_expected_${HELPER_BUILD}` };
  if (hello.db !== local.db) return { ok: false, reason: 'database_fingerprint_mismatch' };
  return { ok: true };
}

/**
 * @typedef {object} WireRequest
 * @property {number} id
 * @property {string} op
 * @property {Record<string, unknown>} params
 * @property {string | null} source_id
 * @property {number} deadline_ms
 */

export function makeRequest(args) {
  const control = isControlOp(args.op);
  const sourceFree = isSourceFree(args.op);
  if (!sourceFree && (args.sourceId === undefined || args.sourceId === null || args.sourceId === '')) {
    // Fail here rather than at the helper: a missing source is a caller bug, and
    // the design's posture is a named absence, never a silent default.
    throw new TypeError(
      `op "${args.op}" requires a source_id (only ${[...CONTROL_OPS, ...SOURCE_FREE_OPS].join('/')} may omit it)`,
    );
  }
  if (control && args.sourceId) {
    throw new TypeError(`control op "${args.op}" must not carry a source_id`);
  }
  return {
    id: args.id,
    op: args.op,
    params: args.params ?? {},
    source_id: sourceFree ? null : (args.sourceId ?? null),
    deadline_ms: args.deadlineMs ?? deadlineFor(args.op),
  };
}

/** Validate an inbound request line. Returns a wire error instead of throwing. */
export function validateRequest(raw) {
  const bad = (message, why) => ({
    ok: false,
    error: { code: 'invalid_params', message, why, fix: { next: 'run', message: 'send {id, op, params, source_id, deadline_ms}' } },
  });
  if (!raw || typeof raw !== 'object') return bad('request is not an object', 'the frame did not decode to an object');
  const r = raw;
  if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 0) return bad('request.id must be a non-negative integer', 'id is echoed on the response and resolves the caller promise');
  if (typeof r.op !== 'string' || r.op.length === 0) return bad('request.op must be a non-empty string', 'op names the operation to run');
  const control = isControlOp(r.op);
  if (control && r.source_id != null) return bad(`control op "${r.op}" must not carry a source_id`, 'control ops do not touch the brain');
  if (!isSourceFree(r.op) && (typeof r.source_id !== 'string' || r.source_id.length === 0)) {
    return bad(`op "${r.op}" requires a source_id`, `only ${[...CONTROL_OPS, ...SOURCE_FREE_OPS].join('/')} may omit it; a missing source is never defaulted`);
  }
  if (typeof r.deadline_ms !== 'number' || !Number.isFinite(r.deadline_ms) || r.deadline_ms <= 0) {
    return bad('request.deadline_ms must be a positive number', 'the deadline is relative and measured from the helper\'s receipt');
  }
  if (r.params !== undefined && (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params))) {
    return bad('request.params must be an object', 'params are passed through to the operation');
  }
  return {
    ok: true,
    request: { id: r.id, op: r.op, params: r.params ?? {}, source_id: isSourceFree(r.op) ? null : r.source_id, deadline_ms: r.deadline_ms },
  };
}

/** A success frame. */
export function makeOk(id, result) {
  return { id, ok: true, result };
}

/** A failure frame. */
export function makeErr(id, error) {
  return { id, ok: false, error };
}

/**
 * Turn a thrown gbrain operation error into the wire envelope WITHOUT flattening
 * it. gbrain errors carry problem/why/fix; the design requires all three to
 * survive so the model still sees the fix, and so exit-3 "stop and ask the user"
 * reaches the session instead of being swallowed.
 */
export function toWireError(thrown) {
  /** @type {any} */
  const e = thrown;
  let code = e?.canonicalCode ?? e?.code ?? 'internal_error';
  let message = e?.message ?? String(thrown);
  let suggestion = e?.suggestion;
  let why = e?.why;
  let fix = e?.fix;
  let reason = e?.reason;
  let notices = e?.notices;
  let detail = e?.detail;

  // gbrain's own toJSON() is the authoritative envelope (code/why/fix/suggestion).
  // Prefer it, so a refusal reaches the model with its suggested next step intact
  // rather than flattened into a generic error.
  if (typeof e?.toJSON === 'function') {
    try {
      const j = e.toJSON();
      code = (j.code) ?? code;
      message = (j.message) ?? message;
      suggestion = (j.suggestion) ?? suggestion;
      why = (j.why) ?? why;
      fix = j.fix ?? fix;
      reason = (j.reason) ?? reason;
      notices = j.notices ?? notices;
      detail = (j.detail) ?? detail;
    } catch {
      // A toJSON that throws must not hide the original error.
    }
  }

  const out = { code, message };
  if (suggestion !== undefined) out.suggestion = suggestion;
  if (why !== undefined) out.why = why;
  if (reason !== undefined) out.reason = reason;
  if (detail !== undefined) out.detail = detail;
  if (fix !== undefined) out.fix = fix;
  // `notices` matters to the agent contract: a degraded result is not proof of
  // "no notes", so they ride the wire rather than being dropped.
  if (notices !== undefined) out.notices = notices;
  return out;
}

/** Split a byte stream into complete NDJSON lines, returning the remainder. */
export function splitFrames(buffer) {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { frames: parts.filter((p) => p.length > 0), rest };
}
