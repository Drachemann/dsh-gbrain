# Plan — the `dsh/` bundle's own gates, and what is actually left to build

**Stage:** gstack pipeline Plan, 2026-10-11.
**Predecessor:** `docs/handoff/ADVISORY-DECISION.md` (Think, RESOLVED — no advisory dependency).
**Design under execution:** `docs/designs/DSH_NATIVE_PLUGIN.md` (APPROVED).
**Status:** findings recorded. **No code written in this stage** — see "Scope decision" at the end.

---

## 1. What this Plan is, and why it is an audit rather than a fresh design

The design is approved and thorough, and most of it is already built. So the useful Plan work
is not to design again — it is to establish **which of the design's own Gates and Next Steps
actually hold on disk today**, because the two accounts disagree. The handoff prompt this
session was given describes the repository as *"`master` at `5b5891069`, **no `dsh/`
directory**, two untracked files"*. That was true when it was written and is false now.

### Verified state (re-derived from disk, not inherited)

| Design says | Disk says |
|---|---|
| No `dsh/` directory | `dsh/` has 5 lib modules + `tools.js` + `tools-exec.js` + `tools-entry.js`, 2 generators, 5 test files, generated manifest/patch/README |
| `lib/tools.js` is the tool list | Present; generators agree with it (**14 tools**) |
| Everything under `dsh/` is unbuilt | `node --test dsh/test/` → **107 tests, 107 pass, 0 fail** |

`git log -1` is still `5b5891069`, so all of `dsh/` is untracked work.

---

## 2. Gate results (quoted, this session)

| Gate | Result |
|---|---|
| `bun run verify` | **`[verify-parallel] elapsed=59s \| pass=76 fail=0 skip=0 \| all checks green`** → exit 0 |
| `node --test dsh/test/` | **`tests 107 · pass 107 · fail 0 · cancelled 0 · skipped 0`** → exit 0 |
| `node dsh/scripts/gen-surface.mjs --check` | exit 0 — `ok dsh.plugin.json`, `ok cordis.patch.yml`, `ok README.md`; *"14 tools; manifest and patch agree with lib/tools.js"* |
| `node dsh/scripts/gen-preset.mjs --check` | exit 0 — `ok presets/gbrain-tools.patch.yml`; copied from the installed `standard.patch.yml`; **34 top-level plugin rows** |
| `bun run test` | **still running** at the time of writing (~20 min in, 1403 files across 2+ shards). Not claimed green. |
| `bun run test:full` | not yet reached. `DATABASE_URL` is **unset**, so its E2E phase **will skip and say so on stderr**. |
| `bun run typecheck` | covered by `verify` (`typecheck` is one of the 76 checks) → green |

---

## 3. The two findings that matter

### Finding A — **nothing in this repository runs the plugin's tests.** (highest value)

The design's own "Layout" section predicted this and named the fix:

> "**Which repository gates inspect `dsh/`.** None of gbrain's own, by construction … So `dsh/`
> gets its own fork-owned workflow, `.github/workflows/dsh-plugin.yml`, which runs
> `node --test dsh/test/`, `node dsh/scripts/check-surface.mjs`, and a `bun run typecheck` of
> the repo."

Confirmed today:

- `bun run test` = `bash scripts/run-unit-parallel.sh`, which shards `bun test` over gbrain's
  own `test/**/*.test.ts`. It does not descend into `dsh/`.
- `bun run verify` = 76 guard checks, none of which name `dsh/`.
- **`.github/workflows/dsh-plugin.yml` does not exist.** The file that was supposed to be the
  only thing running this suite is absent.

**Consequence:** the 107 passing plugin tests, both generators' `--check` runs, and the entire
`dsh/` subtree are green *only when a human types the command*. A regression in the plugin
surface — a tool added to `lib/tools.js` without regenerating the patch, a manifest that
advertises a tool the surface does not carry — fails nothing on any automated path. That is
precisely the "advertised but not carried" failure the manifest/patch/README generator exists
to prevent, left unguarded.

This is a **failure mode**, not a style gap, and it is the one item in this Plan I would call
required rather than optional.

### Finding B — the design's explicit "no `dsh/` gates" claim is now false in a good way, and
`engine-host.js` is the untested surface.

`dsh/test/` covers `protocol.js` + `hash.js` + `paths.js` + `log.js` (`contract.test.js`),
`index.js` + `backend-contract.js` (`host-entry.test.js`), `tools.js` + `tools-exec.js`
(`preset.test.js`), `brain-routing.js` + `brain-client.js` (`routing.test.js`), and
`result.js` + `tools.js` (`surface.test.js`).

**`dsh/lib/engine-host.js` is referenced by no test** (`grep -rn engine-host dsh/test/` → one
hit, and it is a *fixture path string* `'/nonexistent/engine-host.js'`). It is 353 lines, it
**runs under Bun**, it owns the socket, the hello, the deadline race, the write serialisation,
the oversized-frame backstop, the stale-socket recovery and the exit codes — and every line of
it is unexecuted by the suite.

The design said: *"Write `dsh/lib/engine-host.js` and `dsh/lib/brain-client.js`, including
start, stop, version-skew, stale-socket and orphan-recovery, **with a test for each**."* Three
of those five (version-skew, stale-socket, orphan-recovery) have no test on the helper side.

**This is testable without a live brain**, and that is the point: `engine-host.js` reads
`process.argv`, so a test can spawn it under Bun with a fixture "gbrain root" and assert the
**failure contract** — `--database-url` missing → exit 2 with the named stderr message; a
root whose `src/core/engine-factory.ts` cannot be imported → exit 5, owner file cleared, socket
unlinked; a stale socket owned by a live pid → exit 3 and refuse rather than steal the socket.

---

## 4. Smaller divergences from the design's Layout (recorded, not urgent)

| Design Layout says | Disk |
|---|---|
| `dsh/cordis.patch.tmpl.yml`, `dsh/presets/gbrain-tools.patch.tmpl.yml` | **absent** — the generators build patch content in-process from `lib/tools.js` and the installed `standard.patch.yml`. The templates are a design artifact that the implementation correctly did not need. |
| `dsh/scripts/check-surface.mjs` | **absent** — `gen-surface.mjs --check` is the same thing; the design listed a wrapper that was never written. |
| `dsh/test/protocol.test.js`, `dsh/test/backend-contract.test.js` | **absent by name**; the clauses live in `contract.test.js` and `host-entry.test.js`. Coverage exists; the filenames drifted. |
| `docs/DSH_FORK.md` | **absent**. The design's `AGENTS.md` insertion is also absent (`AGENTS.md:246` has upstream's own `## Forks` section, not a fork-owned insertion). |
| `.github/workflows/dsh-plugin.yml` | **absent** — Finding A. |

### A design claim that is now false and should be corrected

The design's Routing and Trust Contract states:

> "…the helper verifies the connecting peer's uid with `SO_PEERCRED` / `LOCAL_PEERCRED` and
> refuses a mismatch."

**No such code exists.** `grep -rniE 'peercred|getpeereid|SO_PEERCRED' dsh/` returns nothing, and
nothing reads the connecting socket beyond `createServer((socket) => …)`.

To be precise about the risk rather than inflate it: on Linux, an `AF_UNIX` filesystem socket
**cannot be opened by a different uid** than the one that holds write permission on it, and
`paths.js` sets the socket `0600` inside a `0700` directory. So the peer-uid check is
**redundant** — the kernel already enforces it — and its absence is **not** a live hole.

But two things follow, and they are why this is a finding rather than a nitpick:

1. The design's **Success Criterion 2** is stated as if the uid check were load-bearing
   ("a peer that cannot reach the socket is refused"). What actually carries it is the mode
   bits, so the criterion should be restated against the mode bits — and a test should assert
   `0600`/`0700` and assert that a *stalely-owned* socket is refused, which is the check the
   helper really does perform.
2. A documented security control that does not exist is the exact class of claim this family's
   "evidence before claims" rule targets. Correcting the doc is cheap; leaving it is how a
   later reader builds on a control nobody implemented.

---

## 5. Recommended next increment, sized

> **STATUS, same session:** items 1–3 below are **BUILT**, not merely planned. See
> `docs/handoff/BUILD-dsh-plugin-gates.md` for exactly what landed and the gate results.
> Item 4 remains deferred as recommended.

**Scope, in priority order — none of it adds a dependency, none of it touches tool code:**

1. **`.github/workflows/dsh-plugin.yml`** — the fork-owned workflow the design already
   specified. Runs `node --test dsh/test/`, `bun dsh/scripts/gen-surface.mjs --check`,
   `node dsh/scripts/gen-preset.mjs --check`. Additive: upstream never touches it, so it costs
   nothing at merge time. **Closes Finding A.**
2. **`dsh/test/engine-host.test.js`** — spawn the helper with a fixture root and assert the
   failure contract (exit 2 / exit 5 + cleanup / exit 3 refuse-to-steal). **Closes Finding B**
   for the three untested clauses that do not need a live brain.
3. **Correct the design doc's peer-uid claim** and restate Success Criterion 2 against the mode
   bits. Documentation, no behaviour change.
4. `docs/DSH_FORK.md` + the two marked `AGENTS.md` insertions (Success Criterion 4's additivity
   ledger). Larger and independent; can be deferred without blocking 1–3.

**Explicitly out of scope for this increment:** a live end-to-end code read through the helper
(needs `DATABASE_URL` + the pgvector container), and anything from the advisory seam
(see `ADVISORY-DECISION.md`).

---

## 6. Edge cases and failure modes the increment must handle

For the workflow (1): a step that **fails open** is worse than no step, so the workflow must
`set -e`-equivalent fail on the `--check` exit codes, and must run `node --test`, not `bun test`
— `bun test` does not descend into dot-directories and this family has already been bitten by
that (`PROMPT-gstack-gbrain-and-advisory.md`: *"`bun test .dsh/plugin/test/` finds ZERO tests"*).

For the helper test (2):

| Case | Expected |
|---|---|
| no `--database-url`, no `GBRAIN_DATABASE_URL` | exit **2**, stderr names `--database-url` |
| fixture root with no importable `src/core/engine-factory.ts` | exit **5**, owner file cleared, socket unlinked, stderr says "engine boot failed" |
| stale socket file + a **live** owner pid | exit **3**, **refuse** — do not steal the socket |
| stale socket file + a **dead** owner pid | socket unlinked, then binds |
| `--repo` omitted | root resolves to `<this file>/../..`, not cwd |

That last row is a real trap: the helper must **not** resolve the gbrain root from `cwd`, for
the same reason the design forbids the Host row from resolving the project root from cwd.

## 7. What will prove it works

- `node --test dsh/test/` green, with the count **increasing** from 107 (the new file's cases
  are the delta, and a regression in any of them fails).
- `github` workflow YAML linted (`actionlint` is already a workflow in this repo); each step's
  exit code checked, and the generator steps proven to **fail** on a deliberately-drifted
  artifact before being trusted.
- `bun run verify` still green (76/0/0) after the change — the workflow file is additive and
  must not perturb gbrain's own guards.
- `git diff upstream/master --stat` shows **no change to an upstream-owned file** beyond the
  two marked `AGENTS.md` insertions (Success Criterion 4).

## 8. Open questions (resolved or owned)

| # | Question | Disposition |
|---|---|---|
| 1 | Does the helper serve a real code read end to end? | **UNRESOLVED, and unverifiable today** — `DATABASE_URL` unset, no container runtime, no helper state dir. Design Open Question 1 stays open. Owner: the next session with a live brain. NOT a blocker for this increment. |
| 2 | Does `gbrain` self-reference resolve from inside `dsh/`? | Design Open Question 2. `engine-host.js` sidesteps it by using a **relative file URL** into `src/core/` (`loadGbrain`). Recorded as answered-by-construction, not verified against a live engine. |
| 3 | Should `dsh/` tests run in `bun run test` rather than only in a fork-owned workflow? | **Decided: no.** Design P3 makes additivity the priority; extending an upstream-owned script or workflow is exactly where upstream churn concentrates. The fork-owned workflow is the right home. |
| 4 | Is the missing `.tmpl.yml` layer a problem? | **No.** The generators validate themselves (`--check` passes) and the templates were an implementation hypothesis the implementation correctly discarded. Design Layout should be corrected to match. |

## 9. Scope decision — why no code was written in this stage

The increment above is small and well-bounded, but two of its four items write **new files that
will be reviewed as part of the fork's public surface**, and the mission for this session names
its deliverable as the Think answer plus continuing the design's wave. The design's wave is
already substantially built and green; what is missing is the automation around it.

**Recommendation:** take items 1–3 now (they are additive, testable without a live brain, and
close the two findings), defer item 4 (`docs/DSH_FORK.md` + `AGENTS.md` insertions) to the same
session that can also close Open Question 1 against a live brain — so the fork's README and its
additivity ledger get written once, against a verified end-to-end read, instead of twice.
