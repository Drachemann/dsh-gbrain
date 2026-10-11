# Build — the `dsh/` bundle's own gates (items 1–3 of the Plan)

**Stage:** gstack pipeline Build, 2026-10-11.
**Plan:** `docs/handoff/PLAN-dsh-plugin-gates.md` — this implements its items 1–3, defers item 4.
**Think:** `docs/handoff/ADVISORY-DECISION.md` — **no `dsh-advisory-core` dependency**, and none was added.
**Files touched:** 3 new, 1 edited. No production module was changed.

---

## What landed

| # | File | Status | Closes |
|---|---|---|---|
| 1 | `.github/workflows/dsh-plugin.yml` | NEW | Plan Finding A |
| 2 | `dsh/test/engine-host.test.js` | NEW | Plan Finding B |
| 3 | `docs/designs/DSH_NATIVE_PLUGIN.md` | EDITED | the false `SO_PEERCRED` claim |
| — | `docs/handoff/{ADVISORY-DECISION,PLAN-dsh-plugin-gates,BUILD-dsh-plugin-gates}.md` | NEW | the Think/Plan/Build record |

**Deferred, deliberately:** `docs/DSH_FORK.md` and the two marked `AGENTS.md` insertions
(Plan item 4). Reason unchanged from the Plan: that work should be written once, against a
verified end-to-end code read, in the session that can also close design Open Question 1.

---

## 1. `.github/workflows/dsh-plugin.yml` — the gate that did not exist

**Before:** nothing in this repository ran the plugin's tests. `bun run test` shards
`bun test` over gbrain's own `test/**/*.test.ts`; `bun run verify` is 76 guards scoped to
`src/` and `test/`; and the workflow the design specified for the job was absent. The 107
plugin tests were green only when a human typed the command.

**After:** a fork-owned workflow that runs, in order:

1. `node --test dsh/test/`
2. `node dsh/scripts/gen-surface.mjs --check`
3. `node dsh/scripts/gen-preset.mjs --check`
4. `bun run typecheck`
5. a provenance step that fails if `dsh/package.json` declares no `dsh.bundle.patch`

Three choices worth naming, because each is a trap this family has already paid for:

- **`node --test`, never `bun test`.** Bun does not descend into dot-directories, and a
  suite that silently discovers zero tests and reports green is the exact failure this
  step exists to prevent. There is a comment in the file saying so.
- **No `paths:` filter.** The workflow runs on every push and PR to master, *not* only on
  `dsh/**` edits, because the thing most likely to break the plugin surface is an upstream
  DSH release changing the shipped preset our copied plugin list is generated from.
- **`ubuntu-latest`, not the `ubicloud-standard-*` labels** the rest of the repo uses.
  Those are upstream's paid fleet; a fork published for other people must not silently
  depend on them.

The two action pins were **resolved from the tree, not guessed**: `actions/checkout`
from `actionlint.yml`, and `oven-sh/setup-bun` from the 57 other call sites that already
use `0c5077e51419868618aeaa5fe8019c62421857d6`.

---

## 2. `dsh/test/engine-host.test.js` — the module nothing executed

`engine-host.js` is 353 lines that run under Bun and own the socket, the hello handshake,
the deadline race, write serialisation, the oversized-frame backstop and every exit code.
Before this file, `grep -rn engine-host dsh/test/` returned exactly one hit and it was a
fixture *string* (`'/nonexistent/engine-host.js'`). The design required "a test for each"
of start / stop / version-skew / stale-socket / orphan-recovery; the helper side had none.

Seven cases, spawned against the real helper under Bun with an isolated `HOME`:

| Case | Asserts |
|---|---|
| no `--database-url` | exit **2**, stderr names the flag **and** `GBRAIN_DATABASE_URL`, and **no state dir is created** |
| empty `--database-url` | still exit **2** — an empty string is unset, not a URL |
| dead owner planted | exit **5**, "engine boot failed", **owner record cleared**, **socket unlinked** |
| isolated `HOME` | the state dir lands under the temp HOME, never the real `~/.dsh/gbrain` |
| busy-socket refusal | wired, and **decided before `await boot()`** |
| exit-code drift | the codes this file asserts are still the codes the helper exits |
| socket path | keyed by database, stable, and two databases never collide |

### The honest gap, and two wrong versions it cost to find

**The exit-3 socket-busy refusal is NOT an end-to-end spawn here**, and the file says so in
its header rather than leaving the green to imply coverage. Why: the helper calls
`stopOwner(ownerFile, { timeoutMs: ... })`, and `stopOwner` sends **SIGTERM to the pid in
`owner.json`**. In a test process the only conveniently-live pid is `process.pid` — the
test runner — so spawning that case SIGTERMs the suite running it.

That is not a theory. **Two earlier versions of this file did it**, and both were reported
by the Node test runner as the whole file being one failed "test" with no individual
assertion printed:

```
✖ dsh/test/engine-host.test.js (149.689698ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

The second attempt even set `timeoutMs: 1` believing a short wait made it safe, and its
comment claimed the helper "only ever observes this pid" — which was simply **false**:
`stopOwner` signals the pid, and it signals it first, before any bounded wait. The fix was
to stop trying to spawn that path in-process, pin it where it is actually decided (the
grader's own branch plus the refusal's ordering ahead of `boot()`), and record the limit.

**Not covered in this file, and not coverable without a live brain:** boot, the hello, a
real dispatch, the deadline race, write serialisation, and response-size substitution.
That is design Open Question 1 and it needs `GBRAIN_DATABASE_URL` plus the pgvector
container.

---

## 3. The design doc's `SO_PEERCRED` claim — corrected, not quietly deleted

The Routing and Trust Contract claimed the helper "verifies the connecting peer's uid with
`SO_PEERCRED` / `LOCAL_PEERCRED` and refuses a mismatch." **No such code was ever written**
— a case-insensitive grep for `peercred` across `dsh/` returns nothing.

Recorded here at the right size, neither inflated nor hidden:

- On Linux an `AF_UNIX` filesystem socket **cannot** be opened by a uid other than the one
  holding write permission on it, and `paths.js` creates the socket `0600` inside a `0700`
  directory. So the check is **redundant** and its absence is **not a live hole.**
- What it *was* was a documented control that did not exist, which is the class of claim
  this family's evidence rule targets. The section now states what actually enforces
  access (the kernel, via the mode bits) and what the helper *does* verify in its place
  (that a socket file was not left by a **live** pid — the exit-3 refusal).

**Success Criterion 2 was restated** against the mode bits rather than against a uid check,
so the criterion and the code now agree.

---

## Gate results — quoted, this session

| Gate | Result |
|---|---|
| `bun run verify` (before the change) | `pass=76 fail=0 skip=0 \| all checks green`, elapsed 59s |
| `bun run verify` (**after**, with the new workflow and test on disk) | **`[verify-parallel] elapsed=79s \| pass=76 fail=0 skip=0 \| all checks green`** → exit 0 |
| `node --test dsh/test/` (before) | tests 107 · pass 107 · fail 0 |
| `node --test dsh/test/` (**after**) | **tests 114 · pass 114 · fail 0 · skipped 0** → exit 0 (Δ = +7) |
| `node --test dsh/test/engine-host.test.js` alone | 7 tests · pass 7 · fail 0 → exit 0 |
| `gen-surface.mjs --check` | exit 0 — *"14 tools; manifest and patch agree with lib/tools.js"* |
| `gen-preset.mjs --check` | exit 0 — *"our preset declares 34 top-level plugin rows"* |
| workflow-touching guards (`check-bun-test-timeout`, `check-grok-pin`, `check-opencode-pin`, `check-bootstrap-tag`) | all exit 0 |
| `bun run test` (gbrain's 1403-file suite) | **NOT COMPLETE** at time of writing — see below |
| `bun run test:full` | **NOT COMPLETE** |

### What is NOT claimed

- **`bun run test` did not finish, and was stopped.** It ran ~38 minutes across 2 shards
  and had reached only **~23 of 1403 files** (`s1 14/1403`, `s2 9/1403`) — roughly
  75 seconds per file. Extrapolated that is ~29 hours for the suite, which is far past the
  shard script's own `timeout 6000s` cap, so this run could never have gone green. It is
  **not** reported green and it is **not** reported as failing: the per-shard timeout would
  have killed it, not a test failure. The shards were alive and burning CPU (175–225%), so
  this is a slow-or-stalled environment, not a hang. **This is a finding in its own right**
  and belongs with the next session that runs this suite on a normal machine.
- **`bun run test:full` did not run at all**, because its second phase is that same unit
  suite. Separately, `DATABASE_URL` is unset, so its E2E phase **would have skipped and said
  so on stderr** — reading that as "E2E passed" would have been wrong. No E2E result is
  claimed either way.
- **The workflow has never executed.** A GitHub Actions workflow cannot run locally and
  this branch has not been pushed. Its steps were each run by hand and pass; the *wiring*
  is unverified until it runs on a push. Stated rather than implied.
- **No commit was made.** Per the session's instruction; everything above is working tree
  only.

---

## Preconditions for the deferred item, restated

`docs/DSH_FORK.md` + the two marked `AGENTS.md` insertions should be written by a session
that can also close design Open Question 1, because:

- the additivity ledger (Success Criterion 4) is strongest when it can cite a verified
  end-to-end read rather than only a green unit suite; and
- doing it twice — once now from a stub, once later against a live brain — is the cost this
  deferral avoids.
