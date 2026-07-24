// LANE: home (UX brainstorm 2026-07-23) — the FINAL home's shared morning:
// 7 looms in flight across 5 projects, exactly 2 blocked on a human. The
// same fleet the other lanes reference (payments-retry delivers in UX 3,
// search-filters preps in UX 4), so the gallery stays one world.

export type FleetPhase =
  | "prepare"
  | "build"
  | "verify"
  | "repair"
  | "ready"
  | "blocked"
  | "parked";

export type FleetLoom = {
  id: string;
  project: string;
  title: string;
  phase: FleetPhase;
  activity: string; // one-line current activity, present tense
  started: string;
  spend: string;
  progress?: number; // subgoals done, as a percentage
  evidence?: { label: string; age: string }; // latest streaming artifact
  claim?: string; // ready only: the one-sentence delivery claim
  proof?: string; // ready only: assertion tally + artifact counts
  risk?: string; // ready only: the flag a human should read before accepting
  question?: string; // blocked only: the parked question, verbatim
  parked?: string; // parked only: why + when it resumes
  repair?: string; // repair only: what failed + attempt count
};

export const FLEET: FleetLoom[] = [
  {
    id: "payments-retry",
    project: "aurora",
    title: "Payments retry with backoff",
    phase: "ready",
    activity: "verified — waiting for your accept",
    started: "06:10",
    spend: "$4.80",
    progress: 100,
    evidence: { label: "retry-flow.png", age: "12m" },
    claim:
      "Failed payments now retry 3× with exponential backoff, then dead-letter with an operator note.",
    proof: "9/9 assertions · 6 screenshots · +412 −88",
    risk: "touches billing env vars",
  },
  {
    id: "csv-export-sunset",
    project: "bixku",
    title: "Sunset the CSV export",
    phase: "blocked",
    activity: "parked on a question since 08:31",
    started: "07:44",
    spend: "$1.10",
    progress: 30,
    question:
      "Two export buttons exist — toolbar and row menu. Sunset both, or keep the row-level one?",
  },
  {
    id: "campaign-plan-schema",
    project: "ozom",
    title: "P10 · campaign_plan schema",
    phase: "build",
    activity: "migrating pd.campaign_plan · seeding fixtures",
    started: "07:02",
    spend: "$2.30",
    progress: 62,
    evidence: { label: "schema-diff.png", age: "4m" },
  },
  {
    id: "client-role-seeding",
    project: "ozom",
    title: "P10 · client role + access seeding",
    phase: "verify",
    activity: "verify panel driving checkout as the client role",
    started: "07:15",
    spend: "$3.10",
    progress: 88,
    evidence: { label: "login-as-client.png", age: "1m" },
  },
  {
    id: "invoice-rounding",
    project: "novarix",
    title: "Invoice rounding on receipts",
    phase: "repair",
    activity: "repairing: rounding drift on receipt totals",
    started: "06:48",
    spend: "$5.60",
    progress: 71,
    evidence: { label: "receipt-fail.png", age: "9m" },
    repair: "verify failed 2/9 · repair attempt 2 of 3",
  },
  {
    id: "notes-pin-per-screen",
    project: "telar",
    title: "Notes pin per-screen",
    phase: "parked",
    activity: "parked — credit window exhausted",
    started: "09:20",
    spend: "$0.90",
    progress: 18,
    parked: "personal window exhausted 11:20 · resumes 14:00",
  },
  {
    id: "search-filters",
    project: "novarix",
    title: "Search filters on orders",
    phase: "prepare",
    activity: "orchestrator drafting the preparation graph · 9 nodes",
    started: "08:55",
    spend: "$0.40",
  },
];

// Per-project drift state — what intake would diff
// against. Regions with no loom still exist; quiet is a state, not absence.
export const REGION_META: Record<
  string,
  { drift: "in sync" | "drifting" | "quiet"; note: string }
> = {
  aurora: { drift: "in sync", note: "map updated from this morning's accept" },
  ozom: { drift: "in sync", note: "P10 · carga lite region, 2 looms active" },
  novarix: { drift: "drifting", note: "2 changes since Mon not on the map" },
  bixku: { drift: "in sync", note: "intake diffed clean yesterday" },
  telar: { drift: "quiet", note: "no intake since Friday" },
};
