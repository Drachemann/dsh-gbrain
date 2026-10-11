/**
 * Maps a gbrain result or error onto a DSH tool result.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section
 * "How a degraded result reaches the model". The design is explicit that this is
 * NOT a generic error flattener:
 *
 *   "`code` / `why` / `fix.next` are preserved verbatim. `fix.next: "run"` and
 *    `"wait"` render the exact command or delay; `"tell_user_to_run"` and `"ask_user"`
 *    surface as a blocked result with the user-facing message intact, and the tool
 *    result says plainly that it needs the user. gbrain's exit code 3 means 'stop and
 *    ask the user', and a tool result that swallows it would be the most likely first
 *    user-visible failure of this plugin."
 *
 * So the rule this file implements: a refusal is INFORMATION. It reaches the model with
 * its code, its why and its suggested next step, plus a plain statement of whether a
 * human is needed.
 *
 * Not generated. No banner applies.
 */

/** gbrain exit code 3 always means "stop and ask the user". */
export const EXIT_STOP_AND_ASK = 3;

/** The `fix.next` values that mean the model cannot proceed alone. */
const HUMAN_NEXT = new Set(['ask_user', 'tell_user_to_run']);

/**
 * Pull the agent-contract fields off anything thrown. gbrain errors carry them on the
 * instance and in toJSON(); we accept both so a plain Error still yields something
 * useful rather than an empty envelope.
 */
export function describeError(thrown) {
  const e = thrown ?? {};
  let json = {};
  if (typeof e.toJSON === 'function') {
    try {
      json = e.toJSON() ?? {};
    } catch {
      json = {};
    }
  }
  const code = json.code ?? e.canonicalCode ?? e.code ?? 'internal_error';
  const message = json.message ?? e.message ?? String(thrown);
  const why = json.why ?? e.why;
  const suggestion = json.suggestion ?? e.suggestion;
  const fix = json.fix ?? e.fix;
  const notices = json.notices ?? e.notices;
  const reason = json.reason ?? e.reason;
  return { code, message, why, suggestion, fix, notices, reason };
}

/** True when the fix names a human step, or the envelope carries exit code 3. */
export function needsHuman(described) {
  const next = described?.fix?.next;
  if (typeof next === 'string' && HUMAN_NEXT.has(next)) return true;
  if (described?.fix?.exit_code === EXIT_STOP_AND_ASK) return true;
  if (described?.exit_code === EXIT_STOP_AND_ASK) return true;
  return false;
}

/** Render a `fix` into a single line a model can act on. */
export function renderFix(fix) {
  if (!fix || typeof fix !== 'object') return null;
  const parts = [];
  if (typeof fix.next === 'string') parts.push(`next: ${fix.next}`);
  if (typeof fix.command === 'string') parts.push(`run: ${fix.command}`);
  if (Array.isArray(fix.argv) && fix.argv.length) parts.push(`command: ${fix.argv.join(' ')}`);
  if (fix.mcp) parts.push(`mcp: ${JSON.stringify(fix.mcp)}`);
  if (typeof fix.message === 'string') parts.push(fix.message);
  if (typeof fix.wait_ms === 'number') parts.push(`retry after ${fix.wait_ms}ms`);
  if (typeof fix.then === 'string') parts.push(`then: ${fix.then}`);
  return parts.length ? parts.join(' | ') : null;
}

/**
 * Render a healthy gbrain result.
 *
 * The lead line summarises by operation family so a coding turn reads the answer
 * first. The raw value is always appended as JSON: the design requires the model to
 * see BOTH the answer and the machine-readable envelope, and a summary that dropped
 * fields would silently lose `status`/`ready`/`possibly_stale`.
 */
export function renderSuccess(op, value) {
  const lines = [];
  const summary = summarise(op, value);
  if (summary) lines.push(summary);

  // gbrain's readiness vocabulary is surfaced, not re-invented: a miss and an
  // unbuilt graph must not look the same to the model.
  const status = value?.status;
  if (status && status !== 'ready') {
    lines.push(`graph status: ${status}${value?.ready === false ? ' (not ready)' : ''}`);
  }
  if (value?.hint) lines.push(`hint: ${value.hint}`);
  if (value?.possibly_stale) {
    lines.push(`WARNING: possibly stale — the indexed revision differs from the working tree HEAD${value.indexed_at ? ` (indexed_at ${value.indexed_at})` : ''}`);
  }

  lines.push('');
  lines.push(JSON.stringify(value, null, 2));
  return lines.join('\n');
}

/** One-line, family-aware summary. Returns null when there is nothing to add. */
export function summarise(op, value) {
  if (value === null || value === undefined) return null;
  // Defence in depth: a bare array must still produce a lead line.
  if (Array.isArray(value)) return `${op}: ${value.length} row(s)`;

  const countable = [
    ['callers', 'caller'], ['callees', 'callee'], ['defs', 'definition'], ['refs', 'reference'],
  ];
  for (const [field, noun] of countable) {
    if (Array.isArray(value[field])) {
      const n = value[field].length;
      return `${value.symbol ?? op}: ${n} ${noun}${n === 1 ? '' : 's'}${n === 0 ? ' — no match, which is not the same as no callers' : ''}`;
    }
  }

  if (typeof value.result === 'string') {
    if (value.result === 'ok') {
      const nodes = (value.depth_groups ?? []).reduce((t, g) => t + (g.nodes?.length ?? 0), 0);
      return `${op}: reached ${nodes} node(s)${value.truncation && value.truncation !== 'none' ? ` (truncated: ${value.truncation})` : ''}`;
    }
    if (value.result === 'not_found') {
      const alts = (value.did_you_mean ?? []).map((d) => d.symbol_qualified ?? d).slice(0, 5);
      return `${op}: symbol not found${alts.length ? ` — did you mean: ${alts.join(', ')}` : ''}`;
    }
    if (value.result === 'ambiguous') {
      const cands = (value.candidates ?? []).map((c) => c.symbol_qualified ?? c).slice(0, 5);
      return `${op}: ambiguous, ${cands.length} candidates — ${cands.join(', ')}`;
    }
    if (value.result === 'unsupported_language') {
      const supported = value.supported ?? [];
      return `${op}: recursion does not support this language yet (supports: ${supported.join(', ')})`;
    }
  }

  // `query` returns rows (src/core/ops/search.ts), not "results". The QA pass showed
  // a blank lead line because none of these matched the real field name.
  if (Array.isArray(value.rows)) return `${op}: ${value.rows.length} row(s)`;
  if (Array.isArray(value.results)) return `${op}: ${value.results.length} result(s)`;
  if (Array.isArray(value.facts)) return `${op}: ${value.facts.length} fact(s)`;
  if (Array.isArray(value.memories)) return `${op}: ${value.memories.length} memory(ies)`;
  if (Array.isArray(value.items)) return `${op}: ${value.items.length} item(s)`;

  // The memory verbs' real success shapes.
  if (typeof value.fact_id === 'string') return `${op}: recorded as ${value.fact_id}`;
  if (value.forgotten !== undefined || value.expired !== undefined) {
    return `${op}: ${value.forgotten ?? value.expired ? 'withdrawn' : 'nothing to withdraw'}`;
  }
  if (value.pack !== undefined || value.context !== undefined) {
    const text = value.pack ?? value.context;
    const n = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : Array.isArray(text) ? text.length : 0;
    return `${op}: packed ${n} unit(s)`;
  }
  if (value.written || value.slug) return `${op}: ${value.written ? 'wrote' : 'read'} ${value.slug ?? ''}${value.source_id ? ` into ${value.source_id}` : ''}`.trim();
  return null;
}

/**
 * Render a refusal. This is the path the design spends the most words on, because a
 * swallowed refusal is the most likely first user-visible failure.
 */
export function renderError(described) {
  const lines = [`${described.code}: ${described.message}`];
  if (described.why) lines.push(`why: ${described.why}`);
  if (described.reason) lines.push(`reason: ${described.reason}`);
  if (described.suggestion) lines.push(`suggested next step: ${described.suggestion}`);

  const fix = renderFix(described.fix);
  if (fix) lines.push(`fix: ${fix}`);

  if (needsHuman(described)) {
    // Stated plainly, and never as a soft hint: the model must surface this to the
    // person rather than retrying or working around it.
    lines.push('');
    lines.push('THIS NEEDS THE USER. Do not retry it or work around it: report the message above to the user and wait.');
  }

  if (Array.isArray(described.notices) && described.notices.length) {
    // gbrain's own rule: a degraded result is not proof of "no notes".
    lines.push('');
    for (const n of described.notices) lines.push(`notice: ${typeof n === 'string' ? n : JSON.stringify(n)}`);
  }
  return lines.join('\n');
}

/** Build the DSH content-block array for a successful tool call. */
export function toContentBlocks(op, value) {
  return [{ type: 'text', text: renderSuccess(op, value) }];
}

/** Build the DSH content-block array for a failed tool call. */
export function toErrorBlocks(thrown) {
  const described = describeError(thrown);
  return [{ type: 'text', text: renderError(described) }];
}

/**
 * The full projection used by a tool's `render`. Returns blocks plus a machine-readable
 * status so a caller can distinguish a refusal from a result without parsing text.
 */
export function project(op, outcome) {
  if (outcome?.ok === false) {
    const described = describeError(outcome.error);
    return {
      blocks: [{ type: 'text', text: renderError(described) }],
      status: needsHuman(described) ? 'needs_user' : 'error',
      code: described.code,
    };
  }
  return { blocks: toContentBlocks(op, outcome?.value), status: 'ok', code: null };
}
