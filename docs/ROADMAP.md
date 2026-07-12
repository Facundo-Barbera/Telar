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

## ✅ M3 — Isolated, consolidated deliverables  ·  *shipped `ec9f7fa` (flag off; live-gated)*

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

## ▶ M5 — Durable, out-of-process execution

*A reload or a code edit must not kill in-flight work.*

- **`telar-runner`** — move execution out of the web dev-server process
  (see `phase-2-runner-plan.md`).
- **Setup agent** (pre-loom `preparing` state) — bring the env up, diagnose, author
  a missing `servers.yaml`, fast-path the `readyCheck`.

**Done when:** a loom survives a web reload; a project with no `servers.yaml` is
brought up by the setup agent.

## M6 — Scale the weave  ·  *exploratory*

- **Sub-thread build fan-out** — wire `splitBuild`/`decideBuildFanout` so a Thread
  can use N parallel builders (built, never wired).
- **Disjoint-partition rule** — each builder owns non-overlapping files (or
  sequential steps, one writer each) so mutating multi-agent threads don't collide.
- **Dynamic weaver (P4)** — methodology-neutral decomposition; the Verification
  Contract is the proof, not an enumerated strategy.
- **Curated agent roster** — via the SDK `agents` option.

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
