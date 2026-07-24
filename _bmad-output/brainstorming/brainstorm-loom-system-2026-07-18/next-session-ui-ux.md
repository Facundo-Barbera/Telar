# Next Session — UI/UX Rebuild

> Deferred from the 2026-07-18 loom brainstorm: the redesigned loom likely demands a rebuilt UI/UX experience. This brief seeds that session; the full log is `.memlog.md`.

## Why it was deferred

The UI brainstorm deserves the converged loom redesign as its *input* — designing surfaces for a system whose shape was still moving would have wasted the batch. The spine is now locked (three acts: prepare / execute / judge); the UI session designs the cockpit around it.

## Opening inventory (from the log)

- *(user)* **Preparation graph view**: same-sized blocks, flowing left → right, connected with lines so multi-dependencies and branching are visible. Mockup exists: `preparation-graph.html` (telar-styled, v3 — no auto write-back).
- *(user)* Accept screen = **evidence + proof + synthesized narrative** of what happened and what was implemented.
- *(coach)* At fleet scale the accept surface becomes an **inbox of delivery cards** — claim, proof, risk flags — skimmable in seconds; read 7 over coffee, accept 5, bounce 2.
- *(user + coach)* **Windows, not doorbells**: mid-flight checking is a user *choice* (always-on pull observability), never an obligation; push notifications only for dire escalations. The UI must make the window ambient and the doorbell rare.
- *(user)* **Orchestrators get their own role in the UI** — the conductor/developer distinction must be visible; conductors never touch code.
- *(user)* **Pause/resume state** must be first-class: looms park on credit exhaustion and resume later — the UI needs park/resume affordances and clear "why paused" states.
- *(coach)* **Early kill**: streaming evidence (screenshots mid-run) should make killing a wrong-direction loom at 20% spend a one-glance, one-click act.
- *(user)* Readiness gate controls: **Accept / Modify (on the go) / Deny → straight to dev** — modify-on-the-go implies direct manipulation of the graph.
- *(coach)* The **map** as a first-class surface: regions with drift states, the thing intake diffs against.
- *(existing tokens to honor or evolve)* grayscale chrome, hue = state only, tone system (done/attention/danger/active/muted), 3px state rails, tinted-outline badges, orgchart rail-and-tick views.

## Starting questions

1. What is the **home screen** of the redesigned telar — the fleet inbox, the planner seat, or the map? What does "glanceable" mean for 7 concurrent looms?
2. How does **modify-on-the-go** feel — dragging nodes on the preparation graph, a conversational side panel, or both?
3. What does a **delivery card** actually show, in order, in ~15 seconds of attention? What earns a tap-through?
4. How do the three acts (prepare / execute / judge) map to navigation — three spaces, one timeline, or a single loom detail with phases?
5. Does the current visual language survive the rebuild (quiet grayscale + state hues), or does the fleet-scale cockpit need a new layer (density, sparklines, activity ambient)?
