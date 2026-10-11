#!/usr/bin/env node
/**
 * Generates the PRESET row from the SHIPPED standard preset, or checks that our copy has
 * not drifted from it.
 *
 * WHY THIS FILE EXISTS, from docs/designs/DSH_NATIVE_PLUGIN.md, section "The Chosen Shape":
 *
 *   "A preset declaration carries its complete plugin list and has no `extends`, so a
 *    preset that adds tools must copy the shipped list. `dsh-wyrmbrain` does exactly this
 *    and its comment explains why the copy must be generated rather than hand-maintained:
 *    overriding `preset-standard` instead 'would silently drop every tool a future DSH
 *    adds.'"
 *
 * The failure this generator prevents is the one that matters: DSH ships a new plugin in
 * its standard preset, our hand-copied list does not have it, and every session on our
 * preset silently loses that plugin. Nothing errors. That is why the copy is generated
 * and why `--check` re-reads the SHIPPED file rather than trusting our own output.
 *
 * WHERE THE SHIPPED FILE IS. It is not in the preset registry package; it is a bundle
 * patch shipped by the web app:
 *   <dsh-install>/.../node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
 * The path is discovered, not hardcoded, so an upgrade that moves it fails loudly.
 *
 * Usage:
 *   node dsh/scripts/gen-preset.mjs           # write dsh/presets/gbrain-tools.patch.yml
 *   node dsh/scripts/gen-preset.mjs --check   # fail if our copy has drifted
 *
 * Not itself generated.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dshRoot = join(here, '..');
const outPath = join(dshRoot, 'presets', 'gbrain-tools.patch.yml');
const outDir = dirname(outPath);
const check = process.argv.includes('--check');

const BANNER = [
  '# GENERATED FILE — do not edit.',
  '# Source: the shipped standard agent preset (see SHIPPED_FROM below)',
  '# Generator: dsh/scripts/gen-preset.mjs',
  '# Regenerate: node dsh/scripts/gen-preset.mjs',
  '# Drift check: node dsh/scripts/gen-preset.mjs --check',
].join('\n');

const SHIPPED_MARK = '# SHIPPED_FROM: ';
const TOOLS_ROW_MARK = '# PRESET_TOOLS_ROW_ANCHOR';

/**
 * Discover the shipped standard preset. Searched rather than hardcoded because the
 * install layout can change between DSH releases, and a silent miss here would let us
 * regenerate from a stale file.
 */
function findShippedPreset() {
  const explicit = process.env.DSH_STANDARD_PRESET;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`DSH_STANDARD_PRESET points at a missing file: ${explicit}`);
    return explicit;
  }

  const roots = [
    process.env.DSH_INSTALL_ROOT,
    '/home/matt/.local/share/mise/installs/npm-deepseek-ai-dsh',
  ].filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root)) {
      const mise = join(root, version, 'node_modules', '.mise');
      if (!existsSync(mise)) continue;
      for (const pkg of readdirSync(mise)) {
        if (!pkg.startsWith('@deepseek-ai+dsh-web-app@')) continue;
        const p = join(mise, pkg, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml');
        if (existsSync(p)) candidates.push(p);
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      'could not find the shipped standard preset. Set DSH_STANDARD_PRESET to its path, or DSH_INSTALL_ROOT to the DSH install root.',
    );
  }
  // Newest install wins when several are present.
  return candidates.sort().at(-1);
}

const shippedPath = findShippedPreset();
const shipped = readFileSync(shippedPath, 'utf8');

/**
 * Compose our preset from the shipped one.
 *
 * The transformation is deliberately minimal and structural: keep every row of the
 * shipped list verbatim, change the declaration's identity, and append one row. Every
 * other byte — including `!!js` expressions and nested config — is carried through
 * untouched, because rewriting them is how a generator starts disagreeing with the thing
 * it is copying.
 */
function compose(shippedText) {
  const lines = shippedText.split('\n');

  // Find the declaration row (`- id: preset-standard`) and the shipped preset id.
  const declIdx = lines.findIndex((l) => /^\s+- id: preset-\S+\s*$/.test(l));
  if (declIdx === -1) throw new Error('the shipped preset has no `- id: preset-…` declaration row to anchor on');
  const shippedId = lines[declIdx].match(/preset-(\S+)/)[1];

  const out = [...lines];

  // 1. Re-identify the row. We do NOT override preset-standard: overriding it would
  //    change every mode in the profile. This is an additional, opt-in preset.
  out[declIdx] = out[declIdx].replace(/preset-\S+/, 'preset-dsh-gbrain');

  // 2. Re-identify config.id, and give it an order after the shipped one.
  const cfgIdIdx = out.findIndex((l) => /^\s+id: \S+\s*$/.test(l) && out.indexOf(l) > declIdx);
  if (cfgIdIdx === -1) throw new Error('the shipped preset has no `config.id` to rewrite');
  out[cfgIdIdx] = out[cfgIdIdx].replace(/id: \S+/, 'id: dsh-gbrain');

  const orderIdx = out.findIndex((l, i) => i > cfgIdIdx && /^\s+order: \d+\s*$/.test(l));
  if (orderIdx === -1) throw new Error('the shipped preset has no `order:` to bump');
  const shippedOrder = Number(out[orderIdx].match(/order: (\d+)/)[1]);
  out[orderIdx] = out[orderIdx].replace(/order: \d+/, `order: ${shippedOrder + 1}`);

  // 3. Append our one row at the END of the plugin list, matching its indentation.
  const rowIndent = '          - id: ';
  out.push(`${rowIndent}gbrain-tools`);
  out.push('            name: dsh-gbrain/tools');
  out.push('            config:');
  out.push('              codeTools: true');
  // MANDATORY, and its absence kills the whole preset rather than just the row.
  // `lib/tools-entry.js` reads `defineTool` from this config because the tools row cannot
  // import `@deepseek-ai/dsh-tools`: a `link:`ed bundle outside the profile tree has no
  // node_modules of its own, so the peer is not resolvable from its real path. Without the
  // key, `registerTools` calls `undefined(...)` and the throw is recorded as the preset's
  // `broken` reason — the roster shows "Failed to load" and the preset cannot be selected.
  // Resolved from the profile's own module graph at load time, the same route the drache
  // mode's fragment uses, so both compositions stay in step.
  out.push(`              defineTool: !!js "(() => { const { createRequire } = process.getBuiltinModule('node:module'); try { return createRequire(baseUrl)('@deepseek-ai/dsh-tools').defineTool; } catch (error) { throw new Error('gbrain-tools: cannot resolve @deepseek-ai/dsh-tools from the profile module graph: ' + error.message); } })()"`);

  return { body: out.join('\n').replace(/\s+$/, ''), shippedId, shippedOrder };
}

const { body, shippedId, shippedOrder } = compose(shipped);

const header = [
  BANNER,
  `${SHIPPED_MARK}${shippedPath}`,
  `# SHIPPED_PRESET_ID: ${shippedId}`,
  `# SHIPPED_PRESET_ORDER: ${shippedOrder}`,
  '#',
  '# What this is: an ADDITIONAL, OPT-IN agent preset. It carries the shipped standard',
  '# preset\'s complete plugin list verbatim, plus one row of ours that mounts the',
  '# fourteen dsh-gbrain tools.',
  '#',
  '# It deliberately does NOT override `preset-standard`. Overriding that row would give',
  '# every mode in the profile the gbrain tools whether or not that mode wants them, and',
  '# the tools are a session\'s affordance rather than a host fact.',
  '#',
  '# A preset declaration has no `extends`, which is why this is a copy. The copy is',
  '# GENERATED from the shipped file named above, and `gen-preset.mjs --check` re-reads',
  '# that shipped file, so a DSH release that adds a plugin fails the check instead of',
  '# silently depriving this preset of it.',
  '#',
  `# TO REGENERATE after a DSH upgrade: node dsh/scripts/gen-preset.mjs`,
  '',
].join('\n');

// A file that ends without a newline trips the repo's check:newlines guard.
const content = header + body + '\n';

const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;

if (current === content) {
  console.log('ok    presets/gbrain-tools.patch.yml');
} else if (check) {
  console.error('DRIFT presets/gbrain-tools.patch.yml — regenerate with: node dsh/scripts/gen-preset.mjs');
  if (current) {
    const curShipped = (current.match(new RegExp(`^${SHIPPED_MARK}(.+)$`, 'm')) ?? [])[1];
    if (curShipped && curShipped !== shippedPath) {
      console.error(`  our copy was generated from: ${curShipped}`);
      console.error(`  the shipped file now is     : ${shippedPath}`);
    }
  }
  process.exit(1);
} else {
  // The generator owns its output directory: requiring it to pre-exist made the first
  // run fail with ENOENT rather than producing the file it was asked for.
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, content);
  console.log(`write presets/gbrain-tools.patch.yml (copied ${shippedId}, ${body.split('\n').length} lines)`);
}

if (check) {
  // Report what we checked, so a green check is evidence rather than silence.
  console.log(`[gen-preset] copied from ${shippedPath}`);
  console.log(`[gen-preset] our preset declares ${body.split('\n').filter((l) => /^\s+- id: /.test(l)).length} top-level plugin rows`);
}
