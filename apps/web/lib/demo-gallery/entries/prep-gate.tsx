// LANE: prep-gate (UX BRAINSTORM 2026-07-23) — OWNED by the loom UX/UI
// session. FINAL: the gate room, merged from proposals A (war table) and B
// (two-handed gate) per the session verdict "a mixture of both, leaning B".
// The DAG is a pan/zoom map center-stage; conversations open in a dominant
// left pane; the gate is itself a node whose session steers and verdicts.
// Components under apps/web/lib/demo-gallery/prep-gate/**. Not part of the
// frozen six-lane redesign pass.
import type { DemoEntry } from "../registry";
import { PrepGateDemo } from "../prep-gate/gate";

export const prepGateEntries: DemoEntry[] = [
  {
    id: "prep-gate-final",
    title: "Readiness gate — the gate room",
    concern: "ux-prep-gate",
    variant: "Final · map center-stage, conversation-dominant panes",
    summary:
      "The merged design. The preparation DAG lives in the middle as a MAP: grab to pan, scroll to zoom (anchored at your cursor), rounded 90° elbow edges, and node text that never truncates. Click any node and the proportions INVERT: a left pane takes most of the width with that node's session — chat history rail (the opening has two sessions), '+ new chat' on any node, composer with 'talking is free' — while the map shrinks to the side and glides its zoom onto the node you're in. The gate is a node like any other: its conversation is the steering chat (chips fire real edits — wake the PRD delta, drop the e2e thread, ask why R7 was dropped) and its pane carries the verdict: unprovables before spend, the degraded-mode acknowledgment gating Accept, Modify on the go, Deny → straight to dev. The full PRD arc plays either by talking (gate chip) or touching (wake button in the node): drafting sessions run on the map, advance_node waits for your approval, and approving grows a new elbow edge into the flow compile — 1 of 2 audited recompiles, plan gaining its prd-alignment thread.",
    Component: PrepGateDemo,
  },
];
