// LANE: loom-detail (UX BRAINSTORM 2026-07-23) — OWNED by the loom UX/UI
// session. FINAL DESIGN: the walkable cockpit, one UI in two variants —
// baseline load and heavy load with a live escalation. All earlier proposals
// (three rooms, mission control, flight log, standalone thread/orchestrator/
// session views) were converged into or superseded by these two; their
// drill-ins live inside. Components under apps/web/lib/demo-gallery/
// loom-detail/**. Not part of the frozen six-lane redesign pass.
import type { DemoEntry } from "../registry";
import { LoomWalkableDemo } from "../loom-detail/walkable";
import { LoomScaleDemo } from "../loom-detail/walkable-scale";

export const loomDetailEntries: DemoEntry[] = [
  {
    id: "loom-detail-walkable",
    title: "Loom — final design",
    concern: "ux-loom-detail",
    variant: "Final · baseline load (ozom, nothing needs you)",
    summary:
      "The finalized loom cockpit at calm: ozom's client-role-seeding mid-flight, zero escalations — the state the loom should live in most of the time. Spine: Prepare / Execute / Judge as persistent act tabs with state in the labels; park/kill verbs live in the header (park keeps the window warm, kill archives branch + evidence — two clicks). Prepare = the SAME DAG map as the gate room (UX 4), sealed as the receipt of planning — pan, zoom, dormant PRD hanging dashed, the gate node stamped 'accepted 07:24' — with the Opening-conversation node opening the intake session: drift report, your steering edits as markers, and the gate as the conversation's last message. Execute = the conductor pinned (holds no pen, beat vs flatline) over three thread lanes; ui-client-nav drills into the team view: compiled flow with per-node manifests, builder lanes in worktrees, thread-altitude rungs, and per-agent transcripts in a right drawer with lane B streaming live. Judge = the contract, 5/9 lit while work runs. Header: the WINDOW (warm lane :4310, merged-so-far), the LAB (service registry — scopes, lease token, live verify panel under the repo mutex), and CHATS (steering thread always open; intake reopenable).",
    Component: LoomWalkableDemo,
  },
  {
    id: "loom-detail-walkable-scale",
    title: "Loom — final design, at scale",
    concern: "ux-loom-detail",
    variant: "Final · heavy load, live escalation (novarix)",
    summary:
      "The same cockpit under load — scale changes the numbers, never the role model: novarix P12 usage-based billing, 11 threads across 3 workstreams (labels from the interference analysis — provenance flagged as a this-session proposal; sub-orchestration stays per thread). One conductor pinned (7 mediations, 1 escalation); dense thread rows grouped by workstream; rates-engine drills into a 5-lane flow with its recompile budget exhausted (next re-plan escalates to the orchestrator). The live escalation path on display: amber attention strip under the tabs, pinned row in chats · 3, '1 needs you' on the Execute tab, the amber thread row routing straight into the pending conversation — attempt-history pill, quick chips, composer as the resume button. Ladder: inner ×14 → mediation ×7 → you ×1. Prepare is the gate room's DAG map at its heavy end, sealed — five drift-spawned sessions blooming from the opening, closing through interference + readiness into the stamped gate — plus the reality manifest (synthetic tax, declared at the gate); park/kill verbs in the header; the on-demand WINDOW borrows the stack under the fleet semaphore; the LAB shows stripe-mock deliberately not leased.",
    Component: LoomScaleDemo,
  },
];
