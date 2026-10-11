/**
 * The database fingerprint, and nothing else.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section
 * "Routing and Trust Contract" > "Who may reach the socket".
 *
 * The design specifies: "The socket is keyed by a fingerprint of the `database_url`
 * (a truncated SHA-256), so a second profile pointing at a different database gets
 * its own helper rather than silently querying the first profile's brain."
 *
 * This module is deliberately tiny and dependency-free so it can be tested in
 * isolation, and so the verifier's hash contract test has exactly one thing to pin.
 * The implementation lives in protocol.js because the hello message must carry the
 * same value; this file is the named surface for it.
 *
 * Not generated. No banner applies.
 */

export { databaseFingerprint, PROTOCOL_VERSION, HELPER_BUILD } from './protocol.js';

import { createHash } from 'node:crypto';

/** Hex length of the fingerprint. Truncated SHA-256, 128 bits. */
export const FINGERPRINT_LENGTH = 32;

/**
 * Stable fingerprint for a connection string.
 *
 * Stability is the point: the same URL must always map to the same socket, across
 * processes and across restarts, or a second session would start a duplicate helper
 * and two engines would write the same brain.
 */
export function fingerprint(databaseUrl) {
  if (typeof databaseUrl !== 'string') throw new TypeError('fingerprint requires a string');
  if (databaseUrl.length === 0) throw new TypeError('fingerprint requires a non-empty connection string');
  return createHash('sha256').update(databaseUrl, 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH);
}
