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
    variant: "In-transcript run block + SubagentRail inspector + dock",
    summary:
      "The frozen Ultra UI contract (ultra-harness §6): the main agent authors “Quick-wins batch — recon → 3 lanes → gate → commit” (8 subagents). A durable in-transcript RUN BLOCK holds the header (name, state pill, reservation-based budget meter, agent count), collapsible phase groups, per-agent rows (label · state · shimmering activity snippet · token/cost), and an interleaved narrator log(). Press Play: phases activate in order, rows tick queued→running→done, one lane returns null and is re-spawned, tokens count up, then the result lands. Terminal chips reach completed / stopped (journal + Resume) / failed-budget. The SubagentRail inspector holds the per-agent transcript, read-only script+meta, and a per-phase budget meter; Stop + a dock bubble act on the run. Provider switch shows both backends — on Codex the USD ceiling is honestly blocked (Q4). Masked shimmer, both themes, fixtures.",
    Component: SessionUltraDemo,
  },
];
