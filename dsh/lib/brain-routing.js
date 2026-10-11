/**
 * The routing and trust contract.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section
 * "Routing and Trust Contract".
 *
 * This module is the one place the guard lives, and the reason it exists at all is
 * worth restating: the helper calls gbrain as a TRUSTED LOCAL CALLER, so gbrain's
 * own `sourceScopeOpts` never runs for these calls. The design says so explicitly —
 * "because we call gbrain as a trusted local caller, that machinery is bypassed by
 * construction, so we reimplement the same guard one layer up in the Host row."
 *
 * Three rules, all from that section:
 *   1. source_id NEVER comes from the model. A tool handler accepts no source_id.
 *   2. The allowed set is {project source, config.memorySourceId} and nothing else.
 *   3. An unresolvable project root is a NAMED ABSENCE (`no_source_for_project`),
 *      never a silent fallback to 'default'.
 *
 * Not generated. No banner applies.
 */

export const ROUTING_CODES = Object.freeze({
  NO_PROJECT_ROOT: 'no_source_for_project',
  NOT_ALLOWED: 'source_not_allowed',
  NO_SOURCE: 'no_source_for_project',
});

/** A routing refusal carries a code and a fix the model can act on. */
export class RoutingError extends Error {
  constructor(code, message, suggestion) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.suggestion = suggestion;
  }

  toJSON() {
    return { code: this.code, message: this.message, suggestion: this.suggestion };
  }
}

/**
 * Read `.gbrain-source` in a project root. This is gbrain's OWN per-repo routing
 * tier (`gbrain sources attach` writes it), reused rather than reinvented.
 * Returns null when absent or blank — an empty file is not a source.
 */
export function readGbSourceFile(content) {
  if (typeof content !== 'string') return null;
  const first = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'));
  return first ?? null;
}

/**
 * Resolve the session's source, in the order the design fixes:
 *   1. the project root's `.gbrain-source`, when it names a source the brain knows
 *   2. otherwise the source registered against that project path
 *   3. otherwise `no_source_for_project`
 *
 * `lookupByPath` is injected so this is testable without a database, and so the
 * single DB call stays in the caller.
 */
export function resolveSessionSource(args) {
  const { projectRoot, gbSourceContent, lookupByPath, knownSources } = args;

  if (!projectRoot) {
    throw new RoutingError(
      ROUTING_CODES.NO_PROJECT_ROOT,
      'this session has no project root, so no source can be resolved',
      'start the session inside a repository, or register one with `gbrain sources add <id> --path <dir>`',
    );
  }

  const pinned = readGbSourceFile(gbSourceContent);
  if (pinned) {
    if (Array.isArray(knownSources) && !knownSources.includes(pinned)) {
      // A pin naming an unknown source is a named failure, not a reason to guess.
      throw new RoutingError(
        ROUTING_CODES.NO_SOURCE,
        `.gbrain-source names "${pinned}", which this brain does not know`,
        `run \`gbrain sources list\` and either add "${pinned}" or repoint the file with \`gbrain sources attach <id>\``,
      );
    }
    return { sourceId: pinned, tier: 'dotfile' };
  }

  const byPath = typeof lookupByPath === 'function' ? lookupByPath(projectRoot) : null;
  if (byPath) return { sourceId: byPath, tier: 'local_path' };

  throw new RoutingError(
    ROUTING_CODES.NO_SOURCE,
    `no source is registered for ${projectRoot}`,
    `run \`gbrain sources add <id> --path ${projectRoot}\` — a missing source is never defaulted to 'default'`,
  );
}

/**
 * ROUTING TIER 2: which source is registered against this project path?
 *
 * This is the tier that was missing, and it is the one a normally-registered project
 * hits — the `.gbrain-source` dotfile is optional, and most checkouts will not have one.
 * Without it every call on an ordinarily-registered repository refused with
 * `no_source_for_project`.
 *
 * The comparison is deliberately strict, because a wrong match here silently reads the
 * wrong corpus — the exact failure class the routing contract exists to prevent. A path
 * PREFIX is NOT a match: `/repo-other` must never match a source rooted at `/repo`.
 * The two accepted shapes are equality after normalisation, and a real containment
 * check on a path SEGMENT boundary, which is what makes a nested checkout resolve to
 * its enclosing source while a sibling with a shared prefix does not.
 *
 * The row field is `id` — verified against a live `sources_list`, whose rows are
 * `{id, name, local_path, remote_url, federated, page_count, last_sync_at}` and carry NO
 * `source_id`. `source_id` is tolerated as an alias rather than relied on; an earlier
 * version of this function had the priority backwards and only matched through the
 * fallback.
 *
 * `realpath` is injected so this stays pure and testable.
 */
export function matchSourceByPath(sources, projectRoot, realpath = (p) => p) {
  if (!projectRoot || !Array.isArray(sources)) return null;
  const canonical = (p) => {
    if (typeof p !== 'string' || p.length === 0) return null;
    const normalised = p.length > 1 ? p.replace(/[/\\]+$/, '') : p;
    try {
      return realpath(normalised);
    } catch {
      // A path that cannot be canonicalised (missing, permission) is not a match; it is
      // not grounds to fall through to a default either.
      return normalised;
    }
  };

  const root = canonical(projectRoot);
  if (!root) return null;

  let best = null;
  for (const source of sources) {
    const local = canonical(source?.local_path ?? source?.localPath);
    if (!local) continue;
    if (local === root) {
      // Exact ownership wins outright.
      return source.id ?? source.source_id ?? null;
    }
    // Containment must land on a separator boundary: '/a/bc' is not inside '/a/b'.
    if (root.startsWith(local + '/') && (best === null || local.length > best.len)) {
      best = { id: source.id ?? source.source_id ?? null, len: local.length };
    }
  }
  return best?.id ?? null;
}

/**
 * A ready-made tier-2 lookup bound to an already-fetched source list. The Host row
 * fetches `sources_list` ONCE per session and hands this in, so routing does not cost a
 * round trip per tool call.
 */
export function sourceLookupFrom(sources, realpath) {
  return (projectRoot) => matchSourceByPath(sources, projectRoot, realpath);
}

/**
 * The allowed set for one session: the project's own source plus the configured
 * memory source, and nothing else. Reading another project's code this way is a
 * data-leak class, which is exactly why gbrain's own scope machinery exists.
 */
export function allowedSources(sessionSourceId, memorySourceId) {
  const set = new Set();
  if (sessionSourceId) set.add(sessionSourceId);
  if (memorySourceId) set.add(memorySourceId);
  return set;
}

/**
 * Guard a source before it reaches the wire. Called on EVERY brain op, including
 * the ones whose source the caller believes is already resolved — a guard that can
 * be skipped is not a guard.
 */
export function assertSourceAllowed(candidate, allowed) {
  if (!candidate) {
    throw new RoutingError(ROUTING_CODES.NO_SOURCE, 'no source was resolved for this call', 'resolve the session source first');
  }
  if (!allowed || !allowed.has(candidate)) {
    const list = allowed ? [...allowed].join(', ') || '(none)' : '(none)';
    throw new RoutingError(
      ROUTING_CODES.NOT_ALLOWED,
      `source "${candidate}" is outside this session's allowed set`,
      `this session may address only: ${list}`,
    );
  }
  return candidate;
}

/**
 * Which source a WRITE goes to. The design's write policy: "Routing is resolved by
 * the Host row, never by the model. A write lands in the session's `memorySourceId`
 * when the plugin config names one, and otherwise in the project's own source. It
 * never lands in a code mirror by accident, which is the MEM-3 failure this
 * replaces."
 */
export function writeTargetFor(sessionSourceId, memorySourceId) {
  return memorySourceId ?? sessionSourceId;
}

/**
 * Provenance stamp for a write, per the design's write policy: "Every write is
 * stamped with the session id, the project path, the plugin version and the tool
 * name, so a misrouted page can be found later."
 */
export function provenanceString(args) {
  const stamp = provenanceStamp(args);
  // gbrain's `provenance` is a STRING, max 500 chars (verified against the
  // operations contract). Passing the structured object made every remember fail
  // provenance_required — the QA pass caught it. The structured form is kept below
  // for the log and the returned routing.
  const parts = [
    stamp.session_id ? `session=${stamp.session_id}` : null,
    stamp.project_path ? `project=${stamp.project_path}` : null,
    stamp.tool ? `tool=${stamp.tool}` : null,
    stamp.plugin_version ? `plugin=${stamp.plugin_version}` : null,
  ].filter(Boolean);
  const text = parts.join(' ') || 'dsh-gbrain';
  return text.length > 500 ? text.slice(0, 500) : text;
}

export function provenanceStamp(args) {
  return {
    session_id: args.sessionId ?? null,
    project_path: args.projectRoot ?? null,
    plugin_version: args.pluginVersion ?? null,
    tool: args.tool ?? null,
    written_at: new Date().toISOString(),
  };
}
