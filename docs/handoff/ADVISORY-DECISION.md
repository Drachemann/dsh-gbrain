# Decision record — does `dsh-advisory-core` give `dsh-gbrain` anything it needs?

**Status:** RESOLVED — **no dependency in this wave.**
**Stage:** gstack pipeline Think, 2026-10-11.
**Question owner:** the `dsh-gbrain` fork.
**Governing policy:** `/home/matt/src/dsh-advisory-core/docs/handoff/ADVISORY-POLICY.md` §1, §4.
**Supersedes:** nothing. This record *re-answers* the descope in
`docs/designs/DSH_NATIVE_PLUGIN.md` § "The Advisory Seam: Descoped" on its own stated
condition, rather than inheriting it.

---

## Why this record exists at all

The approved design descoped the advisory seam on a **stated condition**:

> "…when `dsh-advisory-core` lands with a real consumer, the two plausible first uses are
> ranking two candidate symbols for a `code_def` hit and adjudicating an `ambiguous` walk
> result, and both are additions to `dsh/lib/result.js` rather than changes to tool code."
> — `docs/designs/DSH_NATIVE_PLUGIN.md`, Status: APPROVED

That condition has been met twice over: the core is built and green, and `dsh-wyrmbrain`
and `dsh-gstack` are both integrating it. So the descope can no longer be reached **by
inheritance** — it has to be re-decided on the evidence. This file is that decision.

---

## (a) The benefit question, and the evidence on both sides

**The question, stated so it can be answered no:** is there a place in `dsh-gbrain` where
an independent reading could plausibly **change what this code does** and could **genuinely
disagree** with the session that owns it — which is the policy's criterion for spending a
scarce advisory **dispatch**?

### What an advisory call is, mechanically (verified in the core's source)

`createAdvisoryCore(...).policy.routeFor(surface, context)` is the entry point
(`src/index.js:128`, `:719`). It routes into `freeAdvisory()` / `paidAdvisory()` — it
**dispatches**. Its answers are:

| Outcome | Effect |
|---|---|
| a route | one model call on the free pool, one request out of a shared per-minute allowance |
| a decline (`hold`) | nothing is sent; the policy records that a second opinion was not warranted |

Three properties matter to this decision and were read, not assumed:

1. **It needs a chain the consumer supplies.** `resolveConfig` refuses a config without
   `sources` and `profiles`; the core ships no vendor chain (`package.json`
   `exports`, `src/defaults.js`, asserted by `test/units.test.js`). Adopting it in this
   repository means the fork owns a measured free-model chain, its ordering, its tiers and
   its freshness obligation (`ADVISORY-POLICY.md` §3 requires re-running the validator as
   part of any session that composes one).
2. **The dispatch is the scarce resource, and the rate is not a knob.** `advisory.perSession`
   defaults to `8`; the free pacer is `2 / 4 per minute / 3000 ms` against a **measured
   20/min provider-account ceiling whose violation killed real sessions**
   (`ADVISORY-POLICY.md` §2). The policy is explicit that the cap may be raised and the rate
   must not be touched.
3. **One account, two consumers, one bucket.** An advisory-dispatching consumer must set
   `sharedState: true` and point at a common store directory, or two correct-looking pacers
   jointly exceed the ceiling.

### Evidence FOR taking the dependency

- **The condition in the design doc is literally met.** `dsh-advisory-core` exists with two
  real consumers, so the reason the seam was descoped ("a component that is an `AGENTS.md`
  and no application code") no longer describes the world.
- **The family instruction changed.** The operating instruction is now "use the advisory as
  much as possible inside the free rate limits".
- **Real ambiguity exists in this product.** `dsh/lib/result.js:130` renders an `ambiguous`
  walk result, and `:126` renders a `not_found` with `did_you_mean` candidates. Those are
  genuine quality moments: the graph found more than one thing that could be the answer.
- **The machinery is genuinely good and already paid for.** One budget, one ledger, one
  receipt, fail-closed egress, a health map with cooldowns. Rebuilding that locally to ask
  one question would be the worse kind of divergence.

### Evidence AGAINST taking it into this repository

- **This repository has no dispatch site.** A dispatch is worth a shared request when the
  answer changes what *the code* does. Nothing in `dsh-gbrain` raises such a question.
  `dsh/lib/result.js` is a **renderer**: it maps a value or a thrown error onto content
  blocks and decides nothing. Ranking candidates is a *presentation* choice about another
  actor's question, not an architecture choice this fork is making.
- **The reviewer's specific examples are not advisory material under the policy's own test.**
  "Which of two symbols did the user mean?" is a question about **intent**. The session that
  owns the socket has the conversation, the user's words and the earlier turns; an
  independent model has a candidate list and would be guessing at intent it cannot see. Two
  readings would not "genuinely disagree" — the second would be *less informed*. The policy's
  own words: *"Mechanics you can verify yourself are not advisory material. Neither is a
  question whose answer you would accept either way."* Here the answer is not verifiable and
  the session would not accept either way — it just has strictly less information.
- **The renderer already hands the whole decision to the model.** `summarise()` prints
  `ambiguous, N candidates — name1, name2, …` **and** `renderSuccess` appends the complete
  raw JSON envelope. `dsh/test/surface.test.js:162` pins that arm. So the model already
  receives every candidate with its fields. An advisory would not add information to the
  result; it would add a second, less-informed opinion *about* it.
- **The advisory is asynchronous relative to the tool result.** A tool `render` must return
  blocks. The dispatch is a network call on a pacer with a 3 s floor and a per-minute cap. To
  influence the result it would have to block the tool return on a rate-limited network call
  — turning a local read whose entire selling point is "free, offline, deterministic, zero
  marginal cost" (design § "What Makes This Cool") into a multi-second, allowance-consuming
  one, **per ambiguous query**. If it does not block, the model has already decided before it
  resolves, and it changed nothing.
- **A decline is roughly half of all questions** (`ADVISORY-POLICY.md` §1). So even the
  non-blocking version would, about half the time, spend a pacer slot to learn nothing.
- **"Use the advisory more" and "add a dependency inside `result.js`" are not the same ask.**
  The lever the policy actually names is the **unmetered** one: *"Jev DECISION calls are
  already effectively free and already unmetered"* and are *"the first and largest lever on
  'as much as possible'"*. That ability already reaches a session in this profile as
  `jev_decide`, with no library dependency, no chain to maintain and no state directory. A
  dependency inside `result.js` buys nothing the session-level tool does not already give,
  and buys it in the wrong place.
- **Minimal divergence is the point of the fork.** The design's whole layout exists to keep
  `git merge upstream/master` cheap; Success Criterion 4 measures additivity. This particular
  dependency would not break additivity (it lives in the fork-owned `dsh/package.json`), so
  it is a *cost*, not a violation — but it is a real cost: a chain to measure and re-validate,
  a state directory, a rate budget shared with `dsh-gstack` and `dsh-wyrmbrain`, and a
  blocking network call in a renderer. "Cheap to merge" and "cheap to run" both point the
  same way here.
- **`dsh/package.json` today declares exactly two peerDependencies** (`@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-tools`) and **zero** advisory references; a case-insensitive grep for
  `advisory|jev|second.?opinion` across `dsh/` returns nothing. The starting point is
  dependency-free, and nothing has argued it out of that.

### A datum that is evidence, not proof

A `model_second_opinion` call was made on this exact question. **It was DECLINED
(`jev-hold`)** — the core's own judge ruled that a second opinion was not warranted. Per
`ADVISORY-POLICY.md` §1 a decline is not a failure and **must never be retried**; it was not.
It is recorded here because it is a real datum about the question: the machinery built to
answer "is this worth an advisory?" answered *no* about advisories in this repository. It is
corroborating evidence, **not** the basis of the decision — the argument above stands without
it, and a decline is not an argument.

---

## (b) Does the descope's condition now being met change the answer?

**No — and this is the point of the record.**

The condition was about **existence**: "when `dsh-advisory-core` lands with a real
consumer". It is now met. But "the package exists and other things use it" is a fact about
the package, not a benefit to *this* consumer. Re-reading the condition closely, what it
licensed was *re-examining* the seam, not *adopting* it — and re-examination is exactly what
happened, with the answer coming out the same way for different and better reasons.

The original descope said "no, because the core does not exist yet". That reason has expired.
The reason now is "no, because a result builder is not a dispatch site" — which is a
**stronger** reason, because it is about the shape of this repository's surfaces rather than
about the state of a sibling's build. An expired reason and a live reason arriving at the
same answer is not the same as inheriting the answer; the second is checkable and the first
was not.

What *did* change: the seam is no longer "descoped". It is **resolved** — see (d).

---

## (c) If yes — which surface is a genuine advisory surface

**Not applicable: this is a no.** `dsh/lib/result.js` is not an advisory surface, and the
reason is structural rather than a judgement call:

- It is **stateless, side-effect-free and sliceable** — a pure function of `(op, outcome)`
  with a test per arm. A dispatch makes it stateful, async, network-dependent and
  budget-sharing.
- It runs **per ambiguous query**, i.e. it multiplies a shared scarce resource by the
  question rate rather than by the number of decisions the fork actually makes.
- It is the module that **decides nothing**; it is the module that reports.

Recorded for the next session, so this is not re-derived: if an advisory surface is ever
wanted here, the one the family already demonstrates is a **session-level tool** — the
`gstack_escalate` shape — not a function inside a renderer.

---

## (d) What would have to become true for the answer to become YES

Stated as checks, so a later session can test them rather than re-argue them. **Any one** of
these would reopen the question:

1. **`dsh-gbrain` grows a decision that is not about the user's intent and is not verifiable
   locally.** The trigger is a *tool or Host-row surface*, not a renderer: something that
   allocates a resource (a session budget, an index-sync schedule, a cache eviction), or picks
   between two designs the fork could genuinely implement either way, once per session rather
   than per query.
2. **The index-freshness decision becomes a real allocation.** Design § "Index Freshness"
   today makes staleness **advisory to the model and never automatic** — it reports
   `possibly_stale` and the operator runs `gbrain sync`. If a later wave proposes that the
   plugin *choose* whether to re-index (spend a long, expensive backfill vs. answer from a
   stale graph), that is a genuine once-per-session allocation decision with two defensible
   answers, and it is a legitimate candidate for an advisory dispatch **in the Host row**, not
   in `result.js`.
3. **A measured failure shows the candidate list is insufficient.** Concretely: an ambiguous
   `code_def` repeatedly sends the session down the wrong symbol *even though the correct one
   was in the printed candidate list*. That is evidence that the model is not the better
   ranker, and it would falsify the central premise of (a). The fix to try **first** would
   still not be an advisory: it would be to enrich the rendered candidate line (file path,
   line number, enclosing symbol), which is free, local and testable. Only if that fails does
   an advisory become a candidate.
4. **A dispatch budget already exists elsewhere in this process.** If the Host row ever
   adopts `dsh-advisory-core` for reason 1 or 2, then `sharedState: true` and the shared store
   directory become mandatory (`ADVISORY-POLICY.md` §2, one account / two buckets) — and at
   that point adding a *second* call site is a marginal decision, not a new dependency.

Also recorded plainly: if the answer ever becomes yes, the sequence is the one in
`docs/handoff/PROMPT-gbrain-restarts-with-core.md` §6 — through **Think and Plan** before any
code, then the install mechanics in `PROMPT-gstack-consumes-core.md` §6.5, then a **real**
smoke call in a new session reading the ledger for a `boot` record carrying
`coreVersion: '0.1.0'` and the `decision` record's `policyFingerprint` matching
`core.config.fingerprint`. Every test the core ships uses a stubbed endpoint; it has never
made a real call from inside a live DSH Host.

---

## What this decision is NOT

- **Not a rejection of `dsh-advisory-core`.** It is the right engine; this repository is not
  a dispatch site for it yet.
- **Not "use the advisory less".** The instruction "use it as much as possible inside the
  free limits" is honoured by the lever the policy actually names: the **unmetered Jev
  decision call**, which is session-level and needs no dependency here. This session used it
  for the classification in this very record.
- **Not a claim that the renderer is finished.** (d)(3) names a real, free, local improvement
  worth trying before any advisory is reconsidered.
- **Not a permanent answer.** It is tied to the checks in (d); if one fires, reopen it.

## Evidence ledger

| Claim | How it was established |
|---|---|
| `routeFor` **dispatches** (it is not a pure routing query) | `src/index.js:63-73,128`; `policy.js:719` routes into `freeAdvisory`/`paidAdvisory` |
| A decline is a first-class outcome and is never retried | `policy.js:553` (`decision === HOLD_CLASS`); `constants.js:27`; `ADVISORY-POLICY.md` §1 |
| The consumer must supply its own chain | `src/index.js` docblock; `resolveConfig` refuses without `sources`/`profiles`; core ships no vendor chain |
| The dispatch rate is not a knob, and violating it killed sessions | `ADVISORY-POLICY.md` §2; `src/rate-limit.js` |
| `result.js` is a pure renderer and decides nothing | `dsh/lib/result.js` (whole file; `summarise`/`renderSuccess`/`renderError`/`project`) |
| The model already receives every candidate | `result.js:130-133` prints the list; `result.js:100-101` appends the raw envelope |
| That arm is pinned by a test | `dsh/test/surface.test.js:162` — *"summarise: the three walk-result arms are distinguishable"* |
| The plugin suite is green | `node --test dsh/test/` → **107 tests, 107 pass, 0 fail** (2026-10-11) |
| No advisory dependency exists today | `dsh/package.json` (two peerDependencies, neither advisory); `grep -rniE 'advisory\|jev\|second.?opinion' dsh/` → no matches |
| The advisory tool surface is already available session-level and unmetered | `ADVISORY-POLICY.md` §1 ("already effectively free and already unmetered", defaults `0 / 0` = deliberately not binding) |
| The engine's own judge declined an advisory on this question | `model_second_opinion` → `DECLINED (jev-hold)`, this session; recorded as corroboration only |
| The code graph is local, offline and LLM-free | `docs/designs/DSH_NATIVE_PLUGIN.md` § "What Makes This Cool" |

## What could not be verified, and is therefore not claimed

- **Whether the two-named-use-cases were ever measured as a problem.** No failure record
  exists in this repository of an ambiguous `code_def` sending a session down the wrong
  symbol. So the *premise* that a ranker is needed is unmeasured in both directions — which
  is itself part of why the answer is no: the reviewer's examples were plausible uses, and
  plausibility is not evidence.
- **A real end-to-end code read through the helper.** Open Question 1 in the design remains
  open here; this record does not depend on it either way.
