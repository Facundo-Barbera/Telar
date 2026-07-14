// LANE: loom — OWNED by the loom redesign lane. Registers the Loom view +
// Thread-drawer candidates. Demo components live under
// apps/web/lib/demo-gallery/loom/**.
import type { DemoEntry } from "../registry";
import { MediationLedger } from "../loom/mediation-ledger";
import { AgentCompare } from "../loom/agent-compare";

export const loomEntries: DemoEntry[] = [
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
