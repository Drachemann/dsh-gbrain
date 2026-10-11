/**
 * The dsh-gbrain Host plugin entry. RUNS UNDER NODE, inside DSH.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, sections "The Chosen Shape",
 * "Routing and Trust Contract" and "The Operation Surface".
 *
 * This file does two things and deliberately not a third:
 *
 *   1. It supervises the resident Bun helper and publishes `gbrainBrain` — the
 *      request surface — and `gbrainBackend` — the narrow contract the
 *      dsh-memory-evolve fork will consume.
 *   2. It registers NO service that decides anything about a conversation. Nothing
 *      here reroutes a model call, holds a hook, or inspects an unrelated tool.
 *
 * The third thing it deliberately does not do: register a TOOL. The fourteen tools
 * live in the preset row, because a session's affordances belong to the preset that
 * session runs. A tool registered here would appear in every mode whether or not that
 * mode wants it. This mirrors dsh-wyrmbrain's host row, whose comment says the same.
 *
 * Not generated. No banner applies.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrainClient, resolveDatabaseUrl, notConfiguredError } from './brain-client.js';
import {
  resolveSessionSource, allowedSources, assertSourceAllowed, writeTargetFor,
  provenanceStamp, provenanceString, sourceLookupFrom, RoutingError, ROUTING_CODES,
} from './brain-routing.js';
import { describeError, needsHuman, renderError, renderSuccess } from './result.js';
import { BACKEND_VERSION, negotiate } from './backend-contract.js';

const here = dirname(fileURLToPath(import.meta.url));
export const name = 'dsh-gbrain';
export const inject = ['tools'];

/** The services this row publishes. Named once so the patch, manifest and README agree. */
export const SERVICES = Object.freeze({
  brain: 'gbrainBrain',
  backend: 'gbrainBackend',
});

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Resolve the calling session's project root.
 *
 * The design is emphatic about this: the harness process cwd is `~/.dsh`, NOT the
 * session project, so cwd is wrong by default and using it would resolve both routing
 * tiers against the wrong directory — failing in a way that looks like an empty brain
 * rather than a bug.
 *
 * The root arrives as an ARGUMENT, from the tool execution context
 * (`exec.agent.session.header.cwd`, read in `tools-exec.js`). It is deliberately NOT
 * read off `ctx`, for two reasons that are both fatal:
 *
 *   1. There is no Cordis service named `session` in DSH 0.2.0-rc.2. Reading
 *      `ctx.session` as a plain property throws Cordis's own
 *      `cannot get property "session" without inject` — which is exactly how this row
 *      shipped broken, with all fourteen tools dead and the failure naming no row.
 *   2. The root is a property of the CALL, not of the plugin. `apply()` runs once per
 *      process while `routingFor()` runs once per request, so a root captured at apply
 *      time could never be the caller's project.
 *
 * `config.projectRoot` remains the explicit override for a deployment that pins one.
 */
function resolveProjectRoot(callerRoot, config) {
  if (typeof callerRoot === 'string' && callerRoot.length > 0) return callerRoot;
  if (typeof config?.projectRoot === 'string' && config.projectRoot.length > 0) return config.projectRoot;
  // null, never undefined: routing distinguishes "no project is known" from "no project
  // is set", and `resolveSessionSource` only refuses on the former. Returning undefined
  // let it slip past the guard into the registry load, which dials. Callers that pass no
  // session (and the backend contract's callers) must land on the refusal.
  return null;
}

/** Read `.gbrain-source` from a project root, tolerating absence. */
function readGbSource(projectRoot) {
  if (!projectRoot) return null;
  const p = join(projectRoot, '.gbrain-source');
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function apply(ctx, config = {}) {
  const version = readPackageVersion();
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    try { ctx?.logger?.warn?.(`[dsh-gbrain] ${msg}`); } catch { /* logger is best-effort */ }
  };

  // Resolve the connection string. Per the design: config first, then the environment,
  // and an unset value is a NAMED absence rather than an activation failure — a
  // brain-less profile must still be usable.
  const resolved = resolveDatabaseUrl(config, process.env);
  let client = null;
  let degradedReason = null;

  if (resolved.url) {
    client = new BrainClient({
      databaseUrl: resolved.url,
      helperEntry: config.helperEntry ?? join(here, 'engine-host.js'),
      bunPath: config.bunPath ?? 'bun',
      onWarn: warn,
    });
  } else {
    degradedReason = notConfiguredError(config);
    warn(`no brain configured (${resolved.from}); brain calls will report brain_not_configured`);
  }

  /**
   * The source registry, fetched ONCE per session and cached.
   *
   * Routing tier 2 asks "which source is registered against this project path?", and the
   * answer lives in the brain. Fetching it per tool call would put a round trip in front of
   * every read; caching it for the session costs one. It is also the reason `sources_list`
   * is a source-free operation — it is what implements routing, so it cannot require a
   * source to be already resolved.
   */
  let registryPromise = null;
  let registryCache = null;
  async function loadRegistry() {
    if (registryCache) return registryCache;
    if (registryPromise) return registryPromise;
    registryPromise = (async () => {
      if (!client) return [];
      try {
        const out = await client.request('sources_list', {}, { deadlineMs: 10_000 });
        registryCache = Array.isArray(out?.sources) ? out.sources : [];
        return registryCache;
      } catch (e) {
        // A registry we cannot read is not a licence to guess a source. Routing refuses.
        warn(`could not read the source registry: ${e?.code ?? e?.message ?? e}`);
        registryPromise = null;
        return [];
      }
    })();
    return registryPromise;
  }

  /**
   * Resolve routing for one call. Never accepts a source from the model.
   *
   * Async because tier 2 reads the registry. The guard is unchanged: tier 3 is still a
   * named absence, never a silent fallback to 'default'.
   */
  async function routingFor(session = {}) {
    const projectRoot = resolveProjectRoot(session.projectRoot, config);

    // The guard comes FIRST, and it must stay first. `resolveSessionSource` refuses a
    // null root before it looks at any tier, so loading the registry here would be a
    // network dial whose answer the refusal never reads — and a session with no project
    // would wait on the helper to be refused. A refusal that dials first is not a guard.
    //
    // The call is kept for its THROW, and a return is rejected rather than used. Using a
    // source it returned would reintroduce the exact failure the route forbids:
    // resolving a source for a session that has no project. If a future edit to
    // `resolveSessionSource` ever returns a default instead of refusing, this row must
    // fail loudly rather than silently query another project's code.
    if (!projectRoot) {
      resolveSessionSource({
        projectRoot,
        gbSourceContent: null,
        lookupByPath: null,
        knownSources: config.knownSources,
      });
      throw new RoutingError(
        ROUTING_CODES.NO_PROJECT_ROOT,
        'this session has no project root, so no source can be resolved',
        'start the session inside a repository, or register one with `gbrain sources add <id> --path <dir>`',
      );
    }

    let lookupByPath = config.lookupSourceByPath;
    if (typeof lookupByPath !== 'function') {
      const sources = await loadRegistry();
      lookupByPath = sourceLookupFrom(sources);
    }
    const { sourceId } = resolveSessionSource({
      projectRoot,
      gbSourceContent: readGbSource(projectRoot),
      lookupByPath,
      knownSources: config.knownSources,
    });
    const allowed = allowedSources(sourceId, config.memorySourceId);
    return { projectRoot, sourceId, allowed };
  }

  /**
   * The published service. Every method resolves routing itself and refuses anything
   * outside the session's allowed set BEFORE it reaches the wire — a guard that can be
   * skipped is not a guard.
   */
  const brain = {
    get available() {
      return Boolean(client) && !client.degraded;
    },
    get degraded() {
      return degradedReason ?? client?.degraded ?? null;
    },
    warnings: () => [...warnings],

    /** Read-only request. `session` is the calling session's context, from the tool exec. */
    async request(op, params = {}, session = {}) {
      if (!client) throw degradedReason ?? notConfiguredError(config);
      const { sourceId, allowed, projectRoot } = await routingFor(session);
      const target = params?.targetSource ?? writeTargetFor(sourceId, config.memorySourceId);
      assertSourceAllowed(op === 'get_page' || op === 'put_page' ? target : sourceId, allowed);
      const result = await client.request(op, params, { sourceId: target });
      return { result, sourceId: target, projectRoot };
    },

    /** Write request, stamped with provenance per the write policy. */
    async write(op, params = {}, session = {}) {
      if (!client) throw degradedReason ?? notConfiguredError(config);
      const { sourceId, allowed, projectRoot } = await routingFor(session);
      const target = writeTargetFor(sourceId, config.memorySourceId);
      assertSourceAllowed(target, allowed);
      const stamp = provenanceStamp({
        sessionId: session.sessionId ?? null,
        projectRoot,
        pluginVersion: version,
        tool: op,
      });
      const stamped = {
        ...params,
        // A caller-supplied provenance wins; otherwise the string form gbrain requires.
        provenance: typeof params?.provenance === 'string' && params.provenance.length > 0
          ? params.provenance
          : provenanceString(stamp),
      };
      const result = await client.request(op, stamped, { sourceId: target });
      return {
        result,
        routing: { sourceId: target, landedIn: target, projectRoot, provenance: stamp },
      };
    },

    async probe() {
      if (!client) return { ok: false, code: degradedReason?.code ?? 'brain_not_configured' };
      return client.request('probe', {}, { deadlineMs: 10_000 });
    },

    stop: async () => (client ? client.stop() : { stopped: false, reason: 'not_connected' }),

    /** The resolved session source, for diagnostics. Never a way to SET one. */
    async resolvedSource(session = {}) {
      const { sourceId, projectRoot } = await routingFor(session);
      return { sourceId, projectRoot };
    },

    /** The cached registry, for diagnostics and for the install-time probe. */
    async sources() {
      return loadRegistry();
    },
  };

  ctx.provide?.(SERVICES.brain, brain);
  ctx.provide?.(SERVICES.backend, {
    version: BACKEND_VERSION,
    negotiate,
    /** The memory fork reaches the brain through the same guarded service. */
    request: brain.request,
    write: brain.write,
  });

  // Dispose must stop the helper: a daemon left behind after remove_bundle is a bug
  // the design names, and the socket keyed by database fingerprint makes it visible.
  ctx.on?.('dispose', () => {
    brain.stop().catch(() => { /* best effort on teardown */ });
  });

  ctx.logger?.info?.(
    `[dsh-gbrain] ready=${brain.available} v=${version} services=${Object.values(SERVICES).join(',')}` +
      (degradedReason ? ` degraded=${degradedReason.code}` : ''),
  );

  // Exported for tests and for the install-time probe, not as a Cordis service.
  return {
    probe: () => brain.probe(),
    warnings: () => brain.warnings(),
    brain,
  };
}

export { RoutingError, describeError, needsHuman, renderError, renderSuccess };
