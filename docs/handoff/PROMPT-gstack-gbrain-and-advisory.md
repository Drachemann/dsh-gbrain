# Handoff prompt — the dsh-gstack session that consumes both cores

Copy everything below into a **new session in `/home/matt/src/dsh-gstack`**. It is written
to be self-contained: that session should not need this conversation.

Two things have landed since the last dsh-gstack session, and they are independent pieces
of work that meet in one repository:

- **`dsh-advisory-core` is built, green, and consuming-ready.** The prompt
  `docs/handoff/PROMPT-gstack-consumes-core.md` in that repository is the authority for
  absorbing it — read it in full before you start, and treat it as the spec.
- **`dsh-gbrain` is now a working DSH plugin** with a fourteen-tool surface, a Host row,
  a preset row, and a live Postgres brain holding 8,031 indexed pages of this fork. Its
  design is `docs/designs/DSH_NATIVE_PLUGIN.md` in that repository, Status: APPROVED.

---

## The prompt

I want you to make `dsh-gstack` consume both `dsh-advisory-core` and the new
`dsh-gbrain` plugin. These are two separate changes with one shared constraint, so plan
them together but ship them as separate commits.

### Part 1 — absorb `dsh-advisory-core` (this part has a spec; follow it)

Read `/home/matt/src/dsh-advisory-core/docs/handoff/PROMPT-gstack-consumes-core.md`
**in full** first. It is the instruction, not background reading. Everything below is
orientation for it, not a replacement.

The goal in one line: `gstack_escalate` must work **with no other plugin installed**, with
its decisions running through `dsh-advisory-core` — one shared Jev client, one pace, one
budget, one ledger, one receipt.

Facts I have verified on this machine, so you do not have to re-derive them:

| Fact | Evidence |
|---|---|
| The core is a **library**, not a DSH plugin | `dsh-advisory-core` v0.1.0, 15 exports, **no** `pkg.dsh` block, **no** `peerDependencies`. Nothing to `plugin_manager install`. |
| The egress helper exists and is executable | `/home/matt/.dsh/skills/gstack/bin/gstack-egress-receipt`, `-rwxr-xr-x`, 3267 bytes |
| The four modules to absorb are all present | `.dsh/plugin/lib/`: `jev.js` 444 lines, `escalation.js` 352, `escalation-dispatch.js` 207, `egress-receipt.js` 212 |
| The plugin is a **sub-package** | the profile links `dsh-gstack -> /home/matt/src/dsh-gstack/.dsh/plugin` directly, so `dsh-advisory-core` must be linked into `.dsh/plugin/node_modules`, **not** the repository root |
| A **new** session picks up `lib/` changes; an open one does not | composition resolves at boot |

Four things the spec is emphatic about, repeated here because they are the ones that bite:

1. **Do not port `jev.js`.** Take the core's. The 429 bug is live in the current one and
   invisible until the free tier throttles.
2. **One budget, not two.** The counters in `escalation.js` (`perDecision` 1, `perStage` 2,
   `perSession` 6) are replaced by the engine's. Assert that one escalation decrements
   **one** ration.
3. **The egress receipt is fail-closed.** No receipt, no request. A missing helper must
   refuse, not send.
4. **A decline is not an error.** Roughly half of all questions come back `jev-hold`. Do
   not retry a decline.

And the acceptance criterion that actually proves it: a run must produce a `decision`
record whose `policyFingerprint` equals `core.config.fingerprint` and whose `coreVersion`
matches. **An extraction that compiles but was never called is not done.** Prove
`gstack_escalate` still works with any `dsh-wyrmbrain` presence removed.

### Part 2 — integrate `dsh-gbrain`

The plugin is installed in the `web` profile and composes. What exists:

- A **Host row** (`id: gbrain`, package `dsh-gbrain`) publishing `gbrainBrain` and
  `gbrainBackend` profile-wide, registering **no** tool.
- A **preset row** carrying **fourteen typed tools**: `code_def`, `code_refs`,
  `code_callers`, `code_callees`, `code_blast`, `code_flow`, `query`, `get_page`,
  `put_page`, `recall`, `remember`, `forget`, `context_pack`, `delta`.
- The brain: Postgres + pgvector in podman (`gbrain-postgres`), **8,031 pages**,
  215,921 symbol edges, source id `dsh-gbrain` pointing at this repository.

**The integration question, stated so you can decide it rather than assume it:** eleven
rendered skills in this repo already carry `## Save Results to Brain` blocks and nine carry
`## Brain Context Load` blocks, and every one of them is a **`gbrain` CLI call in prose**
guarded by "skip if `gbrain` is not on PATH". Now there is a typed tool surface. Decide,
with a reason, whether those blocks
- stay CLI prose (they work today and cost nothing to keep working),
- migrate to the typed tools (better ergonomics, but they must then only fire in a session
  whose preset carries `gbrain-tools`), or
- get a `gstack_route_skill`-style capability probe that picks whichever is available.

Constraints that are not negotiable in Part 2:

- **Routing is the Host row's job, never the model's.** A tool handler accepts no
  `source_id`. Do not add one.
- **A general-memory sibling is coming.** A fork of `dsh-memory-evolve` will consume
  `gbrainBackend`. `dsh-gbrain` owns coding memory and code intelligence; do not grow the
  general-memory surface here.
- **Do not add a gbrain dependency to `dsh-advisory-core`, or vice versa.** The core's own
  prompt says this explicitly for its side, and it holds both ways.
- **Do not make the tools model-facing from inside this repository, and do not invent a
  workaround for the fact that they are not yet.** See the next section — that step belongs
  to a different session.

### Who makes the fourteen tools model-facing (not this session)

The tools exist and work, but they are **not model-facing in every session yet**, and it is
important that this session does not try to fix that. The reason is a placement rule:

| Piece | Plane | Where it lives |
|---|---|---|
| the engine, the socket, the routing guard | **Host** | the `gbrain` Host row, profile-wide, already installed |
| the fourteen tool declarations | **Preset** | our generated `preset-dsh-gbrain`, already composed |
| **whether a given mode actually has them** | **Preset** | that mode's own plugin list |

The **Drache Technik agent mode is going to be updated to carry `dsh-gstack`,
`dsh-wyrmbrain` and `dsh-gbrain`** — but only once all three are usable, and as a separate,
deliberate piece of work. That update is where `gbrain-tools` gets added to the mode's
plugin list, and it is authored in `.dsh/agent-modes/` over in this repository, not in that
mode's skill prose.

So, concretely, for this session:

1. **Do not edit `.dsh/agent-modes/`.** The mode bundle is generated and owned by a later
   session that will wire all three plugins at once. Touching it now would either pre-empt
   that work or collide with it.
2. **Do not add a capability probe that "falls back" to something else.** A session either
   has the tools or it does not; a probe that reaches around the preset boundary is the
   kind of drift the placement rule exists to prevent.
3. **Answer the Part 2 question in terms of layers, not in terms of "make it work now."**
   The interesting decision is only whether the eleven prose blocks should be *authored* to
   prefer typed tools once a preset supplies them — and what they should do in a session
   that does not. Do not try to resolve availability; state the assumption.

**What this session should hand back to the agent-mode session**, so that session can add
the row without re-deriving anything:

- the exact preset-row id and specifier (`gbrain-tools` → `dsh-gbrain/tools`), and
- whether the eleven prose blocks now expect typed tools, so the mode's persona text and
  its plugin list are written to agree rather than to conflict.

There is one dependency worth naming: **`dsh-wyrmbrain` is being repointed onto
`dsh-advisory-core` in its own session.** This session does not need that to be finished —
the core is a library and you consume it directly. But do not assume wyrmbrain has already
moved, and do not edit `dsh-wyrmbrain` from here.

### Things I found that will save you time

- **`bun test .dsh/plugin/test/` finds ZERO tests.** Bun does not descend into
  dot-directories. Use `node --test .dsh/plugin/test/`. Do not "fix" this by adding `.dsh`
  to a test root — a test pins that it must not be.
- **`gstack_pipeline` writes `.dsh/gstack-pipeline.json`** in the working tree. Expect it as
  `??` in `git status`; it is session state, not source.
- **The profile patch holds a real credential already** (`dsh-gstack`'s Jev `apiKey`), so
  adding another there is consistent — but that file is `0600` and should stay so.
- **The four `lib/` modules are not at HEAD** — all seven files carry an uncommitted
  `gstack-dsh` → `dsh-gstack` rename, and two changed lines are **live strings**
  (`JEV_EGRESS_CONSENT`, the `mkdtemp` prefix). Check `git status` before you edit.

### Gates for this session

Use **this repository's** gates, not a sibling's:

```sh
node --test .dsh/plugin/test/     # not bun; see the dot-directory note
bun run typecheck                 # strict tsc, zero errors
bun run test:quick
bun run test
```

### What I would like back

1. Separate, bisectable commits: one for the advisory-core absorption, one for the gbrain
   integration, and generated-file regeneration inside whichever commit changed its source.
2. The declared surface kept honest in all three places — `dsh.plugin.json`,
   `cordis.patch.yml`, and the README — with the `exports` map edited in the same change
   as any module you delete.
3. A short note on what you decided about the eleven prose blocks, with the reason.
4. **A handback block for the agent-mode session** — three lines, so the later work of
   wiring the mode does not have to re-derive anything:
   - the preset-row id and specifier the mode should add (`gbrain-tools` →
     `dsh-gbrain/tools`),
   - whether the prose blocks now expect typed tools, and what they do without them, so
     the mode's persona text and its plugin list get written to agree, and
   - any change you made that the mode's own description should mention.

