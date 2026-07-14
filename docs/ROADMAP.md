# Telar — Roadmap to Completion

> **`docs/PRINCIPLES.md` (the Loom Doctrine) is AUTHORITATIVE.** Where this roadmap and
> the doctrine disagree, the doctrine wins and the roadmap is the defect. This file is the
> single source of truth for *what's left to build*, not for *how the engine behaves* —
> that is the doctrine's. In particular: there is ONE engine and no behavior flags,
> defaults, or dual paths (§1); the historical "flag-gated / prove & flip" milestone
> framing below is retained only as shipped HISTORY — every such flag has since been
> COLLAPSED to the sole engine path by the de-flag cut (`docs/deflag-cut-plan.md`).

> **Thesis:** Generation is solved; **verification is the moat.** A loom never
> auto-accepts its own work — a human accepts, always. Everything below serves
> making that trustworthy, observable, and drivable from where you work.

**Definition of done (the product):** you hand Telar a real multi-issue objective;
it fans out into Threads under a real orchestrator; you *see why* each decision was
made and each Thread passed or stalled; you steer/accept/reject from a chat that
knows the loom; nothing reaches `done` without your sign-off; and it keeps running
if you reload or walk away.

## How to read this file

This is the **single source of truth** for what's left (it replaces the todo list).
Work is organized as **milestones**, not phases-of-phases. Each milestone is a
**single, whole build pass** (one orchestrated workflow: design → implement →
adversarially verify → integrate), sized to land a coherent, shippable capability —
not an incremental sliver. Execute them **top to bottom**; the order respects
dependencies. The `▶` marks the current milestone.

> **Status:** M1–M6 shipped (`d7d8064` → `b2e1f2a`); **M8 shipped** (`0f74ff7` →
> `929e44d`) — the moat fails *closed* by default and worktrees
> snapshot-then-remove (no leaks, no lost work); **M7 (env-review) shipped** —
> rebuilt on the fail-closed base with the E10 child/root propagation fixed in
> `rollupWeave` and the proposer hardened read-only. **New direction — M9: threads
> become workflows** (▶ aligning via design + diagram; see `thread-as-workflow.md`):
> a thread should be a multi-agent workflow (N steps × M agents), not a single-agent
> build loop. After M9: **moat-edge hardening + housekeeping**, then
> **live-validation** (M4 Postgres / M5 durability / M6 fan-out / M7 & M8
> flag-flips — driven interactively, not by a build workflow). The
> wide **conceptual investigation** of where Telar's *idea*, implementation,
> and UIs should go next is done (see `scratchpad/telar-vision.md` → the
> Contract Ledger is the flagship). The dynamic weaver (P4) stays deferred.

**The moat is invariant across every milestone:** a green verify only lands a loom
`ready` (never `done`); `ready → done` is a human click; the verifier is read-only;
there is no `accept_loom`.

---

## ✅ Shipped (foundation — do not rebuild)

- **Orchestration is real for every loom.** A plain custom loom is a *weave of one*:
  it routes through the same weaver every epic uses, with a deterministic
  single-subgoal charter (no planner LLM). Repair leg + moat live inside the child.
- **The weaver reports its reasoning.** `tick()` returns `{decision, rationale}`
  (stays pure) — critical-path scores, the binding fan-out term, a budget/clock
  snapshot, and any rejected-decision reason — plus `plan`/`observe` events.
- **The loom cockpit.** The detail page is a tabbed cockpit — **Orchestrator**
  (charter + the centerpiece: loop, plan-as-living-graph, click-to-explain decision
  timeline), **Threads** (the weave of operator cards), **Verify** / **Chat**
  (honest stubs, filled by M1 / M2). Header + accept/steer/reject rail + moat are
  persistent across tabs.
- **Verification, first pass.** Deterministic assertion routing (command/gate/db —
  a backend loom verifies with no browser); a red integration verdict demotes a
  woven loom `ready → needs-review`; tick escalates only on *terminal* failure.
- **Repair leg proven live** — builder → verify(fail) → repair → verify(pass) →
  ready, on a real task (verifier never sees acceptanceCriteria).
- **Environment lane substrate** — `servers.yaml` schema+loader, `startLane` with a
  real `readyCheck`, service supervisor (health/restart/crash-loop/mid-edit).
- **Drive from the session** — `steer/reject/resume/cancel` MCP tools (no
  `accept`), v1 client-driven watchers.
- **MCP OAuth** (Stages A+B, `ui-live-feeds` branch — pending merge) — Telar owns
  the login; verifier+critic get the project's read-only servers.
- **Repeatable greenfield E2E harness** — empty dir → orchestrated, spec'd,
  contract-verified minimal Next.js app → `ready` → self-teardown.
- Boot/crash recovery (`reconcileStuckLooms`), self-healing manifest cache,
  liftable turn cap, override-from-any-stranded-state, concise rendered report.

---

## ✅ M1 — Verification: mandatory, and you can watch it  ·  *shipped `d7d8064`*

*The moat and your original ask ("how can I see the verifier's process?"). Fills the
**Verify** tab stub.*

- **Force a Verification Contract on every loom.** No loom runs without a spec —
  the contract is a creation-time invariant, not an optional path. Contractless
  custom looms get a synthesized minimal contract from their acceptanceCriteria.
- **Capture the verifier's process as events.** The verifier emits its steps like a
  builder transcript (what it checked, what it observed in the running app, each
  gate result, each critic finding + evidence, its verdict reasoning) to the loom's
  event log.
- **Build the Verify tab.** Render that process: the contract's assertions, the
  gate run, the critic panel (findings + evidence, must-clear vs advisory), and the
  final verdict — for the root's integration verify *and* per-Thread verifies.
- **Full integration re-verify on every loom** (was Fork A) — now unblocked by the
  forced contract: the end-of-orchestration `ALL` verify runs for every loom, not
  just ones that happened to carry a contract.

**Done when:** you cannot create a loom without a contract; the Verify tab shows a
real, replayable verifier process for a finished loom; a red verdict still gates the
terminal state. Green-gate: core tests + core/web tsc.

## ✅ M2 — Drive the weave: steer & inspect  ·  *shipped `7888040`*

*Finishes the cockpit. Fills the **Chat** tab stub.*

- **Chat tab** — steer the orchestrator in a session pre-loaded with the loom's
  context (charter, plan, live decisions). Ask "what's going on"; nudge the weave.
  Reuses the session→loom control tools (steer/reject/resume/cancel — never accept).
- **Agent-session inspection** — the agent drawer shows each agent's real session
  (builder + fan-out pieces + critics), resumable, with an honest "not captured"
  state where a transcript genuinely isn't persisted.

**Done when:** you can open a Chat tab that already knows the loom and steer it, and
open any operator to read its actual session. Green-gate as above.

## ✅ M3 — Isolated, consolidated deliverables  ·  *shipped `ec9f7fa`; **live-validated** ✓ (isolateWorktrees on, real loom: isolated worktree → consolidation branch → clean main → `ready`)*

*The work product is clean and reviewable.*

- **Per-loom worktree isolation** — each loom (and its Threads) builds in its own
  git worktree @ a base commit, so parallel builders never collide in a shared tree.
- **Consolidation on completion** — a finished loom's work gathers into a single
  final branch/deliverable, ready to review as one diff.

**Done when:** a woven loom builds in isolation and lands as one consolidated branch;
no cross-loom file collisions. (Foundation for the frozen-lane verify in M4.)

## ✅ M4 — Close the verification loop  ·  *shipped `0bb00f8` (flag off; live-DB deferred)*

*Build the deterministic scaffolding + guards autonomously; the live proof needs a
real Postgres and is runaway-prone, so validate the loop with a human in the seat.*

- **Frozen-lane verify thread** — promote the integration verify to a scheduled
  **read-only thread-kind** on a frozen lane (worktree @ commit + template-cloned
  DB): gates → evidence → panel → synthesis.
- **Checkpoint verify threads** per `subGoalId` — interleaved per-SubGoal verifies
  plus the final `ALL` integration verify.
- **Auto-repair loop + convergence guards** — verify → repair → re-verify, bounded
  by budget + max-iterations + progress/regression detection + a human circuit-breaker.

**Done when:** the loop converges on a real project under guards, and the moat holds
(a green loop lands `ready`, never `done`).

## ✅ M5 — Durable, out-of-process execution  ·  *shipped `c54ae19` (flag off; live-durability deferred)*

*A reload or a code edit must not kill in-flight work.*

- **`telar-runner`** — move execution out of the web dev-server process
  (see `phase-2-runner-plan.md`).
- **Setup agent** (pre-loom `preparing` state) — bring the env up, diagnose, author
  a missing `servers.yaml`, fast-path the `readyCheck`.

**Done when:** a loom survives a web reload; a project with no `servers.yaml` is
brought up by the setup agent.

## ✅ M6 — Scale the weave  ·  *shipped `b2e1f2a` (fan-out flag off; dynamic weaver deferred)*

- **Sub-thread build fan-out** — wire `splitBuild`/`decideBuildFanout` so a Thread
  can use N parallel builders (built, never wired).
- **Disjoint-partition rule** — each builder owns non-overlapping files (or
  sequential steps, one writer each) so mutating multi-agent threads don't collide.
- **Dynamic weaver (P4)** — methodology-neutral decomposition; the Verification
  Contract is the proof, not an enumerated strategy.
- **Curated agent roster** — via the SDK `agents` option.

## ▶ M8 — Trustworthy by default: the moat fails *closed* and cleans up

*From the wide critique (66 findings; see `scratchpad/critique-report.md`). The moat's
**gate** holds (a human always accepts the deliverable) but its **verification** is
hollow for the common case — and the isolation substrate leaks worktrees. M8 makes the
defaults honest and tidy. All changes preserve the invariant: green → `ready` (never
`done`), `ready → done` is a human click, the verifier is read-only.*

- **Verification fails *closed* (E2/E3/E4).** A loom that cannot be independently
  verified — no target/critic panel, an empty verifier report, or a verifier exception —
  lands `needs-review`, never promotes on the builder's self-report. Force
  `panelRequired: true` on any verifier exception/empty report; unify the contradictory
  skip policy (`executor.ts` promote-on-skip vs the stricter path) to the strict one.
- **Guard the clean-accept sweep (E1).** `acceptLoom` on a verify-only `ready` loom must
  not `git add -A` the dirty working tree (`looms.ts` `recordLanding`/`landWorkingTree`).
  Gate the working-tree commit on `producedBuildOutput`; never sweep unrelated changes.
- **Delete the client's false-green.** Remove the web `panelFailed` reimplementation in
  favor of `classifyPanelPure` so the cockpit can never render green where the Verify tab
  renders red; make `classifyPanelPure` mirror core's (now fail-closed) `aggregatePanel`.
- **Worktrees clean themselves up.** Each loom/Thread worktree is removed once its work is
  safely folded into the consolidation branch — on **every** loom exit path
  (`ready`/`done`/`failed`/`needs-review`/`cancel`/`reject`/error) and on Thread-fold —
  via `git worktree remove` (never `rm`; the deliverable *branch* is kept, only the temp
  checkout dir is removed). Never remove a worktree holding un-consolidated work
  (fold-then-remove; if the fold fails, keep it and log). Boot reconciliation
  (`reconcileStuckLooms`) `git worktree prune`s orphans left by crashes.

**Done when:** no verifier exception or missing panel can reach `ready`/`done` on
self-report; a clean accept never sweeps a dirty tree; the cockpit and Verify tab agree;
and a completed (or cancelled, or failed) isolated loom leaves **zero** leftover worktree
dirs behind, with the deliverable preserved as a branch. Green-gate: core tests + core/web tsc.

## ✅ M7 — Environment proposal: the env is accepted like the work is  ·  *shipped (rebuilt on the fail-closed base; E10 fixed in `rollupWeave`; proposer hardened read-only)*

*Emerged from live validation: a loom that builds fine can't be verified when
there's no way to run the app, so it honestly lands `needs-review`. Extend the
moat to the environment — Telar **proposes** how to run the app and a **human
accepts** it, then verification proceeds.*

- **`env-review` state** — at VERIFY time, when a loom needs a running app and the
  project has no server config, it enters `env-review` instead of skipping.
- **Setup agent as a proposer** (refit M5's setup agent) — inspects the project
  (package.json scripts, framework, port) and **drafts a `servers.yaml`**; it does
  not run or write anything until the human accepts.
- **Human gate** (mirrors charter-review): the cockpit shows the proposed config →
  Accept / Steer / Reject. Accept → persist to `.telar/` (reused by every future
  loom) → the lane (M4/Phase-C `startLane`) spins the server → verify runs. Steer →
  correct the proposal. Reject → honest `needs-review`.
- Flag-guarded, default off; moat intact (env config is human-accepted; verify stays
  read-only; nothing auto-promotes to `done`).

**Done when:** the `greenfield-demo` loom (which needs a dev server to verify) can be
brought to a real, panel-verified `ready` via an accepted env proposal.

## ▶ M9 — Threads become workflows (multi-agent: N steps × M agents)

*See `thread-as-workflow.md`. Telar is inspired by Claude Code workflows: an agent
authors a workflow of N steps, each fanning out M agents. A **thread should be that
workflow**; a **loom orchestrates workflow-threads with robust verification**. The
loom→threads orchestration already exists (the weaver); a thread's **build** is still
single-agent (an attempt loop). M9 upgrades the thread, not the loom — and collapses
the attempt-loop + repair leg + build-fanout + several flags into one abstraction.*

- **Thread = step-graph**, not an attempt loop — reuse the loom's `dependsOn`/ready
  predicate one altitude down; today's single builder becomes the degenerate 1-step case.
- **Step fan-out** — generalize build-fanout (M6) from "the build step, disjoint-file
  builders" to "any step, M agents," keeping the disjoint-writer / merge / stray safety.
- **Per-thread planner** — a default template for simple threads; an LLM step-planner
  (sub-flag) for complex ones. Read-only planning, same `fanoutClamp` + budget clamps.
- **Moat unchanged, optionally deeper** — the loom still verifies the thread deliverable
  fail-closed (green → `ready` → human accept → `done`); an optional informational
  per-step check never earns `done`.
- Proven on a real multi-step thread, then landed as the sole path — the single-agent
  thread is the degenerate 1-step case, not a separate mode.

**Done when:** a thread runs a real N-step, M-agent workflow under the same clamps and
the same moat; the workflow runner IS how a thread runs. Subsumes M6 (keeps its
partition/merge/stray machinery, retires its single-step framing).

**Progress (overnight build; the `threadWorkflow` flag has since been collapsed — this is
the engine now):**
- ✅ **M9.1 — Step types + thread workflow-runner** (`19aafce`). `Step`/`ThreadWorkflow`/
  `AgentSpec` types; `runThreadWorkflow` step-DAG runner reusing the weaver's readiness
  kernel one altitude down; default 1-step `build` template re-enters `executeLoom`
  (flag-on-default == today); flag-off byte-identical; fail-closed on an unschedulable
  DAG. 806 core tests pass. *Carry into M9.2:* (1) the step-wave pool clamp defaults to
  `steps.length` when the thread has no charter budget — replace with a real concurrency
  cap once steps actually fan out; (2) the `opts.runStep` seam must funnel every *writing*
  step through the verifier so an injected executor can never promote a loom without it.
- ✅ **M9.2 — Step fan-out** (`f44f55c`). Generalized M6's build-fanout to "any step,
  M agents" (writing steps: disjoint-writer partition + merge + stray fail-closed, reused;
  non-writing: free read-only fan-out). CF1 (real pool clamp) + CF2 (writing greens trusted
  by provenance, not presence) landed. Adversarial verification found + closed two fail-open
  holes (a failing step now fails the loom closed; a final provenance gate + built-in
  writing-step serialization kill a side-channel green and a shared-loom race — both re-proven
  by PoC). 820 core tests pass. *Carry into M9.3 (architectural):* give each step an isolated
  loom/worktree context and derive the loom's terminal state from validated per-step results —
  enabling safe parallel writing steps and trusted custom step executors. Until then: built-in
  writing steps serialize within a wave, and injected-executor greens fail closed.
- ✅ **M9.3 — Per-thread planner** (`d55b16d`). Deterministic template library
  (`single-build` = today's default; a 3-step `understand → implement → check` chain),
  a conservative heuristic (escalates only at ≥3 blocker assertions), and an optional
  read-only LLM step-planner behind `threadPlanner` (default off) that degrades to the
  template on any invalid/empty/cyclic graph. `threadWorkflow` off ⇒ byte-identical;
  `threadPlanner` off ⇒ templates only. Moat untouched (planner authors execution, not
  verification; `Step.check` schema-permitted but not yet consumed). 841 core tests pass.
- ✅ **M9.4 — Per-step checks** (`7e8cecb`). Optional read-only informational per-step
  check (flag `stepChecks`, default off) consuming `Step.check`: pass/skip proceeds, fail
  triggers a bounded (budget-gated) step-local repair then fails the thread closed. Moat
  held under adversarial PoCs: never promotes (state-neutral — snapshots loom.state around
  the check, fails closed on any mutation, so a check can't side-channel `done`); fail-closed
  on a throwing check/repair (whole seam wrapped, no escaping rejection); additive-only (the
  loom contract stays the floor); off ⇒ byte-identical. 853 core tests pass. *Tracked
  follow-up:* if `threadPlanner`+`stepChecks` are ever both on, an LLM-authored `Step.check`
  with a raw command/db runnable is a code-exec surface (same trust model as loom-level gates,
  but planner-authored) — restrict the deterministic slice to named manifest gates if that
  combination ships.
- ✅ **M9.5 — Proven, then collapsed to the sole path.** **E2E prove complete** (real looms,
  real agents, `personal` account, isolated sandbox):
  - *Single-agent path:* a complex build task ran through `runThreadWorkflow` → contract gates →
    green → `ready` → human `acceptLoom` → `done` (clean accept, real commit). Moat never
    auto-promoted.
  - *Multi-step + multi-agent:* a 3-step DAG (`research → build → check`) with a 2-agent
    disjoint-writer build step ran in dependency order, both pieces merged (446 insertions,
    first attempt, all gates green) → child `done` → root `ready` → human accept → `done`.
  - The e2e surfaced + fixed a real bug: `mergeDisjoint`'s stray check used default
    `git status --porcelain`, which collapses a fully-untracked dir to `dir/` and false-flagged
    every greenfield fan-out file as stray (fail-closed but wrongly rejecting valid work). Fixed
    with `--untracked-files=all` (`a252432`); genuine strays still fail closed. 856 core tests.
  - **Collapsed (de-flag cut, `docs/deflag-cut-plan.md`):** `threadWorkflow` is no longer a
    flag — the workflow runner IS how every thread runs; M6's single-step framing is retired,
    the engine is this now.

  *Fan-out robustness follow-ups (both surfaced by the e2e; both fail-**closed**, moat intact —
  harden before making the multi-agent path a default):*
  (1) **No per-agent timeout in fan-out** — a single stuck agent SDK query wedges the whole step
  (`runBuildFanout`'s `Promise.all` waits forever); the system relies on a caller-supplied
  `opts.abort` deadline. Not an M9 regression (the legacy single-agent path shares the property),
  but fan-out multiplies the exposure. Add a per-piece wall-clock/liveness bound.
  (2) **`addWorktree` not lock-guarded + per-process counter resets to 1** (`build-fanout.ts` /
  `vcs.ts`) — a leftover `telar-wt-*` dir from a crashed prior run makes `git worktree add`
  collide and throw → the piece's verdict comes back null → `mergeDisjoint` is skipped and a
  successful agent's work is silently dropped. Uniquify/pre-prune the worktree path (and/or don't
  discard a piece whose files were written).

## ▶ M10 — Looms that deliver: orchestrator-owned verification

*See `orchestrator-owned-verification.md` (design) + `analysis-loom-run-2026-07-12.md` (the run
that motivated it) + the verification-model visual. Builds ON M9 (threads-as-workflows). The
verification GATE moves up: **threads advise, the orchestrator decides once on the composed
whole, the human signs once.** A loom drives to an actual, verified result — not a guided one.*

- **Threads advise, they don't gate** — green-unless-broken; red only on a real defect.
  "Couldn't independently verify X" becomes a green thread with a note (no per-thread needs-review).
- **One authoritative gate, at the orchestrator** — after weave rollup, verify the composed whole
  ONCE: (1) regression (didn't break anything) + (2) completeness (every criterion), fail-closed,
  owning the verification lane.
- **The verification lane** — a general infra abstraction (dev server / DB / service / MCP /
  credentials) the orchestrator PROACTIVELY stands up (a duty) and repairs; a **pre-flight**
  viability gate; a **bounded learn-once** human escalation ("Orchestrator requires help") that
  persists the setup to the manifest + a project runbook so it never asks twice.
- **Objective → the top gate (autonomous); subjective → the human final accept** (never a
  per-thread gate, never faked into a machine check).
- **The invariant (sacred):** fail-closed doesn't vanish — it MOVES up and tightens. A thread's
  green means "I built it and didn't break anything," never "the whole is correct." `ready` stays
  the autonomous ceiling; only a human `acceptLoom` writes `done`. Lane-repair only ADDS
  verification capability, never relaxes an assertion.

**Motivation:** the greenfield e2e (`telar-test-m9`) produced a clean, 54/54-tested deliverable and
correctly refused to auto-`done` — because two threads carried a live-critic assertion with no
runnable target (greenfield library, no dev server) → per-thread `needs-review` → human punt.
Right, but unsatisfying: the gap was environment-provisioning + planner-contract quality, not a
build defect. M10 makes the orchestrator own that.

**Phases (fail-closed; the TOP GATE ships before thread demotion so fail-closed is never lost;
each shipped behind a milestone flag SINCE COLLAPSED to the sole engine path by the de-flag cut,
`docs/deflag-cut-plan.md`). M10.0–M10.5 SHIPPED on branch `m10` (each: workflow → adversarial
moat-lens verify + PoCs → independent green-gate → commit; every phase found & closed a real
fail-open/coverage hole before commit). Base green: 947 pass / core+web tsc 0. The per-phase
`Flag` labels below are retained as shipped history.**
- **✅ M10.0** — adjacent fixes: cockpit copy (Finding 1, `257c3e2`) + proposer prefers
  command/gate over live-critic (Finding 3, prompt-guidance, `40f2223`). *(unflagged corrections)*
- **✅ M10.1** — orchestrator final-verification GATE (`1e30fa7`): verify the composed whole after
  rollup; fork the read-only verify worktree from the consolidation branch, not `baseSha`; a
  required panel with no evidence demotes ready→needs-review (fail-closed). *Flag `orchestratorVerify`.*
- **✅ M10.2** — thread verification → advisory (`55b41c4`): green-unless-broken; a contract-backed
  panel skip = green-with-note (re-proven at the top gate), not needs-review. *Same flag
  `orchestratorVerify` (can't arm without M10.1).*
- **✅ M10.3** — the verification lane (`bbd979b`): generalize infra provisioning + proactive
  setup inside the top-gate producer + bounded repair; judge stays read-only. *Flag `verifyLane`.*
- **✅ M10.4** — pre-flight lane-viability + bounded ask-once-persist ("Orchestrator requires help",
  `a0cfb15` core + `204a09d` web): `blocked` finally reachable-as-output; human `by` required;
  persist to manifest + `.telar/runbook.md`, reused-never-reasked. *Flag `laneEscalation`.*
- **✅ M10.5** — objective/subjective routing (`99d8e86` core + `18807b9` web): default-to-objective;
  subjective → human accept (never a machine gate); optional advisory aesthetic critic, provably
  non-gating. *Flag `subjectiveRouting`.*
- **✅ M10.6** — prove, then collapse (INTERACTIVE, human-in-seat): live-validated on the
  greenfield lib + a web app (lane stood up) + a pure refactor; fail-closed still demotes a
  genuinely-broken whole; the four flags (`orchestratorVerify`/`verifyLane`/`laneEscalation`/
  `subjectiveRouting`) are no longer flags — the top gate + lane + routing IS the engine now
  (de-flag cut, `docs/deflag-cut-plan.md`). *(the greenfield lib reaches autonomous
  `ready → human done`).*

**Done when:** a loom that today punts to `needs-review` for a missing verification lane instead
drives to a real `ready` (orchestrator stood up the lane, verified the whole, fail-closed), the
human accepts once, and the learned setup is persisted. Full spec in `orchestrator-owned-verification.md`.

## M11 — Adaptive verification strategy (derive the method from the deliverable)

*See `adaptive-verification.md` (design). Builds ON M10 and is deliberately SMALLER — it adds
no new machinery and no new fail-closed invariant; it REUSES M10.1–M10.5 wholesale and reframes
three existing seams. M10 wired verification web/dev-server-centric; M11 makes the orchestrator
DERIVE the right verification method from what's being built.*

- **Verification is a STRATEGY the orchestrator derives from the deliverable**, not "a dev
  server": web app → browser live-critic; library → a `bun test` gate; CLI → run + assert on
  exit/output; data-science → run an eval in a sandbox and assert on artifacts (accuracy ≥ X, no
  nulls, schema-match, figure renders); API/DB → boot + hit endpoints. No new AssertionType — a
  non-web method is already expressible as `command`+`expected`.
- **Establish verification at any point**, not at a fixed gate. For anything that *becomes*
  testable, the artifact only exists after the work — so the pre-flight reframes from "is a lane
  viable NOW? park if not" to "can I form a plan to verify this at all?": proceed and defer
  establishment; **asking the human is the last resort** (genuinely un-automatable, after trying),
  not the first gate. Greenfield / library / CLI / DS all just proceed.
- **The invariant (sacred, unchanged):** freedom in the METHOD, never in the VERDICT. The top-gate
  fail-closed coercion + the read-only judge wall carry over verbatim, so a weak/mis-derived method
  can never rubber-stamp — worst case it yields no evidence → fail-closed → honest escalation. `ready`
  stays the autonomous ceiling; only a human writes `done`.

**Motivation:** the M10.6 prove-run — a greenfield `bun test` arithmetic library (`loom_mrigs3zo_vxgrsr`)
parked `blocked` at the M10.4 pre-flight because (a) `synthesizeContract` over-routed every criterion to
a single live-critic (no gates configured; M10.5 routing was deliberately minimal) and (b) the pre-flight
then demanded a dev command a *library* has no answer for. The moat held (nothing stranded, ~$0.28 spent)
— it exposed that verification is wired for web apps, not derived from the deliverable. (Also: the
"Orchestrator requires help" surface should be a conversation, not a form — tracked follow-up.)

**Phases (fail-closed; each shipped behind a milestone flag SINCE COLLAPSED to the sole engine
path by the de-flag cut, `docs/deflag-cut-plan.md`; the per-phase `Flag` labels are retained as
shipped history). M11.0–M11.2 SHIPPED on branch `m11` (implement → green-gate → atomic commit).
Base green: 1033 pass / 0 fail, core+web tsc 0; 86 new tests across 5 files. New shared seam:
`deliverable-signal.ts` — a PURE, bounded signal (one top-level package.json parse + one readdir +
the charter's proof intent) feeding both the M11.0 pre-flight and the M11.1 derivation.**
- **✅ M11.0** — pre-flight reframe (`68b39fd`): proceed-and-defer + escalate-last-resort; `isLaneViable`
  widened additively (signal + human `verifyCommand` paths); park copy strategy-derived (a library is
  asked for a test command, never a dev command); `answerBlocked` accepts a `verifyCommand` strategy
  answer, persisted-never-reasked. *Flag `laneEscalation` (widened).*
- **✅ M11.1** — modality derivation (`aa0122d`): `synthesizeContract` derives the assertion type from
  the deliverable — charter-authored per-criterion `proofHints` → `command`, test-gate signal → the
  lockfile-aware test runnable for every remaining criterion (the redemption library no longer yields a
  synth-0 live-critic); tightening only, web never blanket-tightened, no runnable ever fabricated from
  prose; proofHints guidance in `draftCharter`. *Flag `adaptiveVerification` (NEW).*
- **✅ M11.2** — non-server VerificationStrategies (`734f556`): `verification-strategy.ts` union
  (server-lane | test-gate | cli-harness | sandbox-eval | artifact-assert) + pure chooser; established
  at artifact time inside the frozen worktree; web / any resolvable servers recipe stay server-lane
  verbatim; a non-server strategy stands nothing up and hands the panel no stale URL target —
  fail-closed coercion and teardown carry over for every strategy. *Flag `verifyLane` (widened).*
- **✅ M11 live-proof fix rounds** (three rounds, findings 1–8; details in
  `docs/m11-prove-run.md` + closure stamps in `docs/m11-discuss-iteration.md`): AI-opens-with-a-proposal
  conversational escalation (finding 1, `0a88528`); non-runnable `expected` rejected/escalated + the
  escalation answer reaching the gate layer (findings 2+3, `8fa0e18`); unfixable-gate circuit breaker +
  cancel-path worktree/recovery-branch preservation (findings 4+5, `49f4283`); field-semantics pinned
  (runnable in `expected`, `observable` rejected on command/gate) + `isRunnableShape` tightened (findings
  6+7, `5a0e51d`); child `blocked` propagates as an awaiting-human PAUSE through the step runner + weave
  rollup, never a step `failed` (finding 8, `c60a7cd`).
- **▶ M11.3** — prove on real deliverables (INTERACTIVE): scenario (a) **PROVEN** — the redemption-shaped
  greenfield library `loom_mrjj3sch_0toxc0` reached autonomous `ready` via a DERIVED test-gate, no false
  dev-server escalation (independent 59/0 suite). *Remaining:* a CLI (`command` gates drive the top gate),
  a DS eval (sandbox artifact assertions), and a weak-strategy demotion (a mis-derived strategy still
  demotes a genuinely-unproven whole). The flag-flip question is **SUPERSEDED** by the de-flag cut
  (`docs/deflag-cut-plan.md`) — the derivation is already the sole engine path.

**Done when:** a non-web deliverable (library, CLI, data-science eval) drives to a real `ready` via a
method the orchestrator *derived* — no false dev-server escalation, fail-closed intact. Full spec in
`adaptive-verification.md`.

## M8 follow-up (deferred, tracked)

- **Authored live-critic degrade path (moat, medium).** In a *decomposed epic*, if the
  planner emits a subgoal whose filtered contract slice is all live-critic with no
  falsifiable hard gate, `wireChildBundle` (weave-contracts.ts) drops it to
  `acceptanceCriteria` with `contractRequired` unset; with no dev URL the child can take
  the legacy `runVerification` skip and promote on gates + self-report — a fail-open
  asymmetry M8 closed for the contract path. **Latent** until epics/fan-out are live
  (weave-of-one single looms take the fail-closed panel path). Fix by stamping
  `contractRequired` on the degrade, or forcing `panelRequired:true` when the loom had an
  authored slice. Deferred to keep the M8 round focused; not on the default path.
- **Worktree crash-window (low, flag-on).** The snapshot-then-remove guarantee lives in
  the executor `finally`; a SIGKILL/power-loss between a non-fold-success terminal return
  and the snapshot commit leaves a worktree with no `recoveryBranch`/`worktreeRetained`,
  which the next boot reaper reclaims. Strictly better than pre-M8 (which destroyed this
  work on the normal path too); close by persisting `worktreeRetained` at the terminal
  transition *before* the return, or by snapshotting-before-remove inside the reaper.
- **Cross-process reaper liveness (low, flag-on + out-of-proc runner).** `instrumentation.
  register` calls `reconcileStuckLooms()` with the default in-process liveness oracle, so a
  web boot could classify a *live* runner-owned worktree as an orphan and reap it. Needs
  both `isolateWorktrees` and `outOfProcessRunner` on. Pass `crossProcessLiveness` from the
  boot caller when a runner owns execution.

## Live-validation findings (open)

- **Verify-coherence / dev-server-for-verify** — a live-critic panel needs the app
  running; a greenfield/isolated worktree has no server, so verify skips. **M7 is the
  fix.** (Also: an isolated worktree lacks `node_modules` for a dev server — the M4
  frozen lane must handle deps.)
- **Promotable-skip vs `needs-review`** — a contract-required loom whose panel skips
  with `panelRequired:false` landed `needs-review`, not the "promotable skip → `ready`"
  M1's design (D0.4) documents. Arguably `needs-review` is the *more* correct moat
  behavior, but doc and code disagree — needs a diagnosis + reconciliation.

---

## Housekeeping (fold into the nearest milestone)

- **Reconcile the design docs to as-built** — this roadmap is now authoritative;
  the design docs below still describe intent and lag reality in places.
- **Orphan `apps/web/components/looms/loom-view.tsx`** — references non-existent
  `deriveSteps`/`StepAgent`/`WeaveStep`, breaks `apps/web` tsc, nothing imports it.
  Delete or finish (needs auth for removal — no `rm`).
- **Retire the gallery** — after the design pass lands, delete the `/gallery` route, the
  `telar-gallery` worktree, and the `view-gallery` branch (`docs/view-gallery.md` +
  `docs/design-pass.md` context).
- **`.telar/` per-project config dir** — gitignored home for `telar.yaml` & friends.
- **MCP v2 — CIMD hosted client-doc** — stand up the client-metadata URL.
- **Account `displayTier` labels (5x/20x) + in-app login UI.**
- **Clean up `[demo]` looms** _(needs explicit OK — no `rm` without authorization)._
- Later verification depth: M3 distillation (green-run → deterministic `.spec.ts`),
  M4 monitoring (cron + prod guardrails + alert hook), M6 design-QA.

## Design docs

`loom-model.md` · `loom-orchestrator.md` · `runtime-architecture.md` ·
`verifier-agent.md` · `verification-environments.md` · `watchers-design.md` ·
`mcp-oauth-design.md` · `phase-2-runner-plan.md` · `thread-as-workflow.md` ·
`orchestrator-owned-verification.md` · `adaptive-verification.md`

_These are **design intent**; where they disagree with shipped behavior, this
roadmap and the code win. Reconcile opportunistically as each milestone touches them._

---

## De-flag cut — COMPLETE (2026-07-13)

Rounds A1-A4, B1, B2, D landed. One engine, no behavior flags, doctrine-conformant.
B3 deferred by D7. B2 (this cut) gives the orchestrator a mediation rung before the
human: tick emits repair/reassign, human parks behind exhausted bounded mediation,
and eager env-comprehension (requirements detection) with offer-never-gates rails.
