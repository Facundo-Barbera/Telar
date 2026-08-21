# docs/plans

Design specs and cut plans for work that is being *designed*, not yet built.

A plan lives here while it is the working reference for an in-flight change. It
states what is being built, why the current thing is inadequate, and the ordered
sequence to get there. When the change lands, the plan either becomes reference
documentation elsewhere or is deleted — a plan that describes shipped code is
worse than no plan, because it reads as current and is not.

## Rules

- **One plan per file, named for the thing.** `orchestrator.md`, not `q3-refactor.md`.
- **Ground every claim.** A statement about existing behavior cites the file and
  line that makes it true. The previous doc set was deleted for drifting off the
  code; the cure is citation, not more prose.
- **Say what is dropped.** A design that only lists additions hides its cost.
- **No status theater.** No progress bars, no percentages, no "✅ DONE" columns.
  Git history is the record of what happened.

## Index

| Plan | What | Status |
| --- | --- | --- |
| [`orchestrator.md`](./orchestrator.md) | Perpetual dispatch-only agent: discovers a project's own conventions and gates, dispatches looms into worktrees, wakes on a cheap sentinel. Replaces looms v1. | Draft — not approved |
| [`loom-build.md`](./loom-build.md) | The buildable spec: four command slots, tri-state gates, the escalation ladder, persistence split. Answers every open question in `orchestrator.md`. | Building |
| [`ozom-gv-setup.md`](./ozom-gv-setup.md) | The design tested against a real repo: what setup finds, asks, writes, and dry-runs. Facts verified 2026-08-19; dialogue constructed. | Companion |
