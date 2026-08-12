// LANE: ultra (NEW) — round 26. Renders the frozen UI CONTRACT (§6 of
// docs/plans/ultra-harness.md) for an Ultra run inside a chat session.
// Demo components live under apps/web/lib/demo-gallery/ultra/**.
import type { DemoEntry } from "../registry";
import { SessionUltraDemo } from "../ultra/session-ultra";

export const ultraEntries: DemoEntry[] = [
  {
    id: "session-ultra",
    title: "Session — Ultra runs",
    concern: "extra",
    variant: "Side-quest anchors + Workflows rail + dock",
    summary:
      "Ultra UI contract v2 (ultra-harness §6, frozen): Ultra runs as side quests inside a chat session. The main agent launches three — “Quick-wins batch” (completed), a doc sweep (running), a flake triage it later STOPS by tool call. Each is ONE compact fixed-height ANCHOR in the transcript (name · state · agents done/total · spend · progress); completing collapses it to a one-liner. Clicking focuses the run in the existing sub-agent RAIL, now with a Workflows section: run cards, phase groups, per-agent rows (label · state · model·effort chip · masked-shimmer snippet · tokens/cost), a fixed-height narrator log(), a read-only Script tab. The story shows a model-validation rejection → re-author, launching, and reacting to a completion. No budget UI — spend readouts only. Stopped → Resume; a dock bubble summarizes live runs. Play/Pause/Restart/speed on virtual time. Both themes, fixtures.",
    Component: SessionUltraDemo,
  },
];
