/**
 * The logging contract.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section "Logging".
 *
 * The clause that carries the most weight, verbatim from the design:
 *
 *   "**Payloads are never logged.** Request parameters and results are redacted to
 *    their shape: a `put_page` or `remember` call logs the slug and the byte count,
 *    never the content."
 *
 * and:
 *
 *   "`~/.dsh/gbrain/logs/helper-<fingerprint>.jsonl`, mode `0600` in a `0700`
 *    directory, one JSON object per line, ring-rotated at 5 files of 5 MiB. Levels:
 *    `error` always, `warn` always, `info` for lifecycle and every request's op,
 *    source, outcome and duration."
 *
 * Success Criterion 1 (traceability) reads this file, so the shape of a record is
 * part of the contract, not an implementation detail.
 *
 * Not generated. No banner applies.
 */

import { appendFileSync, existsSync, renameSync, statSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './paths.js';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_FILES = 5;
export const LOG_FILE_MODE = 0o600;

const LEVELS = { error: 0, warn: 1, info: 2 };

/**
 * ALLOWLIST, not denylist.
 *
 * This started as a list of payload keys to redact, and the QA pass proved the flaw:
 * `content` was redacted correctly while `title` sailed through, because nobody had
 * listed `title`. A denylist of payload keys can only ever be as complete as the day
 * it was written, and gbrain's shapes are not ours to freeze.
 *
 * So the rule is inverted: a small set of STRUCTURAL fields is logged as-is, and
 * EVERYTHING else is replaced by its shape (byte count, array length, type). A new
 * field gbrain adds tomorrow is redacted by default rather than by luck.
 *
 * The design's requirement is the guide: "Request parameters and results are redacted
 * to their shape: a put_page or remember call logs the slug and the byte count, never
 * the content." The fields below are exactly that kind of identifier.
 */
const STRUCTURAL_KEYS = new Set([
  // identifiers and selectors
  'slug', 'symbol', 'entry_point', 'id', 'fact_id', 'source_id', 'sourceid', 'entity',
  'entities', 'near_symbol', 'cursor', 'since', 'until', 'lang', 'language',
  // shapes and budgets
  'limit', 'offset', 'depth', 'max_nodes', 'budget_tokens', 'snippet_chars', 'walk_depth',
  'token_budget', 'return_unit', 'return_window', 'ttl', 'kind', 'type', 'mode',
  // flags
  'exact', 'expand', 'force', 'all_sources', 'include_private', 'include_expired',
  'include_pending', 'include_deleted', 'fuzzy', 'no_expand', 'detail', 'cross_modal',
  // structural counters we emit ourselves
  'count', 'rows', 'indexed_at', 'possibly_stale',
]);

/**
 * Replace a value with its SHAPE. Length and type survive; the bytes do not.
 */
export function redactValue(value, depth = 0) {
  if (depth > 8) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return `[redacted ${Buffer.byteLength(value, 'utf8')}B]`;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return `[array len=${value.length}]`;
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maybeRedact(k, v, depth + 1);
    return out;
  }
  return typeof value;
}

/**
 * A structural key keeps its value when that value is a primitive. A structural key
 * holding an OBJECT is still recursed, because `provenance` and `items` ride under
 * names that look structural but carry free text.
 */
function maybeRedact(key, value, depth) {
  const k = String(key).toLowerCase();
  const isStructural = STRUCTURAL_KEYS.has(k) || STRUCTURAL_KEYS.has(String(key));
  if (isStructural && (value === null || typeof value !== 'object')) return value;
  return redactValue(value, depth);
}

/**
 * Redact a request's params for the log, by the allowlist above.
 */
export function redactParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k] = maybeRedact(k, v, 1);
  return out;
}

function rotate(path) {
  // Ring of MAX_LOG_FILES: the oldest suffix is dropped, each file shifts up, and
  // the live file becomes .1
  rmSync(`${path}.${MAX_LOG_FILES - 1}`, { force: true });
  for (let i = MAX_LOG_FILES - 2; i >= 1; i--) {
    const from = `${path}.${i}`;
    if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
  }
  if (existsSync(path)) renameSync(path, `${path}.1`);
}

export function createLogger(path, opts = {}) {
  const threshold = LEVELS[opts.level ?? 'info'] ?? LEVELS.info;
  ensureDir(dirname(path));

  const write = (record) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    try {
      if (existsSync(path) && statSync(path).size + Buffer.byteLength(line, 'utf8') > MAX_LOG_BYTES) {
        rotate(path);
      }
      appendFileSync(path, line, { mode: LOG_FILE_MODE });
    } catch {
      // Logging must never take down a request. A failed write is dropped and the
      // request's own result is unaffected — that ordering is deliberate.
    }
  };

  return {
    path,
    error: (event, fields = {}) => write({ level: 'error', event, ...fields }),
    warn: (event, fields = {}) => { if (threshold >= LEVELS.warn) write({ level: 'warn', event, ...fields }); },
    info: (event, fields = {}) => { if (threshold >= LEVELS.info) write({ level: 'info', event, ...fields }); },
    /** Lifecycle: start, hello, stop, restart, version-skew. */
    lifecycle: (event, fields = {}) => { if (threshold >= LEVELS.info) write({ level: 'info', kind: 'lifecycle', event, ...fields }); },
    /**
     * One record per request: op, source, outcome, duration, and the REDACTED params.
     * This is the record Success Criterion 1 traces.
     */
    request: (fields) => {
      const { params, ...rest } = fields;
      const record = { level: 'info', kind: 'request', event: 'request', ...rest };
      if (params !== undefined) record.params = redactParams(params);
      write(record);
    },
  };
}
