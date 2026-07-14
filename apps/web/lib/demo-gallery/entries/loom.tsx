// LANE: loom — OWNED by the loom redesign lane. Registers the Loom view +
// Thread-drawer candidates. Demo components live under
// apps/web/lib/demo-gallery/loom/**.
import type { DemoEntry } from "../registry";
import { ThreadDrawerDemo } from "../loom/thread-drawer";
import { WeaveOrgChart } from "../loom/weave-orgchart";
import { MissionControl } from "../loom/mission-control";
import { MediationLedger } from "../loom/mediation-ledger";
import { AgentCompare } from "../loom/agent-compare";

export const loomEntries: DemoEntry[] = [
  {
    id: "loom-thread-drawer",
    title: "Thread drawer — 2–3 level",
    concern: "6.1",
    summary:
      "Replaces the single-level agent Sheet with a leveled drawer: L1 overview (status, glance stats, mediation summary) → L2 anatomy (step timeline, gate results, the full mediation ladder) or a focused agent lane → L3 the agent's transcript (turns + collapsible tool calls). Breadcrumb between levels, Esc backs out one level, and a copyable deep-link chip makes each level feel addressable. Open the escalated 'Saved filters' thread for the deep ladder.",
    Component: ThreadDrawerDemo,
  },
  {
    id: "loom-weave-orgchart",
    title: "Loom view — weave org-chart",
    concern: "6",
    variant: "Variant A: weave org-chart",
    summary:
      "The weave made spatial instead of tab-buried: orchestrator → threads → agents as a live-colored org-chart. Each thread node carries its agent lane and a mediation-depth badge (thread / orchestrator / you); selecting a thread lights up its dependency chain. A live activity timeline rides alongside.",
    Component: WeaveOrgChart,
  },
  {
    id: "loom-mission-control",
    title: "Loom view — mission control",
    concern: "6",
    variant: "Variant B: verification hero",
    summary:
      "Leads with the one gate the doctrine keeps: a verification hero over the composed whole (segmented weave progress, gates/critics/repairs, the moat note that only a human accept writes done). Below it, status-dense thread rows expand in place to reveal steps, gates, and the mediation ladder — less scrolling, more above-the-fold signal.",
    Component: MissionControl,
  },
  {
    id: "loom-mediation-ledger",
    title: "Mediation ledger",
    concern: "extra",
    summary:
      "A weave-wide account of the doctrine's escalation ladder — thread inner loop → orchestrator mediation → you — so a human arriving at a needs-review can see exactly how far the autonomy climbed and what it tried at each rung before it stopped, never fabricating a green it couldn't prove.",
    Component: MediationLedger,
  },
  {
    id: "loom-agent-compare",
    title: "Parallel-lane transcript compare",
    concern: "extra",
    summary:
      "A fanned-out thread's parallel builders shown side by side under the operator that merged them — the 'isolated worktrees, merged on green' story in one view, instead of paging through one lane's transcript at a time.",
    Component: AgentCompare,
  },
];
