# Thread = Workflow (design)

> **Status:** proposed direction (M9). No code yet — this is the alignment doc.
> **Origin:** Telar is inspired by Claude Code workflows. An agent authors a
> workflow of N steps, each step fanning out M agents. A **thread should be that
> workflow**; a **loom is the orchestrator of workflow-threads, with robust
> verification**. Today a thread's *build* is single-agent — this closes that gap.

## The reframe (one recursive spine)

- **Loom** — orchestrates threads **+ the moat** (robust verification, human accept).
- **Thread** — a **workflow**: N steps, each step M agents.
- **Step** — M agents in parallel (disjoint writers), with an optional per-step check.

This is the Claude Code workflow shape made recursive: orchestrator → workflows →
steps → agents, with a verification gate on top. It is **fewer** concepts than
today's executor, not more: the attempt-loop + repair leg + build-fanout + several
flags collapse into one uniform *thread workflow runner*.

## Where the code is today (as-built, `main`)

- **Loom → threads already exists and is solid.** The weaver (`weave.ts` `tick`/
  `rollupWeave`, `tick.ts`) orchestrates subgoals with `dependsOn`, clamps
  concurrency (`fanoutClamp`), and folds results. **Keep this** — it *is* "loom =
  orchestrator."
- **A thread's build is single-agent.** `executeLoom` (`executor.ts`) is an
  *attempt loop*: one builder agent per attempt (roles `dev → dev → careful`),
  gates, one verifier, retry-on-fail (the repair leg). No notion of "N steps."
- **The only multi-agent build seam is build-fanout** (M6, flag `buildFanout`,
  default off): `splitBuild` → M *disjoint-file* builders → merge → one verifier
  (`build-fanout.ts`). That is *one step, M writers* — the seed of "M per step,"
  not a workflow.
- **Verification is already multi-agent.** The adversarial critic panel is M
  critics in parallel (`critic.ts`/`panel.ts`). So the **moat side already fans
  out**; it's the **build/execution side** that is still single-agent. The pivot
  brings the panel's multiplicity to the *doing*, not just the *checking*.

## The target model

### 1. A thread is a step-graph, not an attempt loop
A thread carries `steps: Step[]` forming a small DAG. Reuse the **same** ready/
`dependsOn` predicate the loom uses over subgoals, one altitude down (fractal —
`readySubGoals` at step scope). Steps run in dependency order; agents *within* a
step run in parallel. The current single-builder attempt loop becomes the
**degenerate 1-step workflow** with a retry/repair *policy* on that step
(behavior-preserving default).

`Step = { id, goal, kind, agents: AgentSpec[], partition, dependsOn[], check? }`
where `kind ∈ {research, design, build, migrate, check, …}`.

### 2. Step fan-out generalizes build-fanout
Lift `splitBuild`/`decideBuildFanout`/`runBuildFanout` from "the build step, with
disjoint-file builders" to **"any step, M agents."** Writing steps keep the
**disjoint-writer partition** rule (each agent owns non-overlapping files; a
`stray` write forces fail — the existing safety, unchanged). Non-writing steps
(research/analysis/judge) fan out freely. Merge is per-step.

### 3. A per-thread planner authors the workflow
A small planner drafts the step-graph (steps × agents) for a thread — like a
workflow author. **Default template** for simple threads (a single `build` step =
today's behavior); an **LLM planner** (behind a sub-flag) for complex threads
(*understand → implement (fan-out) → self-check*). Planning is read-only until a
step is scheduled — mirrors `splitBuild`'s read-only planner, so no spend is
created without the same clamps.

### 4. The moat stays where it is (and can go deeper)
- The **loom-level moat is unchanged**: it verifies the thread **deliverable** —
  forced Verification Contract → read-only verifier + adversarial panel →
  **fail-closed**. Green → `ready` (never `done`); only a human `acceptLoom` on
  the root writes `done`.
- **Optional per-step check**: a cheap adversarial check on a critical/expensive
  step (the verify-lens pattern), *informational* — it can gate the next step or
  trigger a step-local repair, but **never earns `done`**. The contract + panel +
  human remain the only proof.

### 5. Cost & safety
- Reuse the tick **`fanoutClamp` + cost budget one level down**: a thread's step
  fan-out is bounded by pool + budget, so `M agents × N steps × T threads` stays
  clamped. No new runaway surface.
- **Disjoint-writer partition** prevents multi-agent collisions (build-fanout's
  proven rule, generalized).
- **Proven on a real multi-step thread, then landed as the sole path** — the
  single-agent thread is the degenerate 1-step case of the workflow runner, not a
  separate mode. (Shipped behind `threadWorkflow`, since collapsed — `docs/deflag-cut-plan.md`.)

## Parallelism — three axes, one primitive

Parallel execution is native at every level, and it is the **same primitive** each time
(`dependsOn` for ordering + a clamp for concurrency), applied fractally:

- **T threads under a loom — already exists.** The weaver's `tick` scheduler spawns
  every *ready* subgoal-thread at once (no await; re-ticks to refill the pool), holds on
  `Promise.race(running)`, and sizes the batch with `fanoutClamp` against pool + cost
  budget (`tick.ts`). Threads run in parallel; `dependsOn` sequences only where one thread
  needs another's result. You rarely see it because the **default loom is a weave-of-one**
  — parallel threads appear only on a decomposed epic.
- **N steps in a thread — new (M9).** Steps form a DAG, so **independent steps overlap**
  (like the Workflow tool's pipeline), gated by the same ready/`dependsOn` predicate one
  altitude down.
- **M agents per step — new (M9).** Agents within a step run concurrently by construction.

**The collision rule (same at every level).** Parallel *writers* that touch the same
files collide. Two mechanisms already handle it: the **disjoint-writer partition** within
a step (each agent owns non-overlapping files; a `stray` fails), and **worktree
isolation** (M3, flag) across parallel threads (each thread builds in its own worktree,
consolidated on the review branch). So heavy parallel writing wants `isolateWorktrees`
on — which is exactly what also makes M9's step fan-out safe.

**One level up (future).** The vision study's *Program* is parallel/sequenced **looms** —
the same `dependsOn` + clamp primitive at the top. Programs ∥ · threads ∥ · steps ∥ ·
agents ∥ — one idea all the way down.

## What it simplifies (the "convoluted mess" → one idea)
The attempt loop, the repair leg, build-fanout, and several flags all become
facets of **one abstraction**: a thread is a workflow of steps, each step a
fan-out, with a check policy. The mental model becomes the tool the system was
inspired by — and the map draws as three clean tiers instead of a 14-state sprawl.

## Execution plan (overnight-ready — build top to bottom)

Five phases, each a **single orchestrated build pass** (one workflow: ground → design →
implement → adversarially verify → integrate), then a self green-gate + commit — exactly
how M1–M8 shipped. Each phase shipped behind a milestone flag (`threadWorkflow`; the LLM
planner behind `threadPlanner`) SINCE COLLAPSED to the sole engine path by the de-flag cut
(`docs/deflag-cut-plan.md`); the flag names below are retained as shipped history.

**M9.1 — Step types + thread workflow-runner (behavior-preserving).**
- Build: `Step` + `ThreadWorkflow` types in `schemas.ts` (`Step = {id, goal, kind,
  agents, partition, dependsOn[], check?}`); a `runThreadWorkflow` runner in the executor
  that executes a step DAG (ready/`dependsOn` predicate reused from `tick`); the DEFAULT
  template is a **single `build` step** wrapping today's `runBuildStep` + gates + verify +
  the repair policy — so flag-on-with-default-template == today's `executeLoom`.
- Flag `threadWorkflow` off ⇒ `executeLoom` path unchanged.
- Tests: default-template runner reproduces today's outcomes on the existing fixtures;
  flag-off byte-identical; a hand-built 2-step DAG runs in dependency order.
- Done when: green-gate clean; no behavior change with the flag off or with the default
  1-step template.

**M9.2 — Step fan-out (generalize build-fanout).**
- Build: lift `splitBuild`/`decideBuildFanout`/`runBuildFanout` into a general
  **step fan-out** — M agents per step, with the disjoint-writer partition + merge +
  `stray`-fails safety for *writing* steps, and free fan-out for non-writing steps
  (research/design/judge). Independent steps in the DAG overlap (parallel), clamped by the
  same pool + cost budget one altitude down.
- Tests: a multi-writer step merges disjoint edits; a `stray` write fails closed; two
  independent steps overlap; the clamp bounds concurrency.
- Done when: green-gate clean; M6's partition/merge machinery is reused (not duplicated).

**M9.3 — Per-thread planner.**
- Build: a small built-in **template library** (1-step build; a 3-step
  understand → implement → check) selected by heuristics; plus an **LLM step-planner**
  behind `threadPlanner` (read-only, authors the step-graph, degrades to the default
  template on any failure/invalid graph — same discipline as `splitBuild`).
- Tests: the planner emits a valid step DAG; invalid/empty graph degrades to the template;
  `threadPlanner` off ⇒ templates only.
- Done when: green-gate clean; no un-planned spend (planning stays read-only until a step
  is scheduled).

**M9.4 — Optional per-step checks.**
- Build: an **informational** per-step adversarial check (the verify-lens pattern) that
  can gate the next step or trigger a step-local repair, but **never earns `done`** — the
  loom-level contract + panel + human remain the only proof.
- Tests: a failing per-step check triggers a step repair / holds the next step; it can
  never promote a loom; off by default.
- Done when: green-gate clean; the moat invariants are provably untouched.

**M9.5 — Prove, then collapse.**
- Live-validate on a real multi-step, multi-agent thread (a human in the seat), confirm
  the moat holds (green → `ready` → human accept → `done`). There is no default to flip:
  the workflow runner IS how every thread runs, and M6's single-step framing is retired
  (its partition/merge/stray code kept). This phase needs a real run — it is the
  interactive step, not a build workflow. (`threadWorkflow` collapsed — `docs/deflag-cut-plan.md`.)

## Process (every phase — the invariants the overnight pass must hold)
- **Orchestrate only.** Build each phase via one Workflow (ground → design → implement →
  verify); then review, run the green-gate independently, delegate any fixes, and commit.
  Never hand-edit source.
- **Green-gate before every commit:** `NODE_OPTIONS= bun test packages/core` (0 fail);
  `NODE_OPTIONS= bunx tsc -p packages/core/tsconfig.json --noEmit` (0 `error TS`);
  `NODE_OPTIONS= bunx tsc -p apps/web/tsconfig.json --noEmit` (0 `error TS`).
- **Moat invariants (never weaken):** forced contract; read-only verifier; green → `ready`
  (never `done`); only a human `acceptLoom` writes `done`; fail-closed.
- **Moat weight:** the loom-level contract + panel + human remain the only proof; the
  workflow runner authors execution, never verification.
- **Build hygiene:** atomic edits (a live `bun dev` runs on :3000; never a duplicate-
  definition window); `NODE_OPTIONS=` prefix on all bun/bunx/tsc; never touch
  .env/secrets/lockfiles; removal via git only (no `rm`); commit messages with backticks
  via `git commit -F`; author `facundo-barbera`; the standard co-author + session trailers.
- **Cadence:** commit each phase as its own logical unit (core / web / docs), advance the
  roadmap, keep the build never-broken longer than ~30 min.

## Open questions
- **Planner vs determinism.** The thread planner authors *execution*, not
  *verification*; the contract + panel + human stay the proof, so a planner
  mistake can't rubber-stamp — it just wastes a step. Keep it that way.
- **Events.** Extend the `plan`/`observe` event stream one altitude down so the
  cockpit can show a thread's steps × agents live (feeds the vision study's
  "orchestration replay").
- **Roster.** Curated agent types per `kind` (the M6 roster idea, now with a home).
- **Relationship to build-fanout/M6.** M9 subsumes build-fanout; keep M6's
  partition/merge/stray machinery, retire its single-step framing.
