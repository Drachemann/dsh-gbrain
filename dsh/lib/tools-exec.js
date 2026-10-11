/**
 * The tool executor: one gbrain operation per declared tool, dispatched through the
 * published `gbrainBrain` service.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section "The Operation Surface".
 * The rule this file exists to honour:
 *
 *   "Tool descriptions are taken verbatim from gbrain's own `op.description` where they
 *    exist — those descriptions are deliberately prompt-engineered for tool selection, so
 *    do not rewrite them."
 *
 * So this module owns NO description text. Every model-facing string lives in
 * `tools.js`, which the generator writes the manifest and README from.
 *
 * The executor is deliberately thin. It does not decide routing, does not build a
 * source, and does not catch-and-flatten an error: routing is the Host row's job and
 * the error envelope is `result.js`'s job. A thin adapter is what keeps a refusal
 * reaching the model with its code, why and fix intact.
 *
 * Not generated. No banner applies.
 */

import { describeError, toContentBlocks, needsHuman } from './result.js';
/**
 * Normalise a gbrain result into an object.
 *
 * `query` returns a BARE ARRAY (verified against a live call), while every tool's
 * `output.schema` declares `type: 'object'`. Passing the array straight through
 * would hand the framework an array where the schema says object. One boundary,
 * one fix — rather than a schema per tool that goes stale on an upstream change.
 */
export function envelope(result) {
  if (Array.isArray(result)) return { rows: result, count: result.length };
  if (result && typeof result === 'object') return result;
  return { value: result };
}


/** Tools whose gbrain op mutates the brain. Derived from the protocol's write list. */
const WRITE_TOOLS = new Set(['put_page', 'remember', 'forget']);

/**
 * Read the calling session's project root and id from the TOOL EXECUTION context.
 *
 * This is the only supported route, and it is the one the harness's own tools use.
 * Verified against the installed 0.2.0-rc.2 checkout rather than recalled:
 *
 *   `@deepseek-ai/dsh-tool-bash`       lib/index.js:294  `exec.agent?.session.header.cwd`
 *   `@deepseek-ai/dsh-tool-fs-search`  lib/index.js:168  `exec.agent?.session.header.cwd ?? process.cwd()`
 *
 * and `dsh-tool-bash` reads `exec.agent?.id` at :423, so both fields this module reads
 * are the fields the harness's own tools read.
 *
 * What those citations do NOT say is worth stating, because an earlier draft of this
 * comment got it wrong: `dsh-tool-bash` declares
 * `inject = ['tools','shell','systemPrompt','shellEnv']` (lib/index.js:223), so it is not
 * true that it reaches the session "with no inject entry at all", and the
 * `?? process.cwd()` fallback is `dsh-tool-fs-search`'s, not its. The narrower point is
 * the one that decides the design and it still holds: `exec` is a function ARGUMENT, so
 * the session root is readable without injecting anything — which is exactly why it
 * could never be resolved in `apply()`.
 *
 * There is NO Cordis service named `session` in DSH 0.2.0-rc.2 — `ctx.sessions` is a
 * registry (`create`/`get`/`list`), not the current session — so a row that reads
 * `ctx.session` gets Cordis's own `cannot get property "session" without inject`
 * (raised in `@deepseek-ai/cordis`, lib/index.js) and every call fails.
 *
 * The distinction matters: the root is a property of the CALL, not of the plugin, so it
 * cannot be resolved in `apply()`. Reading it here is what keeps routing tier 1 (the
 * project's `.gbrain-source`), tier 2 (the source registered against that path) and the
 * provenance stamp pointed at the session's project rather than at `~/.dsh`.
 *
 * A headless call with no agent yields `{ projectRoot: null, sessionId: null }`, which is
 * the DESIGNED outcome: routing then refuses with `no_source_for_project` rather than
 * silently querying `default`, because silently querying `default` is how one project
 * reads another's code.
 */
export function sessionContext(exec) {
  const header = exec?.agent?.session?.header;
  const projectRoot = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null;
  const sessionId = typeof exec?.agent?.id === 'string' && exec.agent.id.length > 0 ? exec.agent.id : null;
  return { projectRoot, sessionId };
}

/**
 * Build the `execute` function for one declared tool.
 *
 * `brain` is the service published by the Host row. It is read through a getter rather
 * than captured, because the service can be in a degraded state at registration time and
 * a captured reference would freeze that verdict.
 */
export function makeExecutor(toolName, getBrain) {
  return async function execute(args, exec) {
    const brain = getBrain();
    if (!brain) {
      const e = new Error('the gbrain service is not available in this session');
      e.code = 'brain_service_unavailable';
      e.suggestion = 'check that the dsh-gbrain Host row activated, then retry in a new session';
      throw e;
    }

    const params = normaliseParams(toolName, args);
    try {
      if (WRITE_TOOLS.has(toolName)) {
        const { result, routing } = await brain.write(toolName, params, sessionContext(exec));
        // The write policy requires the landing source to be visible, so a misrouted
        // write is noticeable rather than silent.
        return { ...envelope(result), _routing: routing };
      }
      const { result } = await brain.request(toolName, params, sessionContext(exec));
      return envelope(result);
    } catch (thrown) {
      // The tool layer's one job on failure: hand a THROWABLE carrying the envelope to
      // the framework, which renders it through `render`. We do not convert a refusal
      // into a success-with-text, because a tool that reports success while refusing is
      // how a model concludes a thing does not exist.
      const described = describeError(thrown);
      const e = new Error(described.message);
      e.code = described.code;
      e.why = described.why;
      e.suggestion = described.suggestion;
      e.fix = described.fix;
      e.reason = described.reason;
      e.notices = described.notices;
      e.needsUser = needsHuman(described);
      throw e;
    }
  };
}

/**
 * Map tool args to gbrain operation params.
 *
 * Two deliberate normalisations, both from the design and both narrowing rather than
 * widening what a model can reach:
 *
 *   1. `source_id` is DROPPED if a model sends one. The design is explicit that routing
 *      is resolved by the Host row and never by the model — "A tool handler never
 *      accepts a source_id parameter." Dropping it here means a model cannot widen its
 *      own scope even by inventing the argument.
 *   2. `query`'s tool name maps to the `query` op with its optional filters preserved;
 *      nothing is renamed, so the op names stay greppable against gbrain.
 */
export function normaliseParams(toolName, args = {}) {
  const params = { ...(args ?? {}) };
  delete params.source_id;
  delete params.sourceId;
  return params;
}

/** True when this tool mutates the brain. Exported so a test can pin the set. */
export function isWriteTool(toolName) {
  return WRITE_TOOLS.has(toolName);
}

/**
 * Register every declared tool on a DSH tools registry.
 *
 * `defineTool` is injected rather than imported so this module has no hard dependency on
 * the peer package: the real one is supplied by the profile, and a test can pass an
 * identity function.
 */
export function registerTools({ ctx, tools, defineTool, getBrain, log }) {
  const registered = [];
  for (const tool of tools) {
    const definition = defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: makeExecutor(tool.name, getBrain),
      output: {
        // Typed as an open object: gbrain's return shapes are its contract, not ours, and
        // asserting a closed schema here would be a second copy of that contract that
        // goes stale on an upstream change.
        schema: { type: 'object', additionalProperties: true, description: `${tool.name} result envelope from gbrain.` },
        render: (_args, value) => toContentBlocks(tool.name, value),
      },
    });
    ctx.tools.register(definition);
    registered.push(tool.name);
  }
  log?.(`registered ${registered.length} tools: ${registered.join(', ')}`);
  return registered;
}
