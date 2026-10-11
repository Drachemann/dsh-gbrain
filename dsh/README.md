# dsh-gbrain — gbrain as a native DeepSeek Harness plugin

gbrain's code intelligence and coding memory, reachable from a DSH session as typed tools
with no MCP mount and no per-query CLI spawn.

Design: [`docs/designs/DSH_NATIVE_PLUGIN.md`](../docs/designs/DSH_NATIVE_PLUGIN.md) (Status: APPROVED).

## What this is, in one paragraph

A **resident Bun helper** owns one connection to a Postgres+pgvector brain and answers
newline-delimited JSON over a Unix socket. A **Host row** (`cordis.patch.yml`) supervises
that helper and publishes two services. The **fourteen tools** read and write the brain
through the helper. The code graph is built locally by gbrain with tree-sitter — no LLM,
no API key, no per-query process start.

## Why a separate process, and not just an import

DSH executes under **Node**, and gbrain's TypeScript cannot load there at all:

```
$ node -e "await import('gbrain/operations')"
ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode
```

72 parameter properties across 65 `src/` files, 11 modules using Bun-only
`with { type: 'file' }` imports, and 61 MB of committed tree-sitter WASM. So the helper
runs under **Bun** and touches gbrain's **exported subpaths** (`engine-factory`,
`operations`) rather than its internal module paths. That is what keeps an upstream merge
cheap: a merge we do, not a merge we fight.

## Install

```bash
git clone <fork-url> ~/src/dsh-gbrain
cd ~/src/dsh-gbrain && bun install
bun link                                   # puts THIS fork's gbrain on PATH, not upstream's

# pgvector, loopback only, persistent, password out of the shell history
umask 077
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)" > ~/.gbrain-pg.env
podman volume create gbrain-pgdata
podman run -d --name gbrain-postgres --restart unless-stopped \
  -p 127.0.0.1:5432:5432 --env-file ~/.gbrain-pg.env \
  -v gbrain-pgdata:/var/lib/postgresql/data pgvector/pgvector:pg16

podman exec gbrain-postgres createdb -U postgres gbrain     # init does not create it
export GBRAIN_DATABASE_URL="postgresql://postgres:$(cut -d= -f2 ~/.gbrain-pg.env)@127.0.0.1:5432/gbrain"
gbrain init --url "$GBRAIN_DATABASE_URL" --no-embedding     # STOP: choose a search mode
gbrain sources add <id> --path ~/src/dsh-gbrain
gbrain sync --source <id> --strategy code --no-embed
```

### One required step that is not obvious

`gbrain init` **activates managed persistence by default**, and that path requires a
symlink-free worktree manifest while `bun install` writes `node_modules/.bin/*` symlinks.
So `gbrain sources add` refuses with `writer_manifest_unsafe` on any npm/bun project.

Deactivate managed persistence for a local development brain, using the documented
operator command (read the status first — the command requires the `admin_state` it
prints):

```bash
gbrain sources writer status --json        # copy admin_state
gbrain sources writer deactivate --admin-intent writer_deactivate --expected-state <admin_state>
```

Then `gbrain sources add` succeeds. This is not a workaround: it is the supported switch
between the managed and unmanaged planes.

## Configure the row

The bundle ships **no** database URL, deliberately — the harness process cwd is `~/.dsh`,
not the session project, so a per-deployment value belongs in the profile. Add to the
profile patch:

```yaml
- id: gbrain
  name: dsh-gbrain
  config:
    databaseUrl: ${GBRAIN_DATABASE_URL}
    memorySourceId: <memory-source-id>
    codeTools: true
```

Then install the bundle:

```
plugin_manager { action: "install_bundle", target: "link:<repo>/dsh" }
```

With `databaseUrl` unset the row **still activates**, reports degraded, and every brain
call fails with `brain_not_configured` naming both remedies (config or
`GBRAIN_DATABASE_URL`). It does not fail activation.

## Routing: where a call reads and writes

`source_id` **never comes from the model**. A tool handler accepts no `source_id`. The Host
row resolves it per session: the project root's `.gbrain-source`, else the source
registered against that project path, else `no_source_for_project`. The allowed set is the
project source plus `memorySourceId`, and nothing else — a request naming anything else is
refused with `source_not_allowed`.

An unresolvable source is a **named absence**, never a silent fallback to `default`. A
write lands in `memorySourceId` when set, otherwise the project's own source, and never in
a code mirror by accident.

<!-- generated:tools start -->

## Tools (14)

Generated from [`lib/tools.js`](../lib/tools.js). Do not edit this section by hand.

### Code graph — the reason this plugin exists. All six are refused to MCP callers.

- **`code_def`** — Where is symbol Y defined.
- **`code_refs`** — Every literal mention of a symbol.
- **`code_callers`** — Who calls Y.
- **`code_callees`** — What Y calls, and where it reaches a side effect.
- **`code_blast`** — Recursive blast radius of a symbol: everything reachable through the call graph, grouped by depth with a confidence that decays with distance.
- **`code_flow`** — Follow control from an entry point downward to its sinks.

### Code-aware retrieval.

- **`query`** — Search the brain, code included, with two-pass structural expansion.

### Pages.

- **`get_page`** — Read one page by slug.
- **`put_page`** — Write a page.

### Coding memory verbs.

- **`recall`** — Recall what the brain already knows about a topic.
- **`remember`** — Save a durable fact, decision or preference for later sessions.
- **`forget`** — Withdraw a fact this session or a prior one wrote.
- **`context_pack`** — A budget-packed bundle of the context most relevant to a task.
- **`delta`** — What changed since a marker.

<!-- generated:tools end -->

## Two facts worth knowing before you rely on this

**The recursive walks cover four languages.** `code_blast` and `code_flow` support
TypeScript, TSX, JavaScript and Python — not the 36 the chunker can parse. An unsupported
language says so rather than returning an empty walk. The non-recursive reads and symbol
search are language-agnostic.

**The code reads are a trusted lane, by upstream design.** gbrain suspends all six
code-graph reads for callers that are not trusted-local, naming `garrytan/gbrain#5052`.
This plugin's helper *is* the trusted local lane that refusal recommends, and because that
bypasses gbrain's own source-scoping, the equivalent guard is re-implemented one layer up
(see Routing above).

## Status

Implemented and tested: the wire contract, socket layout and lifecycle, the routing guard,
the result mapper, the client, the helper, and the tool surface — 64 tests, `node --test
dsh/test/`.

**Not yet implemented, and named rather than implied:** the preset row that registers the
fourteen tools. A preset declaration carries its complete plugin list and has no `extends`,
so adding tools means copying the shipped preset's 19-row list and keeping that copy in
step with DSH releases — exactly the silent-drift failure the design's generator paragraph
exists to prevent. Half-implementing that copy would be worse than not shipping it, so the
Host row ships first and the preset row is the next step, with
`lib/tools.js` already the source of truth it will be generated from.
