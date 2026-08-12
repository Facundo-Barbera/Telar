// LANE: birth (UX BRAINSTORM 2026-07-23) — OWNED by the loom UX/UI session.
// FROM SESSION TO LOOM, per doctrine (twice corrected): the session's entire
// role in a birth is the original premise + maybe some context; the loom
// detaches, and its preparation graph — a true DAG of sessions — belongs to
// the LOOM's own UI (UX 4), never the session's. Below the simple-task
// boundary, work stays a session. Components under
// apps/web/lib/demo-gallery/birth/**. Not part of the frozen six-lane pass.
import type { DemoEntry } from "../registry";
import { LoomBirthDemo } from "../birth/birth";

export const birthEntries: DemoEntry[] = [
  {
    id: "birth-dial",
    title: "From session to loom",
    concern: "ux-birth",
    variant: "The session hands over premise + context — nothing more",
    summary:
      "Every loom is born from a session, and the session's whole part is small on purpose: you ask (real sessions UI — production bubbles, working indicator, composer), and the agent either does it right there ('Do it here' — the simple-task boundary: no loom, no graph, done inline with a screenshot) or spins off a loom. Spinning off leaves exactly two things in the chat: a detach marker and a receipt of what was handed over — the premise and this chat's context, spelled out in one mono line. No graph preview, no progress narration, no loom door inside the session: the preparation graph is part of the loom itself and lives on the loom's own pages (UX 4 — where it is now a true branching DAG whose every node runs its own conversation). The session stays a session.",
    Component: LoomBirthDemo,
  },
];
