# Cockpit UX findings (live e2e, 2026-07-12)

Captured while running a real greenfield loom through the web UI (`TypeScript
arithmetic expression engine`, project `telar-test-m9`, Full-M9 flags on). The loom
worked correctly end to end — these are **UI/copy** issues, not engine bugs. To be
fixed **after** the e2e run.

## Finding 1 — the cockpit conflates "the system is working" with "it needs you" (HIGH)

**Symptom.** An actively-building weave (threads in `running`/`queued`) reads as
though it is **blocked on the human**, when there is nothing to approve. The operator
reasonably concludes the loom is stuck.

**Evidence (what the operator saw).**
- Right rail: *"The weave can't be accepted yet — N Threads still weaving. Open each
  **flagged** Thread in the Threads tab to **resolve** it…"* — styled amber
  (action-required), with the words "flagged" and "resolve" implying the human must act.
- Decisions timeline: *"**holding — waiting** on in-flight threads before the next move."*
  "holding/waiting" reads as blocked-on-you.
- Net operator reaction: *"it stuck as soon as the first thread came in, indicating it
  needs my approval, but I don't see why and I can't approve it… actually it's not
  stuck, it's working, but says it isn't."*

**Root cause.** The same language ("flagged / resolve / holding / waiting / can't be
accepted") is used for two very different situations: (a) a thread that is simply
`running`/`queued` and just needs to *finish* (no human action), and (b) a thread in
`needs-review`/`blocked` that genuinely needs the human. The amber "action-required"
styling is applied to both.

**Fix.**
- Distinguish by thread state. When the only outstanding threads are `running`/`queued`,
  the panel should read calm/informational, e.g. *"2 threads still building — nothing to
  do; they'll land on their own,"* with neutral (not amber/action) styling.
- Reserve "**flagged / needs your input / resolve / approve**" and the amber
  action styling strictly for threads in `needs-review` or `blocked`.
- Reword the Decisions "holding — waiting on in-flight threads" line so it clearly means
  "the orchestrator is waiting on its own in-flight work," not "waiting on you."

**Where to look (apps/web).** The weave-acceptance right-rail panel ("can't be accepted
yet"), the Decisions timeline copy, and the godview/Threads components.

## Finding 2 — the scoping screen has no live planner transcript (MEDIUM)

**Symptom.** During charter/contract drafting (`scoping` state), the screen is
uninformative: it shows *"Drafting the charter…"* and a **PLANNER ACTIVITY** panel that
stays on the static placeholder *"Waiting for the planner to start…"* while the planner
is, in fact, actively working (it produced a 3-subgoal decomposition: scaffold /
semantics / errors).

**Desired.** Stream the planner agent's **live transcript / tool activity** into that
panel — the same live agent-view treatment the builder threads get — so the operator can
watch the planning happen (proof strategy, budget, decomposition) instead of a spinner.

**Where to look (apps/web).** The scoping / charter-review view and the planner agent's
event stream (the planner runs read-only during `scoping`).

---

# Engine / planner findings (same e2e)

## Finding 3 — planner picks `live-critic` where an executable check would verify (HIGH)

**Symptom.** The `errors` thread produced a clean, tested deliverable (tsc clean, 54/54
`bun test`, the `error-paths` **command** gate ran and passed independently) yet landed
`needs-review` with `error: "panel verification required but did not run."`

**Root cause.** Its contract had two blocker assertions: `error-paths` (`type: command`,
independently verified ✓) and `comprehensive-tests` (`type: live-critic`). A `live-critic`
requires the adversarial critic panel, which needs a running-app target/evidence. This is
a greenfield **library** (no dev server), so the panel had no target → did not run → a
required assertion could not be independently verified → fail-closed → `needs-review`.

**Assessment.** This is **correct moat behavior**, not an engine bug — it refused to
rubber-stamp the builder's self-reported "54/54" on the one criterion it couldn't
machine-check, and offered a human `Accept (override)`. The *defect* is planner/contract
quality: "comprehensive test coverage" should be a `command`/`gate` assertion (`bun test`
green; optionally a coverage-threshold command), which is independently verifiable and
would auto-promote to `ready`.

**Fix.** Teach the contract proposer / per-thread planner to prefer executable
(`command`/`gate`) assertions and reserve `live-critic` for criteria that genuinely need a
live surface (UI/UX). When no dev URL exists, a `live-critic` blocker is unverifiable by
construction — steer the planner away from it, or degrade coherently. Ties into the tracked
"verify-coherence / dev-server-for-verify" and "promotable-skip vs needs-review" findings.

## Finding 4 — threads ran single-agent; per-thread fan-out not autonomously chosen (MEDIUM)

**Observation.** Every thread (scaffold / semantics / errors) executed a single-step,
single-agent build (the `dev → dev → careful` attempt loop) — no intra-thread multi-agent
fan-out.

**Assessment.** Not a capability gap: multi-agent disjoint-writer fan-out is proven to work
end to end (earlier CLI e2e reached `ready` with a 2-agent build step after the
stray-detection fix `a252432`). And the run *did* parallelize — at the **weave** level: the
root split into 3 threads and ran semantics ∥ errors concurrently. What did **not** happen:
the LLM per-thread planner autonomously authoring a fan-out for a subgoal (in the proof, the
fan-out DAG was hand-authored to validate execution).

**Follow-up.** Confirm/tune the per-thread planner to fan out when a subgoal decomposes into
disjoint files. Also **minor:** the executed per-thread workflow is not persisted to the
loom (`workflow` absent in loom.json even when `runThreadWorkflow` ran), so the cockpit
can't display a thread's step-DAG — consider persisting it for observability.
