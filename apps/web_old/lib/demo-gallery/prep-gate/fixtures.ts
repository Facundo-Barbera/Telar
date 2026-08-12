// LANE: prep-gate (UX brainstorm 2026-07-23) — the pre-gate moment.
// Continuity: novarix's search-filters, shown in the home fleet as "prepare ·
// drafting the preparation graph". Here it is 40 minutes later: node-sessions
// done, the gate OPEN, nothing spent yet.
//
// Doctrine: the graph is part of the LOOM (never the session's UI); it is a
// TRUE DAG — nodes divide, everything converges into the gate. Each node is
// a session surface holding MULTIPLE conversations (history + add more), and
// agents advance a node only through an approval-gated tool call — a PRD can
// take a couple of sessions to define.
//
// Grounding: gate verdicts Accept / Modify-on-the-go / Deny→straight-to-dev;
// promise 1 "I'll tell you what I can't prove — before you spend";
// degradation is a prep-time concern; intake state-diff; bounded audited
// recompiles; accept collects the degraded-mode override acknowledgment.

export type ConvoTurn = { who: string; text: string };

export type NodeChat = {
  id: string;
  title: string;
  when: string;
  state: "closed" | "open";
  turns: ConvoTurn[];
  proposal?: string; // pending advance_node tool call — awaits YOUR approval
};

export type PrepGraphNode = {
  id: string;
  title: string;
  sub: string; // SHORT — must fit one line on the map, never cut
  detail: string; // full text — shown when the node expands on select
  state: "done" | "dormant";
  x: number; // horizontal center, 0..1 — the DAG's layout coordinate
  row: number; // depth level, top → down
  chats: NodeChat[]; // every node is a session surface — with history
};

// Edges as [from, to]. The prd edge into flow-compile exists only once the
// dormant node is woken and its draft APPROVED — advancing GROWS the graph.
export const EDGES: [string, string][] = [
  ["living-model", "opening"],
  ["opening", "context"],
  ["opening", "search-delta"],
  ["opening", "prd"],
  ["context", "intake-diff"],
  ["search-delta", "filter-tax"],
  ["search-delta", "ranking"],
  ["intake-diff", "readiness"],
  ["filter-tax", "flow-compile"],
  ["ranking", "flow-compile"],
  ["readiness", "gate"],
  ["flow-compile", "gate"],
];

export const WOKEN_EDGE: [string, string] = ["prd", "flow-compile"];

export const LOOM = {
  project: "novarix",
  title: "Search filters on orders",
  branch: "loom/search-filters",
  meta: "preparing since 08:55 · $0.40 spent · nothing executes before the gate",
};

export const NODES: PrepGraphNode[] = [
  {
    id: "living-model",
    title: "Living model",
    sub: "map · orders region",
    detail: "orders region read · drift found in the search norms — 3 views ship ad-hoc filters",
    state: "done",
    x: 0.5,
    row: 0,
    chats: [
      {
        id: "lm-1",
        title: "map read",
        when: "08:57",
        state: "closed",
        turns: [
          { who: "loom", text: "reading the orders region · comparing your premise to the map" },
          {
            who: "loom",
            text: "drift found: 3 list views ship ad-hoc filters the map doesn't know — flagged for the opening",
          },
        ],
      },
    ],
  },
  {
    id: "opening",
    title: "Opening conversation",
    sub: "you + intake · 2 sessions",
    detail: "you + intake · drift report filed, scope pinned to orders only",
    state: "done",
    x: 0.5,
    row: 1,
    chats: [
      {
        id: "op-1",
        title: "drift report",
        when: "08:58",
        state: "closed",
        turns: [
          {
            who: "intake",
            text: "Search today is prefix-only over order ids. Your premise asks filters over status, customer, totals, dates — the map's search norms drift three ways from that.",
          },
          { who: "you", text: "Show me the three." },
          {
            who: "intake",
            text: "Ad-hoc filters in 3 list views, no shared query layer, no ranking contract. Drift report filed.",
          },
        ],
      },
      {
        id: "op-2",
        title: "scope pinning",
        when: "09:03",
        state: "closed",
        turns: [
          { who: "intake", text: "Scope check: orders only, or does the customers list ride along?" },
          { who: "you", text: "Orders only. The customers list comes later." },
          {
            who: "intake",
            text: "Pinned. Two concerns diverge from here — search behavior and the filter set. Branching.",
          },
        ],
      },
    ],
  },
  {
    id: "context",
    title: "Context gathering",
    sub: "12 files read",
    detail: "orders api + list views + query hooks · ad-hoc filter code flagged in 3 views",
    state: "done",
    x: 0.15,
    row: 2,
    chats: [
      {
        id: "cx-1",
        title: "survey",
        when: "09:07",
        state: "closed",
        turns: [
          { who: "surveyor", text: "12 files read: orders api, list views, query hooks" },
          { who: "surveyor", text: "ad-hoc filter code found in 3 views — flagged for consolidation" },
        ],
      },
    ],
  },
  {
    id: "search-delta",
    title: "Search behavior delta",
    sub: "split: taxonomy + ranking",
    detail: "drift-spawned · tokenizer settled, then divided into taxonomy and ranking branches",
    state: "done",
    x: 0.55,
    row: 2,
    chats: [
      {
        id: "sd-1",
        title: "behavior notes",
        when: "09:10",
        state: "closed",
        turns: [
          { who: "delta", text: "tokenizer settled: simple prefix + trigram" },
          {
            who: "delta",
            text: "taxonomy and ranking are diverging concerns — dividing this node into two branches",
          },
        ],
      },
    ],
  },
  {
    id: "prd",
    title: "PRD delta",
    sub: "no drift — never spawned",
    detail: "no drift against the PRD — wake it to force a PRD pass (approval-gated)",
    state: "dormant",
    x: 0.87,
    row: 2,
    chats: [
      {
        id: "prd-0",
        title: "dormant",
        when: "—",
        state: "closed",
        turns: [
          { who: "loom", text: "no drift against the PRD — this session never ran" },
          {
            who: "loom",
            text: "wake it to force a PRD pass — its sessions run, and advancing needs your approval",
          },
        ],
      },
    ],
  },
  {
    id: "intake-diff",
    title: "Intake diff",
    sub: "clean — recipe trusted",
    detail: "project state hash matches the last run — recipe trusted, no re-prove boot",
    state: "done",
    x: 0.15,
    row: 3,
    chats: [
      {
        id: "id-1",
        title: "state diff",
        when: "09:12",
        state: "closed",
        turns: [
          { who: "loom", text: "project state hash matches the last run" },
          { who: "loom", text: "recipe trusted — no re-prove boot spent" },
        ],
      },
    ],
  },
  {
    id: "filter-tax",
    title: "Filter taxonomy delta",
    sub: "9 dims from schema",
    detail: "9 filter dimensions derived from the orders schema · 3 cheap (indexed columns)",
    state: "done",
    x: 0.48,
    row: 3,
    chats: [
      {
        id: "ft-1",
        title: "taxonomy",
        when: "09:14",
        state: "closed",
        turns: [
          { who: "delta", text: "9 filter dimensions derived from the orders schema" },
          { who: "delta", text: "3 marked cheap — already-indexed columns" },
        ],
      },
    ],
  },
  {
    id: "ranking",
    title: "Ranking delta",
    sub: "recency-weighted",
    detail: "recency-weighted ranking, ties by order id · verifiable against golden orders",
    state: "done",
    x: 0.82,
    row: 3,
    chats: [
      {
        id: "rk-1",
        title: "ranking",
        when: "09:15",
        state: "closed",
        turns: [
          { who: "delta", text: "recency-weighted ranking, ties broken by order id" },
          { who: "delta", text: "cheap to verify against golden orders — noted for the contract" },
        ],
      },
    ],
  },
  {
    id: "readiness",
    title: "Verification readiness",
    sub: "1 degraded mode declared",
    detail: "recipe next-dev + postgres proven in 38s · SEARCH_API absent → synthetic index declared",
    state: "done",
    x: 0.3,
    row: 4,
    chats: [
      {
        id: "rd-1",
        title: "lab standup",
        when: "09:20",
        state: "closed",
        turns: [
          { who: "lab", text: "recipe: next-dev + postgres · lab stood up and torn down in 38s" },
          { who: "lab", text: "SEARCH_API key absent → search index synthetic, declared before spend" },
        ],
      },
    ],
  },
  {
    id: "flow-compile",
    title: "Flow compile",
    sub: "11 subgoals · 4 threads",
    detail: "branches converged: 11 subgoals · 4 threads · 2 lanes · results-ui ↔ query-parser serialized",
    state: "done",
    x: 0.66,
    row: 4,
    chats: [
      {
        id: "fc-1",
        title: "compile",
        when: "09:24",
        state: "closed",
        turns: [
          { who: "compiler", text: "branches converged: 11 subgoals over 4 threads" },
          {
            who: "compiler",
            text: "interference: results-ui ↔ query-parser share query hooks — serialized",
          },
        ],
      },
    ],
  },
];

// The PRD node's drafting arc once woken: it takes a couple of sessions to
// define a PRD — and advancing out of the node is an approval-gated tool.
export const PRD_DRAFTING_CHATS: NodeChat[] = [
  {
    id: "prd-1",
    title: "premise sweep",
    when: "09:37",
    state: "closed",
    turns: [
      { who: "planner", text: "reading premise + drift report — no existing PRD section covers search" },
      { who: "planner", text: "sweep done; drafting next session" },
    ],
  },
  {
    id: "prd-2",
    title: "PRD draft",
    when: "09:38",
    state: "open",
    turns: [
      {
        who: "planner",
        text: "Drafting the PRD delta: filters over orders as a product surface — scope, non-goals, measures.",
      },
      {
        who: "planner",
        text: "Draft v2 ready: 8 requirements, 2 non-goals. The alignment thread will hold execution to it.",
      },
    ],
    proposal:
      "advance_node · PRD delta satisfied by draft v2 — adds the prd-alignment thread to the plan",
  },
];

export const PRD_WOKEN: PrepGraphNode = {
  ...NODES.find((n) => n.id === "prd")!,
  sub: "advanced — thread queued",
  detail: "advanced with your approval · prd-alignment thread queued · edge grown into the flow compile",
  state: "done",
  chats: PRD_DRAFTING_CHATS,
};

// Flow-compile output preview — what Accept hands to the orchestrator.
export type PlanPreview = {
  line: string;
  threads: string[];
  contract: string;
  estimate: string;
};

export const PLAN: PlanPreview = {
  line: "11 subgoals · 4 threads · 2 lanes",
  threads: ["filter-taxonomy", "query-parser", "results-ui", "e2e-search-path"],
  contract: "7 asserts · R4–R5 synthetic without SEARCH_API · R7 dropped",
  estimate: "estimate: $5–8 · ~4h wall-clock",
};

export const PLAN_WOKEN: PlanPreview = {
  line: "13 subgoals · 5 threads · 2 lanes",
  threads: [
    "filter-taxonomy",
    "query-parser",
    "results-ui",
    "e2e-search-path",
    "prd-alignment",
  ],
  contract: "8 asserts · R4–R5 synthetic without SEARCH_API · R7 dropped",
  estimate: "estimate: $6–10 · ~5h wall-clock",
};

// Promise 1: what can't be proven, said before any spend.
export const GATE = {
  unprovables: [
    "SEARCH_API key absent — relevance runs on a synthetic index; R4–R5 marked synthetic in the contract",
    "no golden dataset for typo tolerance — R7 unprovable, dropped from the contract",
  ],
  diffLine: "intake diff clean — recipe trusted, no re-prove",
  ack: "run degraded: synthetic search index · narrowed contract (R4–R5 synthetic, R7 dropped)",
  acceptedLine:
    "accepted 09:41 · graph locked as the receipt · handed to the orchestrator — Execute begins",
  deniedLine:
    "denied → straight to dev: a direct session opens on novarix with the graph attached as notes · the loom stands down",
  recompileLine: "flow recompiled · 1 of 2 audited recompiles used",
};
