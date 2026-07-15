// LANE: loom — OWNED by the loom redesign lane. Registers the Loom view +
// Thread-drawer candidates. Demo components live under
// apps/web/lib/demo-gallery/loom/**.
import type { DemoEntry } from "../registry";
import { MediationLedger } from "../loom/mediation-ledger";
import { AgentCompare } from "../loom/agent-compare";
import { WeaveAnchorRailDemo } from "../loom/weave-view";

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
  {
    id: "loom-weave-anchor-rail",
    title: "Weave view: anchor + rail",
    concern: "extra",
    variant: "Anchor + rail god-view redesign",
    summary:
      "The proposed god-view redesign, now three tabs. WEAVE (default): a left RAIL of compact thread lanes (status dot, name, one-line current activity — the orchestrator pinned above them, not a lane) and a main ANCHOR showing the focused item's full cockpit — its tick line (plan → schedule → observe → decide), the live escalation state, and its recent-decisions log; click a rail lane to focus it. VERIFY: its own full tab, not a rail item — the moat sentence, a contract summary chip, and the P10 verification contract's 9 assertions (id, type, description, state, run command), 1 failing flagged with a red dot on the tab label itself. CHAT: also its own full tab — the steerer conversation about that same P10-B escalation, plus a pinned composer. Real content — P10 · Carga lite + Vista cliente, threads 'Client role + access seeding' and 'Foundation — pd.campaign_plan schema…', the mediation-exhausted escalation on subgoal P10-B.",
    Component: WeaveAnchorRailDemo,
  },
];
