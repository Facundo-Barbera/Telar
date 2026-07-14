# M11 prove-run — the live vindication record

> Companion to `docs/adaptive-verification.md` (design) and
> `docs/m11-discuss-iteration.md` (the per-finding feedback these runs produced).
> M11.0–M11.2 shipped as ONE engine (`docs/deflag-cut-plan.md`; `docs/PRINCIPLES.md`
> §1); this file records the four live runs that proved the derived-verification path
> end to end and drove the three fix rounds (findings 1–8). The moat held in every run:
> nothing false-green'd, `ready → done` stayed a human click.

## Run 1 — park → Discuss → `verifyCommand` persist

- **Loom:** `loom_mrinlb18_0s6x5h` (greenfield `bun test` library).
- **What happened.** The pre-flight parked `blocked` (a library has no dev command); the
  human clicked **Discuss** and the escalation opened with the AGENT's proposal
  (`verifyCommand: bun test`), one-click approved through the human-gated `answer_blocked`
  tool. The answer persisted as a project FACT and informed the top-gate strategy.
- **Proved.** The conversational escalation (first turn is the agent's analysis, not an
  empty form) and the `verifyCommand` human-answer tier that persists never-reasked.
- **Fix landed.** Finding 1 — AI-opens-with-a-proposal (`0a88528`).

## Run 2 — the doomed prose-gate run

- **Looms:** `loom_mrirhfm4_w0o4n2` (fresh run, post-`72e498c`) / child
  `loom_mriqnl72_o854v7`.
- **What happened.** Capture + tightening worked (charter-proof-intent-captured, 13
  hints, contract-tightened events) but garbage flowed through unvalidated at every hop:
  the planner authored non-runnable `ProofHint.run` values and prose `expected`
  (`process exits with code 0; …`), which `runContractGates` executed verbatim
  (`process: command not found`) — the child burned repair attempts on a gate the builder
  can never fix (contract state, not project code), even reading Telar's own source to
  "debug" it. A false-runnable (`exit code 0`) also passed `isRunnableShape` and became
  UN-repairable (the no-overwrite moat rule sealed it).
- **Proved.** A non-runnable `expected` must never reach `sh -c`; validation is needed at
  every hop (contract emit, hint emit, tightening install), and the human's
  `verifyCommand` must reach the gate layer, not sit unused in the manifest.
- **Fixes landed.** Findings 2+3 — reject/escalate non-runnable `expected` + the
  escalation answer reaching the gate layer (`8fa0e18`); finding 7 — `isRunnableShape`
  tightened (`5a0e51d`).

## Run 3 — the breaker + recovery-branch run

- **Looms:** `loom_mriuu8la_lrtwxx` (run #3) / child `loom_mrjgch8b_g9r7g4`.
- **What happened.** The planner inverted the field semantics — runnable in `observable`
  (`bun test`), prose outcome in `expected` — so the real commands went unused. The new
  unfixable-gate circuit breaker correctly PARKED the child `blocked` ("Unfixable gate
  after 2 attempts … the red is contract/environment state"), and the child's committed
  work was preserved on a recovery branch
  (`telar/loom_mriuu8la_lrtwxx-wip-loom_mrjgch8b_g9r7g4`). BUT `runThreadWorkflow` treated
  the `blocked` terminal as a step FAILURE → child failed → root failed → the
  awaiting-human escalation was swallowed; the human never saw the question.
- **Proved.** The breaker fires as designed and cancel/park preserves committed work
  (findings 4+5 confirmed live), the field semantics must be pinned to one field
  (finding 6), and a child `blocked` park must propagate as a PAUSE, not a step failure
  (finding 8).
- **Fixes landed.** Findings 4+5 — unfixable-gate breaker + cancel-path worktree/recovery
  preservation (`49f4283`); findings 6+7 — field semantics pinned (runnable in `expected`,
  `observable` rejected on command/gate) + `isRunnableShape` tightened (`5a0e51d`);
  finding 8 — `blocked` propagates as an awaiting-human PAUSE through the step runner +
  weave rollup (`c60a7cd`).

## Run 4 — wire-to-wire (M11.3 scenario (a), PROVEN)

- **Loom:** `loom_mrjj3sch_0toxc0` (redemption-shaped greenfield `bun test` library).
- **What happened.** With all eight fixes in, the run went wire-to-wire clean: the
  orchestrator DERIVED a test-gate from the deliverable (no false dev-server escalation,
  no prose gate), the child built and verified, `blocked` never spuriously fired, and the
  loom reached autonomous `ready` — then a human accept to `done`. Independent 59/0
  suite green.
- **Proved.** The whole M11 derived-verification path holds end to end: a non-web
  deliverable drives to a real `ready` via a method the orchestrator derived, fail-closed
  intact, human accept the sole path to `done`.
- **Status.** M11.3 scenario (a) PROVEN. Remaining scenarios: a CLI, a DS eval, and a
  weak-strategy demotion (see `docs/ROADMAP.md` M11.3 / `docs/adaptive-verification.md`
  §7).

## Fix ledger (findings 1–8, three fix rounds, five commits)

| Findings | Fix | SHA |
|---|---|---|
| 1 | AI opens with a proposal (conversational escalation) | `0a88528` |
| 2+3 | non-runnable `expected` rejected/escalated; answer reaches the gate layer | `8fa0e18` |
| 4+5 | unfixable-gate breaker; cancel-path worktree/recovery-branch preservation | `49f4283` |
| 6+7 | field semantics pinned; `isRunnableShape` tightened | `5a0e51d` |
| 8 | `blocked` propagates as an awaiting-human PAUSE, never a step `failed` | `c60a7cd` |
