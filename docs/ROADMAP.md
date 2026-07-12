# Telar — Roadmap to Completion

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
> `rollupWeave` and the proposer hardened read-only. Path to completion, now:
> **1. moat-edge hardening + housekeeping** (◀ current — the deferred edges +
> the code housekeeping list) → **2. live-validation** (M4 Postgres / M5
> durability / M6 fan-out / M7 & M8 flag-flips — these need a real run + a human
> in the seat, so they're driven interactively, not by a build workflow). The
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
- **`.telar/` per-project config dir** — gitignored home for `telar.yaml` & friends.
- **MCP v2 — CIMD hosted client-doc** — stand up the client-metadata URL.
- **Account `displayTier` labels (5x/20x) + in-app login UI.**
- **Clean up `[demo]` looms** _(needs explicit OK — no `rm` without authorization)._
- Later verification depth: M3 distillation (green-run → deterministic `.spec.ts`),
  M4 monitoring (cron + prod guardrails + alert hook), M6 design-QA.

## Design docs

`loom-model.md` · `loom-orchestrator.md` · `runtime-architecture.md` ·
`verifier-agent.md` · `verification-environments.md` · `watchers-design.md` ·
`mcp-oauth-design.md` · `phase-2-runner-plan.md`

_These are **design intent**; where they disagree with shipped behavior, this
roadmap and the code win. Reconcile opportunistically as each milestone touches them._
