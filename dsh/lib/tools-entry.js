/**
 * The preset-half entry: the fourteen tools, and nothing else.
 *
 * Source of truth: docs/designs/DSH_NATIVE_PLUGIN.md, section "The Chosen Shape".
 *
 * Why the tools are here and not in the Host row, in the design's own words: "a preset
 * declaration carries its complete plugin list and has no `extends`, so a preset that
 * adds tools must copy the shipped list. `dsh-wyrmbrain` does exactly this and its
 * comment explains why the copy must be generated rather than hand-maintained:
 * overriding `preset-standard` instead *'would silently drop every tool a future DSH
 * adds.'*"
 *
 * So this file is tiny on purpose: it registers the surface and consumes the service the
 * Host row publishes. Everything about the brain — the engine, the socket, the routing
 * guard, the logger — belongs to the row that owns the connection.
 *
 * `inject` names EVERY service this row reaches. The rule is Cordis's, not a preference:
 * a service read as a plain `ctx.<name>` property must be declared in `inject` or the
 * runtime throws `cannot get property "<name>" without inject`; a service you do not want
 * to depend on is read through `ctx.get('<name>')`, which needs no declaration.
 *
 * This paragraph used to argue the opposite — that `tools` should be left OUT and reached
 * through `ctx.tools` because it is "always present in a session that can host a tool at
 * all". That reasoning was wrong, and it took the whole preset down: `ctx.tools.register`
 * in lib/tools-exec.js threw during activation, so `preset-dsh-gbrain` and
 * `preset-dsh-drache-technik` both showed "Failed to load". `dsh-wyrmbrain` states the
 * correct rule in its own header and declares `tools`; follow that, not this file's
 * history.
 *
 * Not generated. No banner applies.
 */

import { TOOLS } from './tools.js';
import { registerTools } from './tools-exec.js';

export const name = 'dsh-gbrain-tools';

/** The one service this row cannot work without. */
export const SERVICES = Object.freeze({ brain: 'gbrainBrain' });

/**
 * Every service this row reaches, named so Cordis can gate activation on them.
 *
 * `tools` IS REQUIRED, and leaving it out was a fatal activation bug: `registerTools`
 * calls `ctx.tools.register(...)` (lib/tools-exec.js), and Cordis throws
 * `cannot get property "tools" without inject` for any service read as a plain
 * property that is not declared here. Every sibling that registers tools declares it:
 * `dsh-wyrmbrain` (`['tools', 'wyrmbrainJev', 'modelPolicy']`), `dsh-gstack`
 * (`['tools', 'llm', 'agentDefaultModel']`) and the shipped `dsh-tool-todo`.
 *
 * The brain service is read through `ctx.get()`, which needs no inject, but it is
 * declared anyway: this row is useless before the Host half publishes it, and waiting is
 * the correct behaviour — a row that stays pending with a named service is far easier to
 * diagnose than fourteen tools that throw on first use.
 */
export const inject = ['tools', SERVICES.brain];

export function apply(ctx, config = {}) {
  const brain = ctx.get(SERVICES.brain);
  if (!brain) {
    // Activation failure with a diagnosable cause beats fourteen broken tools.
    throw new Error(`${name}: ${SERVICES.brain} is not present; the dsh-gbrain Host row must activate first`);
  }

  const codeTools = config.codeTools !== false;
  const tools = codeTools
    ? TOOLS
    : TOOLS.filter((t) => t.group !== 'code-graph');

  // The row cannot resolve this itself: it lives outside the profile tree, so the peer
  // `@deepseek-ai/dsh-tools` is not reachable from its real path and the composition
  // supplies the harness's real `defineTool` from the profile's module graph instead.
  // Name the omission here: the bare TypeError this used to raise (`defineTool is not a
  // function`) escaped `apply()` and surfaced only as "Failed to load" on the entire
  // preset, with nothing in the message pointing at this row or this key.
  const defineTool = config.defineTool;
  if (typeof defineTool !== 'function') {
    throw new Error(
      `${name}: config.defineTool is not a function; the preset row that mounts this plugin must`
      + ' supply the harness\'s defineTool (see dsh/presets/gbrain-tools.patch.yml)'
    );
  }

  const registered = registerTools({
    ctx,
    tools,
    defineTool,
    getBrain: () => ctx.get(SERVICES.brain),
    log: (m) => ctx.logger?.info?.(`[dsh-gbrain] ${m}`),
  });

  if (!codeTools) {
    ctx.logger?.info?.('[dsh-gbrain] codeTools: false — the six code-graph tools were not registered');
  }

  return { registered, codeTools };
}
