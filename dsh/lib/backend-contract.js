/**
 * The backend contract: the narrow, versioned surface the dsh-memory-evolve fork
 * consumes, and the ONLY thing about this plugin that exists for a consumer which
 * does not exist yet.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section "The Backend Contract".
 * That section descopes this file deliberately, and the descope is a decision rather
 * than an omission — review was right that an interface cannot be designed against a
 * consumer that has not stated what it needs. What ships is a versioned stub with a
 * stated first negotiation, not a designed interface.
 *
 * The two facts that ARE settled and are therefore load-bearing here:
 *
 *   1. "Write ownership is stated, not delegated: the caller owns what it writes; the
 *      backend never synthesises content on the caller's behalf."
 *   2. The full request/response shapes get designed in the session that builds the
 *      consumer, against a real consumer. This file does not pretend to know them.
 *
 * Not generated. No banner applies.
 */

/**
 * Bump ONLY when the negotiation changes shape. The version is present from the first
 * commit because its consumer will pin against it.
 */
export const BACKEND_VERSION = 1;

/**
 * The operations a consumer may reach through this backend. Deliberately the coding
 * memory verbs plus the page pair — the same set the fourteen tools expose — because a
 * second consumer reaching MORE than the plugin's own surface would mean the tool
 * surface was the narrow one for no reason.
 */
export const BACKEND_OPERATIONS = Object.freeze([
  'recall',
  'remember',
  'forget',
  'context_pack',
  'delta',
  'get_page',
  'put_page',
]);

/** Operations that mutate the brain, and therefore need routing and provenance. */
export const BACKEND_WRITES = Object.freeze(['remember', 'forget', 'put_page']);

/** A refusal names what is unavailable rather than returning undefined. */
export const UNKNOWN_OPERATION = 'backend_unknown_operation';

/**
 * The first negotiation, and the whole of the designed interface for now.
 *
 * `wants` is the consumer's list of desired operations. The result states what it may
 * have, what is a write, and who owns a write. An operation nobody claimed is refused BY
 * NAME — the design's posture throughout is a named absence, never a silent default.
 */
export async function negotiate({ wants } = {}) {
  const requested = Array.isArray(wants) ? wants : [...BACKEND_OPERATIONS];
  const unknown = requested.filter((op) => !BACKEND_OPERATIONS.includes(op));
  const granted = requested.filter((op) => BACKEND_OPERATIONS.includes(op));

  if (unknown.length > 0) {
    const error = new Error(`unsupported backend operation(s): ${unknown.join(', ')}`);
    error.code = UNKNOWN_OPERATION;
    error.suggestion = `available: ${BACKEND_OPERATIONS.join(', ')}`;
    error.why = 'the backend grants only the operations this plugin itself exposes';
    return { ok: false, error: { code: error.code, message: error.message, suggestion: error.suggestion, why: error.why } };
  }

  return {
    ok: true,
    version: BACKEND_VERSION,
    operations: granted,
    writes: granted.filter((op) => BACKEND_WRITES.includes(op)),
    // Stated, not delegated. A backend that synthesised content on the caller's behalf
    // would be a second author of the caller's memory.
    writeOwnership: 'caller',
    // The consumer supplies routing by naming a source id it is allowed to address;
    // the backend resolves and checks it against the same allowed set the tools use.
    routing: 'caller-names-source-host-enforces',
  };
}

/**
 * Validate a negotiated capability object. A consumer holding a session that negotiated
 * once may re-check that an operation is still granted before calling it, rather than
 * discovering a refusal mid-write.
 */
export function assertGranted(negotiated, op) {
  if (!negotiated?.ok) {
    const e = new Error('backend was not successfully negotiated');
    e.code = 'backend_not_negotiated';
    throw e;
  }
  if (!negotiated.operations.includes(op)) {
    const e = new Error(`operation "${op}" was not granted`);
    e.code = UNKNOWN_OPERATION;
    e.suggestion = `granted: ${negotiated.operations.join(', ')}`;
    throw e;
  }
  return true;
}
