#!/usr/bin/env node
/**
 * Generates the declared surface from lib/tools.js, or checks that disk agrees with it.
 *
 * THE POINT OF THIS FILE, from docs/designs/DSH_NATIVE_PLUGIN.md:
 *
 *   "`dsh/lib/tools.js` is the single source of truth for that list. The manifest,
 *    both patch files and the README are **generated from it** by
 *    `dsh/scripts/gen-surface.mjs`, and `gen-surface.mjs --check` fails when any of
 *    them disagrees."
 *
 * Usage:
 *   node dsh/scripts/gen-surface.mjs           # write the generated artifacts
 *   node dsh/scripts/gen-surface.mjs --check   # fail if disk disagrees (no writes)
 *
 * Generated artifacts each carry a banner naming this file and the source it came from.
 * Never hand-edit them; edit lib/tools.js and regenerate.
 *
 * Not itself generated.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dshRoot = join(here, '..');
const check = process.argv.includes('--check');

const { TOOLS, TOOL_NAMES, TOOL_GROUPS } = await import(join(dshRoot, 'lib', 'tools.js'));
const pkg = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'));

const BANNER = [
  '# GENERATED FILE — do not edit.',
  '# Source: dsh/lib/tools.js',
  `# Generator: dsh/scripts/gen-surface.mjs`,
  '# Regenerate: node dsh/scripts/gen-surface.mjs',
  '# Drift check: node dsh/scripts/gen-surface.mjs --check',
].join('\n');

/**
 * Marker text. Matching is PREFIX-based on the marker token, so the short form a human
 * leaves in the README and the long form this file writes both resolve to the same
 * region — an earlier exact-match version silently never matched, which is exactly the
 * "advertised but not carried" failure the generator exists to prevent.
 */
const MARK = (name) => `<!-- generated:tools ${name} -->`;
const MARKER_TOKEN = (name) => `<!-- generated:tools ${name}`;
function findMarker(text, name) {
  const i = text.indexOf(MARKER_TOKEN(name));
  if (i === -1) return -1;
  const end = text.indexOf('-->', i);
  return end === -1 ? -1 : { start: i, end: end + 3 };
}

/** The declared-surface convention file. Not read by DSH; see the README note. */
function renderManifest() {
  const doc = {
    id: `${pkg.name}/${pkg.name}`,
    version: pkg.version,
    main: './lib/index.js',
    description: pkg.description,
    engines: { dsh: '>=0.2.0-rc.1' },
    contributes: {
      tools: TOOL_NAMES,
      services: ['gbrainBrain', 'gbrainBackend'],
      hooks: [],
    },
  };
  const jsonBanner = BANNER.split('\n').map((l) => l.replace(/^#/, '//')).join('\n');
  return `${jsonBanner}\n${JSON.stringify(doc, null, 2)}\n`;
}

/** The HOST row. Publishes the service; registers NO tool, by design. */
function renderHostPatch() {
  return `# dsh-gbrain — bundle patch (HOST composition).
#
# One row, in the Host composition, because everything it publishes is shared across
# sessions:
#
#   gbrainBrain     the warm-engine request surface. A resident Bun helper owns one
#                   connection to the Postgres brain and answers NDJSON over a Unix
#                   socket; this service is the client for it.
#   gbrainBackend   the versioned, narrow contract the dsh-memory-evolve fork consumes
#                   (see lib/backend-contract.js). Versioned from the first commit
#                   because its consumer does not exist yet.
#
# NO TOOL IS REGISTERED HERE, AND THAT IS THE POINT. The fourteen tools live in
# ./presets/gbrain-tools.patch.yml, because a session's affordances belong to the
# preset that session runs. This mirrors dsh-wyrmbrain, whose host row says the same.
#
# WHY A SEPARATE PROCESS. DSH executes under Node and gbrain's TypeScript cannot load
# there at all: 72 parameter properties across 65 files fail Node's strip-only mode,
# and 11 modules use Bun-only \`with { type: 'file' }\` imports. The helper runs under
# Bun and touches gbrain's EXPORTED SUBPATHS (engine-factory, operations) rather than
# its internal module paths, which is what keeps an upstream merge cheap.
#
# REQUIRED CONFIGURATION, and it is not optional:
#
#   databaseUrl   the Postgres connection string. Deliberately unset in the package,
#                 following dsh-gstack's stateDir precedent: the harness process cwd is
#                 ~/.dsh, not the session project, so a per-deployment value must come
#                 from the profile. Resolution order is config.databaseUrl, then
#                 GBRAIN_DATABASE_URL. With neither set the row ACTIVATES but reports
#                 degraded, and every brain call fails with brain_not_configured naming
#                 both remedies. It does not fail activation.
#
#   memorySourceId  where a write goes. A write lands here when set, otherwise in the
#                 project's own source, and never in a code mirror by accident.
#
#   codeTools     default true. Set false to withdraw the six code-graph tools while
#                 leaving retrieval and memory available. This exists because the code
#                 reads are suspended for agent callers upstream (garrytan/gbrain#5052)
#                 and this plugin re-implements the equivalent guard locally; an
#                 operator who wants to record that consent explicitly can.
#
# ${BANNER}
- insert:
    - id: gbrain
      name: ${pkg.name}
      config:
        enabled: true
        # databaseUrl: <postgres-connection-string>
        # memorySourceId: <source-id>
        codeTools: true
`;
}

/** The README's tool table, generated so it cannot drift from lib/tools.js. */
function renderReadmeSection() {
  const lines = [];
  lines.push(MARK('start'));
  lines.push('');
  lines.push(`## Tools (${TOOLS.length})`);
  lines.push('');
  lines.push('Generated from [`lib/tools.js`](../lib/tools.js). Do not edit this section by hand.');
  lines.push('');
  const titles = {
    'code-graph': 'Code graph — the reason this plugin exists. All six are refused to MCP callers.',
    retrieval: 'Code-aware retrieval.',
    pages: 'Pages.',
    memory: 'Coding memory verbs.',
  };
  for (const [group, names] of Object.entries(TOOL_GROUPS)) {
    lines.push(`### ${titles[group] ?? group}`);
    lines.push('');
    for (const n of names) {
      const t = TOOLS.find((x) => x.name === n);
      const first = t.description.split(/(?<=\.)\s/)[0];
      lines.push(`- **\`${n}\`** — ${first}`);
    }
    lines.push('');
  }
  lines.push(MARK('end'));
  return lines.join('\n');
}

const artifacts = [
  { path: join(dshRoot, 'dsh.plugin.json'), content: renderManifest(), label: 'dsh.plugin.json' },
  { path: join(dshRoot, 'cordis.patch.yml'), content: renderHostPatch(), label: 'cordis.patch.yml' },
];

// The README section is spliced between its markers rather than regenerating the prose.
const readmePath = join(dshRoot, 'README.md');
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8');
  const startM = findMarker(readme, 'start');
  const endM = findMarker(readme, 'end');
  if (startM !== -1 && endM !== -1 && endM.start > startM.end) {
    const next = readme.slice(0, startM.start) + renderReadmeSection() + readme.slice(endM.end);
    artifacts.push({ path: readmePath, content: next, label: 'README.md' });
  } else {
    console.error('[gen-surface] README.md has no generated:tools markers; skipping it rather than guessing');
  }
}

let drifted = 0;
for (const a of artifacts) {
  const current = existsSync(a.path) ? readFileSync(a.path, 'utf8') : null;
  if (current === a.content) {
    console.log(`ok    ${a.label}`);
    continue;
  }
  if (check) {
    drifted++;
    console.error(`DRIFT ${a.label} — regenerate with: node dsh/scripts/gen-surface.mjs`);
  } else {
    writeFileSync(a.path, a.content);
    console.log(`write ${a.label}`);
  }
}

if (check) {
  if (drifted > 0) {
    console.error(`[gen-surface] ${drifted} artifact(s) disagree with dsh/lib/tools.js`);
    process.exit(1);
  }
  console.log(`[gen-surface] ${TOOLS.length} tools; manifest and patch agree with lib/tools.js`);
}
