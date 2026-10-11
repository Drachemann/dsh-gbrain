/**
 * THE TOOL LIST. Single source of truth for the dsh-gbrain surface.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section "The Operation Surface".
 * Exactly fourteen tools. `dsh/scripts/gen-surface.mjs` reads THIS file and writes the
 * manifest (`dsh.plugin.json`), both cordis patch files, and the README's tool table, so
 * the four can never disagree; `gen-surface.mjs --check` fails when they do.
 *
 * Descriptions are prompt-engineered for tool SELECTION, which is why they say when to
 * use a tool and what its absence means — not just what it does. The code-tool
 * descriptions deliberately carry the trusted-lane note, because that is the fact an
 * agent needs if a call is ever refused.
 *
 * Not generated. No banner applies.
 */

/** The six code-graph reads. All six are refused to MCP callers, so this is their only route. */
const CODE_GRAPH_NOTE =
  ' Runs through the trusted local engine, which is the only lane that may read a code graph.';

export const TOOLS = [
  // ── code graph ───────────────────────────────────────────────────────────
  {
    name: 'code_def',
    group: 'code-graph',
    description:
      'Where is symbol Y defined. Returns file, language, symbol type, line range and the code snippet. ' +
      'Use this before editing an unfamiliar function; prefer it over grep when you want the DEFINITION rather than every mention.' +
      CODE_GRAPH_NOTE,
    parameters: {
      symbol: { type: 'string', description: 'Symbol to find definitions of (bare or qualified name).', required: true },
      limit: { type: 'number', description: 'Max definitions returned. Default 20.' },
      lang: { type: 'string', description: 'Filter by content_chunks.language.' },
    },
  },
  {
    name: 'code_refs',
    group: 'code-graph',
    description:
      'Every literal mention of a symbol. Use this before a rename: it finds references a definition or call-graph query misses.' +
      CODE_GRAPH_NOTE,
    parameters: {
      symbol: { type: 'string', description: 'Symbol to find references to.', required: true },
      limit: { type: 'number', description: 'Max references returned. Default 50.' },
      lang: { type: 'string', description: 'Filter by content_chunks.language.' },
    },
  },
  {
    name: 'code_callers',
    group: 'code-graph',
    description:
      'Who calls Y. Use this before you change a function signature, to see what you would break. ' +
      'A count of 0 is a real answer, not a missing one — check the status field before reading it as "no callers".' +
      CODE_GRAPH_NOTE,
    parameters: {
      symbol: { type: 'string', description: 'Symbol to find callers of (bare or qualified name).', required: true },
      limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    },
  },
  {
    name: 'code_callees',
    group: 'code-graph',
    description:
      'What Y calls, and where it reaches a side effect. Use this to trace what a function actually does.' +
      CODE_GRAPH_NOTE,
    parameters: {
      symbol: { type: 'string', description: 'Symbol to find callees of (bare or qualified name).', required: true },
      limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    },
  },
  {
    name: 'code_blast',
    group: 'code-graph',
    description:
      'Recursive blast radius of a symbol: everything reachable through the call graph, grouped by depth with a ' +
      'confidence that decays with distance. Use this to answer "what breaks if I change this". ' +
      'Supports TypeScript, TSX, JavaScript and Python only — an unsupported language says so rather than returning empty.' +
      CODE_GRAPH_NOTE,
    parameters: {
      symbol: { type: 'string', description: 'Seed symbol (bare or qualified name).', required: true },
      depth: { type: 'number', description: 'Max traversal depth, 1-8. Default 5.' },
      max_nodes: { type: 'number', description: 'Node budget, default and max 200. Truncation is reported, never silent.' },
      exact: { type: 'boolean', description: 'Require an exact qualified-name match instead of disambiguating.' },
    },
  },
  {
    name: 'code_flow',
    group: 'code-graph',
    description:
      'Follow control from an entry point downward to its sinks. Use this to answer "how does this get from a request to a write". ' +
      'Same four-language limit as code_blast.' +
      CODE_GRAPH_NOTE,
    parameters: {
      entry_point: { type: 'string', description: 'Entry symbol (bare or qualified name).', required: true },
      depth: { type: 'number', description: 'Max traversal depth, 1-12. Default 8.' },
      max_nodes: { type: 'number', description: 'Node budget, default and max 200.' },
      exact: { type: 'boolean', description: 'Require an exact qualified-name match instead of disambiguating.' },
    },
  },

  // ── code-aware retrieval ─────────────────────────────────────────────────
  {
    name: 'query',
    group: 'retrieval',
    description:
      'Search the brain, code included, with two-pass structural expansion. The superset of a plain text search: ' +
      'it can filter by language and symbol kind, and can anchor on a symbol and walk outward. ' +
      'Use this when you do not know the identifier yet and grep would be guesswork.',
    parameters: {
      query: { type: 'string', description: 'The search text.', required: true },
      limit: { type: 'number', description: 'Max results. Default 10.' },
      lang: { type: 'string', description: 'Filter results by code language.' },
      symbol_kind: { type: 'string', description: 'Filter results by code symbol type (function, class, ...).' },
      near_symbol: { type: 'string', description: 'Anchor the search on this code symbol and expand around it structurally.' },
      walk_depth: { type: 'number', description: 'Expansion depth when near_symbol is set, 1-2.' },
      expand: { type: 'boolean', description: 'Set false to skip LLM query expansion entirely, which makes the call free and keyless.' },
      mode: { type: 'string', description: 'Retrieval mode override for this call.' },
    },
  },

  // ── pages ────────────────────────────────────────────────────────────────
  {
    name: 'get_page',
    group: 'pages',
    description:
      'Read one page by slug. Use it to read a note, a decision record or a code-adjacent document that a search surfaced.',
    parameters: {
      slug: { type: 'string', description: 'Page slug, e.g. "decisions/adopt-postgres".', required: true },
    },
  },
  {
    name: 'put_page',
    group: 'pages',
    description:
      'Write a page. Use it to record a decision, a design note or a finding worth keeping. ' +
      'The destination is chosen by the plugin, not by this call: pass no source. It returns the slug, the source it ' +
      'landed in and whether it created or updated, so a misrouted write is visible rather than silent.',
    parameters: {
      slug: { type: 'string', description: 'Page slug to write.', required: true },
      content: { type: 'string', description: 'Markdown body.', required: true },
      title: { type: 'string', description: 'Page title.' },
      type: { type: 'string', description: 'Page type, e.g. note, decision, concept.' },
    },
  },

  // ── coding memory verbs ──────────────────────────────────────────────────
  {
    name: 'recall',
    group: 'memory',
    description:
      'Recall what the brain already knows about a topic. Use it at the start of a task so you do not re-decide something ' +
      'that was already settled, or re-discover something already written down.',
    parameters: {
      query: { type: 'string', description: 'What to recall. Omit to recall the session default set.' },
      entity: { type: 'string', description: 'Restrict the recall to one entity slug.' },
      limit: { type: 'number', description: 'Max memories. Default 10.' },
    },
  },
  {
    name: 'remember',
    group: 'memory',
    description:
      'Save a durable fact, decision or preference for later sessions. Use it for things that should outlive this conversation, ' +
      'with their provenance. Not for transient task state, credentials or local configuration — none of those belong in memory.',
    parameters: {
      // gbrain's field is `fact`, not `content`, and it is an array of one-claim
      // strings. Declaring `content` made every call fail invalid_params — the QA
      // pass caught it, which is why these are read from the operations contract
      // rather than guessed from the op's name.
      fact: { type: 'array', items: { type: 'string' }, description: 'One or more single-claim facts to remember, each stated so it stands alone.', required: true },
      entity: { type: 'string', description: 'Entity slug this fact belongs to; inferred when omitted.' },
      ttl: { type: 'string', description: 'Optional expiry, e.g. "30d", for a fact that should not outlive its usefulness.' },
      kind: { type: 'string', description: 'Optional claim kind.' },
    },
  },
  {
    name: 'forget',
    group: 'memory',
    description:
      'Withdraw a fact this session or a prior one wrote. Use it when code changed and a remembered statement is now wrong. ' +
      'Withdrawal removes the fact from active memory; it is not a promise of physical erasure.',
    parameters: {
      // gbrain: "expire a remembered fact by its fact_id (never a page slug)".
      id: { type: 'string', description: 'fact_id from remember or recall. This is not a page slug.', required: true },
      reason: { type: 'string', description: 'Audit note for the withdrawal. Default "forgotten".' },
    },
  },
  {
    name: 'context_pack',
    group: 'memory',
    description:
      'A budget-packed bundle of the context most relevant to a task. Use it when you want the brain to decide what matters ' +
      'rather than issuing several searches yourself.',
    parameters: {
      entities: { type: 'array', items: { type: 'string' }, description: 'Entity slugs to pack context for. Omit to pack the session default.' },
      budget_tokens: { type: 'number', description: 'Approximate token budget for the pack.' },
      since: { type: 'string', description: 'Only include context at or after this ISO timestamp.' },
      include_private: { type: 'boolean', description: 'Include private-visibility content.' },
    },
  },
  {
    name: 'delta',
    group: 'memory',
    description:
      'What changed since a marker. Use it at the start of a session to catch up on work done elsewhere, ' +
      'rather than re-reading everything.',
    parameters: {
      since: { type: 'string', description: 'ISO timestamp to report changes from.' },
      cursor: { type: 'string', description: 'Marker from a previous delta call, to continue where it stopped.' },
      entities: { type: 'array', items: { type: 'string' }, description: 'Restrict the delta to these entity slugs.' },
      budget_tokens: { type: 'number', description: 'Approximate token budget for the delta.' },
    },
  },
];

/** The tool names, in declaration order. Derived, never hand-listed. */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** Grouped names, for the README and for review. */
export const TOOL_GROUPS = TOOLS.reduce((acc, t) => {
  (acc[t.group] ??= []).push(t.name);
  return acc;
}, {});

export function assertSurfaceIntegrity() {
  if (TOOLS.length !== 14) throw new Error(`the surface must declare exactly 14 tools, found ${TOOLS.length}`);
  const seen = new Set();
  for (const t of TOOLS) {
    if (seen.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    seen.add(t.name);
    if (!t.description || t.description.length < 40) throw new Error(`tool ${t.name} needs a selection-grade description`);
    for (const [key, param] of Object.entries(t.parameters ?? {})) {
      if (!param.type) throw new Error(`tool ${t.name} param ${key} has no type`);
      if (!param.description) throw new Error(`tool ${t.name} param ${key} has no description`);
    }
  }
  return true;
}

assertSurfaceIntegrity();
