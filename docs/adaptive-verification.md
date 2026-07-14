# Adaptive verification strategy (as-built)

> **Status:** SHIPPED (**M11**, branch `m11`) and live-proven. M11.0–M11.2 landed as ONE
> engine — the orchestrator DERIVES the verification method from the deliverable; there is
> no flag, no default-off, no dual path (the de-flag cut collapsed the milestone flags —
> `docs/deflag-cut-plan.md`; `docs/PRINCIPLES.md` §1 "one engine, git is the flag"). This
> doc is the design record; the sections below describe the shipped behavior.
> **Builds ON M10** (`docs/orchestrator-owned-verification.md`):
> M10 moved the verification gate UP (threads advise ↑ orchestrator gates ↑ human
> signs) and wired it **web/dev-server-centric** — a "lane" is a URL, a "critic"
> reads a DOM. M11 **generalizes the method**: verification becomes an **adaptive
> strategy the orchestrator DERIVES from the deliverable**, not a single live-critic
> default. **M11 is deliberately SMALLER than M10:** it adds **no new machinery and
> no new fail-closed invariant** — it reuses M10.1–M10.5 and every moat invariant
> **unchanged**, and mostly **reframes three existing seams**: (1) modality
> derivation, (2) establish-verification-at-any-point, (3) generalize the lane.
> **Motivating evidence:** the `loom_mrigs3zo_vxgrsr` prove-run (project
> "redemption") — a greenfield TypeScript library that parked `blocked` at the M10.4
> pre-flight, the moat holding as it did so — is now PROVEN autonomous: the
> redemption-shaped greenfield library `loom_mrjj3sch_0toxc0` DERIVED a test-gate and
> reached `ready` with no false dev-server escalation (M11.3 scenario (a), independent
> 59/0 suite).
>
> **As-built deltas beyond the original design** (M11.0–M11.2 + three live-proven fix
> rounds — findings 1–8, `docs/m11-prove-run.md` + `docs/m11-discuss-iteration.md`):
> a `verifyCommand` human-answer tier that persists as a project FACT and feeds the
> top-gate strategy; a runnable-shape guard CHAIN (validation at contract emit, at
> `ProofHint.run` emit, and at the tightening install — a non-runnable prose `expected`
> never reaches `sh -c`, and the tightening pass installs a matching runnable hint over a
> prose `expected` with an event trail); `blocked` propagates through the step runner and
> weave rollup as an awaiting-human PAUSE, never coerced into a step `failed`; a pinned
> field-semantics rule (the runnable lives in `expected`, a misplaced `observable` on a
> command/gate is rejected at validation); and the conversational escalation surface
> (Discuss) whose first turn is the AGENT's proposal, not an empty form. See §9.

---

## 1. Where this comes from

The **M10.6 prove-run** (today) is the canonical motivating case. A **greenfield
TypeScript arithmetic-expression LIBRARY** (`loom_mrigs3zo_vxgrsr`, project
"redemption", all four M10 flags on) — a pure `bun test` deliverable with no running
app — was parked **`blocked`** at the **M10.4 pre-flight lane-viability gate**. The
moat **held exactly as designed**: nothing stranded, only ~$0.28 spent, and it
**asked** rather than guessing (`parkBlockedIfLaneUnviable`, `dispatcher.ts:111-124`).
But the park exposed that M10 verification is wired for **web apps**, not **derived
from the deliverable**. Two web/test-centric wiring gaps combined to produce it:

- **Gap (a) — over-routing at contract synthesis.** `synthesizeContract`
  (`weave-contracts.ts:40-56`) maps **every** criterion to
  `type:"live-critic" / subGoalId:"ALL"` (`:53`). The **only** escape to a
  deterministic type is an **exact-string gate-name match**
  (`routing && gateNames.has(text)`, `:49`). The "redemption" manifest had
  `gates: []`, and a greenfield loom has **empty root `acceptanceCriteria`** → the
  source list falls back to `[loom.prompt]` (`:45`) → a **single** `synth-0`
  assertion, `type:"live-critic"`, `subGoalId:"ALL"`. An all-`bun test` library
  routed to **one live-critic**.
- **Gap (b) — the pre-flight then demanded a URL.** `isLaneViable`
  (`executor.ts:450-455`) treats **any** agent-judged assertion as needing a live
  target: with one live-critic, `agentJudged.length > 0` (path 1 fails), no
  `devCommand` (path 2 fails), no `servers.yaml` (path 3 fails) → `isLaneViable`
  returns **false** → the M10.4 gate parks `blocked` (`dispatcher.ts:318-325`) — even
  though `bun test` would prove the library perfectly **without any URL**.

The verdict: **correct, yet overfit.** The moat never laundered a self-reported pass,
but the machinery equated **"verifiable"** with **"a URL can be stood up NOW."** M11
is the generalization — and, like M10, it is **not** "relax the moat." It is "let the
orchestrator DERIVE the right verification method per deliverable, and keep the verdict
floor exactly as strict."

**UX note (captured as an M11 follow-up).** The **"Orchestrator requires help"**
surface (`apps/web/components/looms/blocked-escalation.tsx`) is a **FORM** with two
web-shaped inputs (a `dev command` + an optional `runbook`). The user's observation:
when a human is **unsure** what to answer, they want to **DISCUSS** it with an agent (a
conversational escalation), not fill a form that assumes they already know the dev
command. See §9.

---

## 2. Thesis & the three-point reframe

**Thesis.** The real primitive is a **VERIFICATION STRATEGY the orchestrator derives
from the deliverable** — not "lane = dev server." A library is proved by a test gate;
a CLI by running the commands and asserting on exit code / output; a data-science
deliverable by running the notebook/eval in a sandbox and **asserting on artifacts**
(accuracy ≥ threshold on a holdout, the cleaned frame has no nulls / matches a schema,
the pipeline reproduces from a seed, a figure renders) — **no server**, the "lane" is
a kernel + dataset and the "critic" reads **metrics, not a DOM**; a web app by the
existing live-critic; an API/DB by boot + hit endpoints / run migrations. M11 makes
the proposer **DERIVE the right method per deliverable/criterion** and **HONOR the
charter's proof intent**, instead of defaulting to a single live-critic.

**The reframe, in three points (each maps to one execution phase in §8):**

1. **Modality derivation.** The verification MODALITY is chosen *from the deliverable*
   (charter `proofStrategy` + a cheap project-type signal), not defaulted to
   live-critic. Web → live-critic; library → gate/command (`bun test`); CLI → command
   (run + assert exit/output); data-science → command whose runnable is a sandbox
   harness asserting on artifacts; API/DB → the existing `db`/command + live path.

2. **Establish verification at ANY point — proceed-and-defer, escalate-last-resort.**
   For anything that "will lead to something testable," the testable artifact only
   exists **after** the work. So the orchestrator sets up (and revises) the method
   **WHEN THE ARTIFACT APPEARS**, never demanded up front. The M10.4 pre-flight
   reframes from *"is a lane viable RIGHT NOW? block if not"* to *"can I form a PLAN
   to verify this at all?"* — proceed (defer establishment) when yes; blocking/asking
   the human becomes the **last resort** (genuinely stuck, after trying + reporting
   what it tried), not the first gate. Greenfield, DS, CLI, library all just PROCEED.

3. **Generalize the lane** to non-server verification strategies (kernel+dataset, CLI
   harness, sandbox eval, metric/output/schema assertions), **established when the
   artifact exists**. M10.3 already abstracts dev server / DB / service / MCP; M11
   extends the strategy **set** beyond "stand up a URL."

**The load-bearing constraint (§4).** The orchestrator gets freedom in the **METHOD**,
**never** in the **VERDICT**. A flexible or mis-derived method can never rubber-stamp
— the worst it can do is produce **no evidence**, which fail-closes to *"I could not
verify this → over to you."*

---

## 3. The model — grounded in the code that changes

### 3.1 Verification STRATEGY derived from the deliverable
Today the derivation **dies between the charter and the contract**. The LLM charter
proposer (`draftCharter`, `scoping.ts:122-193`) emits a `Charter` carrying proof
intent — `Charter.proofStrategy` + each `SubGoal.proofStrategy` (an enum) + prose
`acceptanceCriteria[]` (`scoping.ts:169-179`). But that intent is **prompt-shaped, not
structural**: `PROOF_TEMPLATES` map each `ProofStrategy → {guidance, verifyMechanism:
'gate'|'verifier'|'human-signoff'}` (`proof-templates.ts:7-12, 14-60`), and
`verifyMechanism` — the closest existing "modality" signal — is **PROMPT-ONLY**
(`proof-templates.ts:74-89`: never stored on a `ContractAssertion`, never consumed by
`synthesizeContract`). The structural fix was "reserved for M10.5" (`:74-78`), but
M10.5 delivered only the **narrow exact-gate-name tightening** (`weave-contracts.ts:49`).

- **The seam where intent is discarded.** After scoping, `loom.charter` is set
  (`dispatcher.ts:664`) and `dispatchExecution` synthesizes the ROOT contract at the
  **universal choke point** `dispatcher.ts:296-300`
  (`readContract` null → `synthesizeContract(loom, manifest)` → `writeContract`).
  Because `synthesizeContract` reads only `loom` prose (`weave-contracts.ts:44-45`),
  the Charter's per-SubGoal `proofStrategy` + `acceptanceCriteria` reach only child
  spawn (`dispatcher.ts:372, 389`) and the child's **legacy** fallback
  (`wireChildBundle`, `weave-contracts.ts:99-101`). **`charter.proofStrategy` never
  reaches the ROOT contract** — the whole proof-derivation intent is dropped.
- **What M11 does (shipped).** `synthesizeContract` **derives the assertion TYPE from
  the deliverable** (charter `proofStrategy` + a cheap project-type signal — a
  `bun test`/`package.json` test script, a CLI bin, a notebook/dataset). A library with a
  test script → a `command`/`gate` assertion (the type already exists,
  `schemas.ts:488-489`; run by `runContractGates`, `executor.ts:457+`) **NOT** a
  live-critic. The `PROOF_TEMPLATES.verifyMechanism` signal is now **structural**, not
  prompt-only. When no signal/hint applies, a criterion stays live-critic/exact-name-gate
  exactly as `weave-contracts.ts:53` before — the derivation only ever **tightens**.

### 3.2 Establish at any point — the pre-flight becomes proceed-and-defer
Today the pre-flight (`dispatcher.ts:304-325`) asks *"is a lane viable RIGHT NOW?"* via
`isLaneViable` (`executor.ts:450-455`), and parks-first if not. Its three "viable"
paths — `agentJudged.length === 0` (all-deterministic), `manifest.devCommand`, or
`resolveServersConfig(root).driver !== "none"` — **all encode the web/dev-server
assumption**. A testable-later library/CLI/DS deliverable satisfies none.

- **What M11 changes.** Reframe the predicate to **"can I form a PLAN to verify this
  at all — now or after the build?"** The single most important consequence is
  **already reachable for free** once §3.1 lands: a correctly-derived library contract
  is **all-deterministic** → `agentJudged.length === 0` → `isLaneViable` returns
  **true** via its **existing** path 1 (`executor.ts:452`) → the pre-flight **no longer
  parks** → the library PROCEEDS and the top gate settles it on `bun test` exit code,
  fail-closed. **Correct modality derivation alone unblocks greenfield library/CLI/DS
  without touching the pre-flight logic.** The park
  (`parkBlockedIfLaneUnviable`, `dispatcher.ts:111`) becomes the **LAST RESORT**:
  reached only when **no** plan of any kind can be formed and the criterion is
  genuinely un-automatable (true subjective quality, credentials/secrets), after the
  orchestrator tried and reported what it tried.
- **The escalation copy is web-shaped and must derive.** The park's hardcoded question
  — *"How do I run this app? Give me a dev command (e.g. `bun run dev`) or a servers
  recipe"* (`dispatcher.ts:117-119`) — is the **wrong question** for a library/CLI/DS
  deliverable. M11 makes the escalation copy **strategy-derived** (a test command, an
  eval threshold) and makes the park the last resort, not the pre-flight default.

### 3.3 The verification lane = a STRATEGY SET, established when the artifact exists
M10.3 already generalized the lane runtime — `frozenLaneVerify` stands the lane up
inside the frozen worktree `wt` (`verify-thread.ts:146-162`): `resolveCfg(wt, root)` →
`startLane` → `laneTarget` URL → `runIntegrationVerify(loom, manifest, {verifyCwd: wt,
url})`. But the whole establishment path **assumes a `ServersConfig → Lane →
target-URL`**: `laneTarget` is URL-shaped (`run-server.ts:228-232` — named app
service's url, else the first with a url, else `undefined`), and `startLane`
short-circuits to a **no-op empty lane** when `driver === "none"`
(`run-server.ts:515-518`).

- **What M11 changes.** Introduce a **VerificationStrategy** abstraction (a
  discriminated union: `server-lane | test-gate | cli-harness | sandbox-eval |
  artifact-assert`), established inside `frozenLaneVerify` — which **already owns** the
  frozen worktree `wt`. For a **server** strategy, keep today's path verbatim. For a
  **non-server** strategy, the frozen `wt` **is already the substrate**: run the
  strategy's deterministic assertions via `runContractGates` against `wt`
  (`executor.ts:457+`), producing `GateResult[]` as **evidence**, with
  `target = undefined` and **no `startLane` call** (the empty-lane short-circuit,
  `run-server.ts:516`, already no-ops). For a strategy that must stand a **process**
  up (a kernel+dataset for DS), reuse `superviseStartLane`'s executor/setup-wall model
  (`verify-lane.ts:48-86`): spawn/re-run behind the wall, never touching a verdict. The
  strategy is chosen from the same deliverable signal as §3.1 and is **revisable** —
  established **WHEN the artifact appears**, not demanded up front.
- **No new AssertionType is required for the minimal fix.** The DS "assert on
  metrics/artifacts" modality is **already expressible** as `command`/`gate` +
  `expected` where the runnable is a sandbox harness whose **exit code** encodes the
  assertion (accuracy ≥ threshold, no nulls, schema match) → routes deterministic,
  gates fail-closed. `ProjectManifest` (`schemas.ts:220-359`) has **no** projectType
  field, so modality is **derived**, not looked up. A dedicated `metric`/`sandbox`
  enum member (`schemas.ts:479`) is an **optional later additive** for richer
  expected-shape validation.

### 3.4 The strategy taxonomy
| Deliverable | Derived strategy | Established as | AssertionType (exists today) |
|---|---|---|---|
| **Web app** | live-critic over the assembled UI | `startLane` → target URL (`verify-thread.ts:146-162`) | `live-critic` (`schemas.ts:484`) |
| **Library / package** | a test gate (`bun test`) | `runContractGates` against `wt`, no URL | `command`/`gate` (`schemas.ts:488-489`) |
| **CLI** | run the commands; assert exit code / output | `runContractGates` against `wt`, no URL | `command` (`schemas.ts:488`) |
| **Data-science** | run notebook/eval in a sandbox; assert on artifacts | sandbox harness behind the setup wall; exit code encodes the assertion | `command` (+ optional `metric`/`sandbox` later) |
| **API / DB** | boot + hit endpoints / run migrations | `startLane` (DB + service) → target, `db` runnables | `db`/`command` + `live-critic` (`schemas.ts:490`) |

---

## 4. THE INVARIANT — freedom in the METHOD, never in the VERDICT (sacred)

This is the crux that keeps flexibility safe, and it must stay central. M11 adds
strategy freedom to the **proposer/executor** side; the **verdict floor is quoted, not
modified.** A flexible, weak, or mis-derived method **cannot rubber-stamp** — the worst
it can do is produce **NO evidence**, which the existing floor coerces to a demoting
fail. **You cannot get a BAD deliverable out of more flexibility; you can only get an
honest "could not prove it."** Flexibility lives **ABOVE** the verdict floor, never
**THROUGH** it. Enumerated M10 invariants that carry over **verbatim**:

1. **The top-gate fail-closed coercion.** `runIntegrationVerify`
   (`executor.ts:1157-1160`): `if (opts.fullContract && pv.panelRequired && verification
   === "skip") { verification = "fail"; … }`. A flexible/weak/absent strategy that
   yields a `panelRequired` skip is **coerced to a demoting fail**. Reachable only when
   `fullContract` is set (the orchestrator producer). Byte-identical off. **UNCHANGED.**
2. **The no-target fail-closed floor.** `runPanelVerification`
   (`executor.ts:552-566`): when `agentJudged.length > 0` and `!target`, it emits a null
   panel and returns `panelRequired: true` **unconditionally** (`:560-566` — "a divert
   that proposes nothing viable still lands the honest needs-review terminal"). A
   strategy that fails to produce a target is already a fail-closed skip. **UNCHANGED.**
3. **The read-only JUDGE WALL.** The verifier and every critic load only
   `VERIFIER_TOOLS` under `restrictTools:true` + a `Write/Edit/MultiEdit/Bash/
   NotebookEdit/Agent` denylist (`verifier.ts:18-35, 234-261`; `critic.ts:200-202`).
   The judge only ever **receives** a target/context; it cannot spawn, restart, edit an
   assertion, or relax a gate. A DS "critic that reads metrics" or a CLI evidence reader
   sits behind the **same** restriction — it reads `GateResult`s/artifacts, never
   mutates. **UNCHANGED.**
4. **The gate only keeps or demotes — never authors `done`.** The whole-verification
   may keep `ready` or demote to `needs-review`; `ready → done` stays the human
   `acceptLoom` click. **UNCHANGED.**
5. **`validateContract`'s hard-gate floor.** A synthesized contract that emits
   `gate`/`command` assertions **satisfies** the floor honestly (better than an
   all-live-critic remainder). The `synthesized` flag is still carried
   (`weave-contracts.ts:55, 92`; `schemas.ts:516+`), and `subjective:true` stays legal
   **only** on `type:"live-critic"` (`schemas.ts:503-513`) — a derived `gate`/`command`
   must never carry a subjective marker. **UNCHANGED.**

**What relaxes (and only this):** the *method* a criterion is verified by — which
`AssertionType` it becomes, which lane it routes to. The derivation only ever
**TIGHTENS** live-critic → gate/command (the same direction `contractLoosenings` never
flags; a `gate → live-critic` weakening is forbidden). A criterion it cannot map to a
runnable **stays live-critic** — today's exact behavior, worst case unchanged.

---

## 5. Generality — the model serves every deliverable

| Scenario | How the adaptive model serves it |
|---|---|
| **Greenfield library** (the `loom_mrigs3zo_vxgrsr` prove-run) | Derivation emits a `gate`/`command` (`expected = bun test`) instead of `synth-0` live-critic → `isDeterministic` true (`executor.ts:387-389`) → `agentJudged` empty → `isLaneViable` returns true via path 1 (`:452`) → the pre-flight **no longer parks** (`dispatcher.ts:318-325`) → the library **PROCEEDS** and the top gate settles it on `bun test` exit code, fail-closed. **Directly fixes both prove-run gaps.** |
| **Greenfield web app** | Derives `live-critic`; the M10.3 lane (`startLane` → target URL, `verify-thread.ts:146-162`) is established when the UI exists. Unchanged from M10. |
| **CLI** | Derives `command` assertions (run + assert exit/output); all-deterministic → the panel is skipped, green gates alone drive the top gate, autonomous. No URL. |
| **Data-science** | Derives `command` whose runnable is a **sandbox harness** asserting on artifacts (accuracy ≥ threshold, cleaned frame has no nulls / schema-match, figure renders). The "lane" is a kernel + dataset behind the setup wall (`verify-lane.ts:48-86`); the "critic" reads metrics, not a DOM. No new AssertionType needed. |
| **API + DB** | Derives the existing `db`/`command` + live path; the M10.3 lane stands up DB + service, migrations run, endpoints are hit. Unchanged from M10. |
| **Pure refactor** | Regression IS the whole job — the derived strategy is the existing suite over the composed whole; completeness is "behavior preserved." |
| **Subjective quality** ("premium feel") | Objective slice auto-verifies via the derived method; taste → the human final accept (M10.5 `humanJudged` bucket, `executor.ts:426-439`). Never a machine gate, never a faked check. |

---

## 6. Why M11 is SMALLER than M10

M10 **moved the gate** (new top-gate producer, new `blocked`-as-output, new lane
runtime, new escalation surface). M11 **adds no new machinery and no new fail-closed
invariant** — it **reuses M10.1–M10.5 wholesale** and mostly **reframes three existing
seams**:

- The **deterministic primitives already exist**: `AssertionType` already spans
  `command`/`gate`/`db` (`schemas.ts:488-490`), `isDeterministic` already routes them
  to the gate layer (`executor.ts:384-395`), and `runContractGates` already runs them
  fail-closed. M11 needs the **PROPOSER to emit them** for non-web deliverables — not
  new verification machinery.
- The **pre-flight reframe widens the true-branch of `isLaneViable`** — correct
  derivation (§3.1) makes path 1 fire for a library **without touching the pre-flight
  logic at all**.
- The **lane generalization slots strategy variants inside `frozenLaneVerify`**, whose
  frozen `wt` is already the substrate.
- The **verdict floor** (top-gate coercion `executor.ts:1157-1160`, no-target skip
  `:552-566`, the read-only wall `verifier.ts:237` / `critic.ts:201`) is **quoted,
  not modified.**

No new machinery, no new fail-closed invariant — the derivation and the strategy set are
the whole of M11, and they are now the sole path for every project.

---

## 7. Execution plan (M11.0–M11.3) — AS BUILT

Each phase landed **fail-closed, independently green-gated, committed as its own atomic
unit** (M11.0 `68b39fd`, M11.1 `aa0122d`, M11.2 `734f556`; base green 1033/0, 86 new
tests across 5 files), then was live-proven across three fix rounds (§9,
`docs/m11-prove-run.md`). There is no flag — the engine derives the method for every
registered project.

> **SEQUENCING (as built).** M11.0 (pre-flight reframe) is the smallest and fixed the
> original block, but its *full* power depends on M11.1 (correct derivation) to make
> path 1 fire — the two are complementary. M11.0 made the pre-flight proceed-and-defer
> safe; M11.1 made the derivation emit deterministic assertions; M11.2 established
> non-server strategies when the artifact exists. M11.3 is the live proof that the derived
> methods hold fail-closed on real deliverables.

### ✅ M11.0 — Pre-flight reframe: proceed-and-defer + escalate-last-resort (`68b39fd`)
- **Goal.** Reframe the M10.4 pre-flight from *"is a lane viable NOW? park if not"* to
  *"can I form a PLAN to verify this at all?"* — proceed and defer establishment;
  make the park the last resort. **Smallest phase; the fix that unblocks today's run.**
- **Seams.** `isLaneViable` (`executor.ts:450-455`) — widen the true-branch with a
  third "a derivable non-server strategy exists" path (detected from the same
  deliverable signal as M11.1, a **pure** read — no spend, honoring the
  `executor.ts:448` "cannot loop or spawn" comment); the pre-flight gate
  (`dispatcher.ts:318-325`) parks **only** when no plan of any kind can be formed and
  the criterion is genuinely un-automatable; the park copy
  (`parkBlockedIfLaneUnviable`, `dispatcher.ts:111-124`) becomes strategy-derived.
- **Tests.** A library/CLI/DS contract returns `canPlan = true` and PROCEEDS (never
  parks); a genuinely un-automatable criterion still parks with a **strategy-specific**
  question; the pre-flight introduces **no spend** before the decision; `setupAgent`
  and the new proceed-path don't double-fire.
- **Done when.** Green-gate clean; the greenfield library no longer parks; the park is
  reachable only as a last resort; no autonomous path reaches `done`.
- **Size.** **S** — a widening of one pure predicate + the gate condition + the copy.

### ✅ M11.1 — Modality derivation (right method per deliverable, honor `proofStrategy`) (`aa0122d`)
- **Goal.** Make `synthesizeContract` **derive** the assertion type from the deliverable
  and **honor** the charter's proof intent — completing the M10.5 routing the header
  comment reserved (`weave-contracts.ts:26-39`, `proof-templates.ts:74-78`).
- **Seams.** Widen `synthesizeContract`'s already-optional `manifest?` param
  (`weave-contracts.ts:40-43`) into an options object carrying `charter.proofStrategy`
  + per-criterion hints (existing callers stay byte-identical — the param is optional
  and existing tests pass a bare `{gates}` or nothing); flag-on, emit
  `{type:"gate"|"command", expected:run}` instead of the blanket live-critic
  (`weave-contracts.ts:53`); make `PROOF_TEMPLATES.verifyMechanism`
  (`proof-templates.ts:7-12`) **structural**; optionally have `draftCharter`
  (`scoping.ts:169`) emit a per-criterion proof hint. Fix once at the choke point
  `dispatcher.ts:296-300` and it propagates via `wireChildBundle` to every child slice.
- **Landed.** `synthesizeContract` derives the assertion type from the deliverable —
  charter-authored per-criterion `proofHints` → `command`, a test-gate signal → the
  lockfile-aware test runnable for every remaining criterion; tightening only, web never
  blanket-tightened, no runnable ever fabricated from prose.
- **Tests.** An all-`bun test` library → a `gate`/`command` assertion (not synth-0
  live-critic); a CLI → a `command` asserting exit/output; the derivation only
  **tightens** live-critic → gate/command (never gate → live-critic); a criterion it
  can't map stays live-critic; `subjective:true` never rides a derived gate
  (`schemas.ts:503-513`); a criterion with no signal/hint maps live-critic/ALL exactly as
  `weave-contracts.ts:53` before (m1-forced-contracts / weave-planner / contract tests green).
- **Done when.** Green-gate clean; the "redemption" library's charter yields a
  deterministic contract; `isLaneViable` path 1 fires; the top gate settles it on the
  gate exit code, fail-closed.
- **Size.** **M** — the proposer signature + the derivation + honoring `proofStrategy`.

### ✅ M11.2 — Generalize the lane to non-server VerificationStrategies (`734f556`)
- **Goal.** Establish non-server strategies (test-gate / CLI-harness / sandbox-eval /
  artifact-assert) **when the artifact exists**, inside the frozen worktree.
- **Seams.** A `VerificationStrategy` discriminated union established in
  `frozenLaneVerify` (`verify-thread.ts:146-162`): server strategy keeps today's
  `resolveServersConfig → startLane → laneTarget URL` verbatim; non-server strategy
  runs `runContractGates` against `wt` (`executor.ts:457+`) with `target = undefined`
  and no `startLane` (the empty-lane short-circuit, `run-server.ts:516`, already
  no-ops); a process-standing strategy (DS kernel) reuses `superviseStartLane`'s
  executor/setup wall (`verify-lane.ts:48-86`). Any bring-up that can throw is wrapped
  in the **same** `failClosedLaneDown` guard (`verify-thread.ts:146-159`) so a strategy
  error becomes `target = undefined`, never a false green.
- **Landed.** `verification-strategy.ts` union (server-lane | test-gate | cli-harness |
  sandbox-eval | artifact-assert) + a pure chooser; web / any resolvable servers recipe
  stay server-lane verbatim; a non-server strategy stands nothing up and hands the panel
  no stale URL target.
- **Tests.** A library strategy produces `GateResult[]` from `wt` with no URL; a DS
  sandbox strategy asserts on artifacts behind the read-only wall; a strategy bring-up
  throw fail-closes to no-target (demotes, never false-green); the lane tears down in
  `finally` (`verify-thread.ts:168-172`).
- **Done when.** Green-gate clean; a non-server deliverable reaches a real verification
  autonomously; establishment happens when the artifact exists; the judge wall untouched.
- **Size.** **M** — the strategy union + establishment inside `frozenLaneVerify`.

### ▶ M11.3 — Prove on real deliverables (interactive)
- **Goal.** Live-validate on real scenarios and confirm fail-closed holds at the
  orchestrator under adaptive derivation. There is no default to flip — the engine
  derives the method for every project; this milestone is the live proof.
  **Interactive — needs a real run.**
- **Scenarios.** (a) **PROVEN** — a greenfield `bun test` library
  (`loom_mrjj3sch_0toxc0`, redemption-shaped) DERIVED a test-gate and reached autonomous
  `ready` with no false dev-server escalation (independent 59/0 suite);
  (b) *remaining* a CLI deliverable → command gates alone drive the top gate;
  (c) *remaining* a DS eval → sandbox artifact assertions;
  (d) *remaining* a weak-strategy demotion — confirm a **mis-derived / weak** strategy
  still demotes a genuinely-unproven whole (inject a case where no evidence is
  obtainable → `panelRequired` skip → coercion `executor.ts:1157-1160` → `needs-review`).
- **Done when.** Fail-closed demonstrably holds at the orchestrator (a weak method
  produces an honest "could not prove it", never a rubber-stamp) and each remaining
  scenario reaches `ready` autonomously where it deserves it. The flag-flip question is
  **SUPERSEDED** by the de-flag cut (`docs/deflag-cut-plan.md`): the derivation is
  already the sole engine path.
- **Size.** **S** — interactive, no new build surface.

### Process (every phase — the invariants the pass must hold)
- **Green-gate before every commit:** `NODE_OPTIONS= bun test packages/core` (0 fail);
  `NODE_OPTIONS= bunx tsc -p packages/core/tsconfig.json --noEmit`;
  `NODE_OPTIONS= bunx tsc -p apps/web/tsconfig.json --noEmit`.
- **Verdict floor (never weaken — §4):** the top-gate coercion (`executor.ts:1157-1160`),
  the no-target skip (`:552-566`), and the read-only wall (`verifier.ts:237`,
  `critic.ts:201`) are quoted-unchanged. Derivation touches only the METHOD.
- **Tightening is one-directional:** live-critic → gate/command only; never
  gate → live-critic (a loosening `contractLoosenings` would flag).
- **Build hygiene:** `NODE_OPTIONS=` prefix on all bun/bunx/tsc; never touch
  `.env`/secrets/lockfiles; **do NOT run `git commit`**; the only WRITE this pass is
  this doc.

---

## 8. Open questions & risks

- **Sandboxing untrusted eval (DS).** Running a notebook/eval means executing project
  code the orchestrator did not author, on a dataset. Mitigation: the judge wall stays
  read-only (`verifier.ts:237`, `critic.ts:201`); establishment runs behind the
  executor/setup wall (`verify-lane.ts:48-86`); the harness runs in the frozen worktree
  and tears down in `finally` (`verify-thread.ts:168-172`). **Open:** the isolation
  boundary for a genuinely untrusted DS harness (network/filesystem/GPU), and a bounded
  wall-clock/cost clamp for a runaway eval.
- **How the orchestrator INFERS project type.** `ProjectManifest` has **no**
  projectType field (`schemas.ts:220-359`); `ProofStrategy` is a *planning* strategy,
  not a verification modality (`schemas.ts:398-399`). Derivation must key off the
  charter `proofStrategy` + a cheap deliverable signal (a test script, a CLI bin, a
  notebook/dataset). **Open:** the exact signal set and its precedence, and whether it
  should be a **pure** filesystem read (required for the M11.0 no-spend guarantee) or a
  richer charter-authored hint. A greenfield library with empty `acceptanceCriteria`
  produces an empty-criteria subgoal (`singleThreadDecomposition`,
  `dispatcher.ts:131-137`), so the derivation must key off the DELIVERABLE, not just
  criterion prose.
- **Where deferred establishment could still strand.** Proceed-and-defer means the
  artifact-time establishment can still fail (a sandbox that won't boot, a test harness
  that won't build). That path must fail-closed via `failClosedLaneDown`
  (`verify-thread.ts:146-159`) → `panelRequired` skip → coercion → `needs-review`, and
  then escalate as a **last resort**. **Open:** the mid-run escalation copy and how a
  deferred-establishment failure distinguishes "genuinely un-automatable" from
  "transiently broken."
- **The conversational-escalation surface (the user's UX note).** `answerBlocked`
  (`dispatcher.ts:785-829`) accepts **only** `devCommand` or `servers` as
  viability-making (`:801` — a runbook-alone answer is rejected, deliberately, to avoid
  a re-park loop); the cockpit form (`blocked-escalation.tsx`) has two web-shaped
  inputs. M11 must widen `answerBlocked` to accept a **strategy** answer (a test/eval
  command, a threshold) persisted to the same tiers (`.telar` + `telar.yaml` promotion,
  `dispatcher.ts:808-822`) so a future loom never re-asks. **Follow-up:** a
  **conversational** escalation mode — when the human is unsure, a chat with an agent
  that helps them articulate the verification method, then distills it into the same
  persist tiers — replacing the assume-you-know-the-dev-command form for genuinely
  un-automatable criteria (true subjective quality, credentials/secrets).
- **Accept-guard consistency.** If M11 lets a strategy answer clear the gate, the
  `answerBlocked` accept-guard (`dispatcher.ts:801`) must stay consistent with whatever
  the reframed `isLaneViable`/`canPlanVerification` reads — otherwise the
  accepted-but-never-resolves loop the guard was built to prevent returns.
