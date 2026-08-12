// LANE: loom-detail (UX brainstorm 2026-07-23) — the AT-SCALE fixture: a
// deliberately heavy loom to stress the walkable cockpit. 11 threads across
// 3 workstreams, a 5-lane thread with its recompile budget exhausted, a
// 16-assertion contract in 3 groups, and a declared degraded mode (reality
// manifest). If the layout survives this, it survives real mornings.
import type { DagNodeSpec } from "../prep-gate/shared";

import type { LabService } from "./fixtures";

export const LOOM2 = {
  project: "novarix",
  id: "p12-usage-billing",
  title: "P12 · usage-based billing overhaul",
  goal: "Metered usage becomes billable: rating, proration, tax, invoices — and a safe backfill of 14 months of history.",
  started: "06:32",
  spend: "$18.40",
  budget: "$40.00",
  subgoalsDone: 9,
  subgoalsTotal: 21,
};

export type ScaleState = "done" | "build" | "verify" | "repair" | "blocked" | "wait";

export type ScaleThread = {
  id: string;
  state: ScaleState;
  activity: string;
  evidenceAge?: string;
};

// Workstreams are LABELS from the interference analysis, not agents —
// sub-orchestration is per thread (each thread's main agent). One
// orchestrator conducts all eleven.
export type Workstream = {
  id: string;
  threads: ScaleThread[];
};

export const WORKSTREAMS: Workstream[] = [
  {
    id: "rating-core",
    threads: [
      { id: "rates-engine", state: "build", activity: "5 lanes · overage calc + rounding in flight", evidenceAge: "2m" },
      { id: "proration-rules", state: "verify", activity: "panel replaying month-boundary cases", evidenceAge: "1m" },
      { id: "usage-aggregator", state: "done", activity: "landed 07:54" },
      { id: "tax-adapter", state: "blocked", activity: "question for you — rounding: half-up vs half-even", evidenceAge: "1m" },
    ],
  },
  {
    id: "invoicing-ui",
    threads: [
      { id: "invoice-composer", state: "build", activity: "line-item grouping · totals from rating-core", evidenceAge: "3m" },
      { id: "usage-drilldown", state: "build", activity: "per-meter chart · retried flaky install (rung 0)", evidenceAge: "5m" },
      { id: "statement-pdfs", state: "wait", activity: "waits on: invoice-composer" },
      { id: "billing-settings", state: "done", activity: "landed 08:02" },
    ],
  },
  {
    id: "data-migration",
    threads: [
      { id: "backfill-engine", state: "build", activity: "replaying month 9 of 14 · throttled to 2 lanes", evidenceAge: "40s" },
      { id: "integrity-audit", state: "wait", activity: "waits on: backfill month 14" },
      { id: "cutover-plan", state: "done", activity: "landed 08:33" },
    ],
  },
];

export const ROOT_ORCH = {
  watching: "11 threads · 3 workstreams",
  beat: "40s",
  flatline: "12m",
  mediations: 7,
};

export const HEARTBEAT2: { time: string; text: string }[] = [
  { time: "09:21", text: "tax-adapter parked — question escalated to you" },
  { time: "09:19", text: "evidence frame from backfill-engine (month 9)" },
  { time: "09:12", text: "backfill throttled to 2 lanes — semaphore" },
  { time: "09:05", text: "proration-rules verify round started" },
  { time: "08:58", text: "invoice-composer landed line-item grouping on its lane" },
];

// ---- Prepare: 17 nodes over 4 dependency lanes — rendered as id-chips.
export type MiniNode = { id: string; state: "done" | "build" | "verify" | "wait" };

export const PREP_LANES: MiniNode[][] = [
  [
    { id: "schema", state: "done" },
    { id: "meters", state: "done" },
    { id: "rating", state: "build" },
    { id: "proration", state: "verify" },
    { id: "tax", state: "build" },
  ],
  [
    { id: "invoices", state: "build" },
    { id: "pdfs", state: "wait" },
    { id: "ui-composer", state: "build" },
    { id: "drilldown", state: "build" },
    { id: "settings", state: "done" },
  ],
  [
    { id: "backfill", state: "build" },
    { id: "audit", state: "wait" },
    { id: "cutover", state: "done" },
    { id: "seeds", state: "done" },
  ],
  [
    { id: "bench", state: "wait" },
    { id: "e2e", state: "wait" },
    { id: "docs", state: "wait" },
  ],
];

export const PREP_EDITS2 = [
  "you demoted real-time tax quotes to a Could — synthetic mode declared instead (06:38)",
  "you split backfill from cutover and added the integrity audit between them (06:39)",
  "you capped concurrent heavy lanes at 2 for this machine (06:40) — then locked",
];

export const READINESS2 =
  "recipe novarix-stack+postgres+worker stood up in 2m11s · readiness green 06:40";

export const DEGRADED2 =
  "declared mode: without STRIPE_TEST_KEY tax calc runs synthetic — contract narrowed at the gate";

// ---- Judge: 16 assertions in 3 groups (7 lit).
export type ScaleAssert = { id: string; desc: string; state: "pass" | "running" | "pending" };

export const CONTRACT2: { group: string; asserts: ScaleAssert[] }[] = [
  {
    group: "rating-core",
    asserts: [
      { id: "R1", desc: "metered usage rates per plan matrix", state: "pass" },
      { id: "R2", desc: "overage tiers compound correctly at boundaries", state: "pass" },
      { id: "R3", desc: "mid-cycle plan change prorates both halves", state: "running" },
      { id: "R4", desc: "currency rounding matches golden cases (4 currencies)", state: "pending" },
      { id: "R5", desc: "rate cache invalidates on plan edit", state: "pass" },
      { id: "R6", desc: "tax line present on every taxable invoice (synthetic mode)", state: "pass" },
    ],
  },
  {
    group: "invoicing-ui",
    asserts: [
      { id: "I1", desc: "invoice groups line items by meter then plan", state: "pass" },
      { id: "I2", desc: "drilldown chart totals equal invoice totals", state: "pending" },
      { id: "I3", desc: "statement PDF renders under 2s for 500-line invoice", state: "pending" },
      { id: "I4", desc: "billing settings gate who can issue credit notes", state: "pass" },
      { id: "I5", desc: "zero-usage month renders an explicit zero invoice", state: "pending" },
    ],
  },
  {
    group: "data-migration",
    asserts: [
      { id: "M1", desc: "backfilled months match legacy totals within $0.01", state: "pending" },
      { id: "M2", desc: "backfill is resumable from any checkpoint", state: "pass" },
      { id: "M3", desc: "dedupe guard: replaying a month is idempotent", state: "pending" },
      { id: "M4", desc: "integrity audit crosses 3 independent sums", state: "pending" },
      { id: "M5", desc: "cutover is reversible until the audit signs off", state: "pending" },
    ],
  },
];

export const PASS2 = CONTRACT2.flatMap((g) => g.asserts).filter(
  (a) => a.state === "pass",
).length;
export const TOTAL2 = CONTRACT2.flatMap((g) => g.asserts).length;

// ---- The 5-lane thread: rates-engine. Recompile budget exhausted (2 of 2).
export type ScaleLaneNode = { id: string; title: string; state: "done" | "build" | "wait" };

export type ScaleLane = {
  name: string;
  wt: string;
  state: "done" | "build" | "wait";
  nodes: ScaleLaneNode[];
};

export const RATE_LANES: ScaleLane[] = [
  {
    name: "pricing-matrix",
    wt: "wt-a",
    state: "done",
    nodes: [
      { id: "matrix-loader", title: "Plan matrix loader", state: "done" },
      { id: "plan-shapes", title: "Plan shape validation", state: "done" },
    ],
  },
  {
    name: "tier-rules",
    wt: "wt-b",
    state: "build",
    nodes: [
      { id: "threshold-eval", title: "Threshold evaluation", state: "done" },
      { id: "overage-calc", title: "Overage calculation", state: "build" },
    ],
  },
  {
    name: "currency-rounding",
    wt: "wt-c",
    state: "build",
    nodes: [
      { id: "rounding-policy", title: "Per-currency rounding policy", state: "build" },
      { id: "golden-cases", title: "Golden cases ×4 currencies", state: "wait" },
    ],
  },
  {
    name: "rate-cache",
    wt: "wt-d",
    state: "done",
    nodes: [
      { id: "cache-keys", title: "Cache keys per plan+meter", state: "done" },
      { id: "invalidation", title: "Invalidation on plan edit", state: "done" },
    ],
  },
  {
    name: "contract-tests",
    wt: "wt-e",
    state: "wait",
    nodes: [
      { id: "fixtures", title: "Rating fixtures", state: "wait" },
      { id: "property-suite", title: "Property suite over tiers", state: "wait" },
    ],
  },
];

export const RATE_SPINE = {
  top: [
    { id: "ctx", title: "Context gather", state: "done" as const },
    { id: "compile", title: "Flow compile (v3 after 2 recompiles)", state: "done" as const },
  ],
  tail: [
    { id: "integrate", title: "Integrate — merge 5 lanes on green", state: "wait" as const },
    { id: "bench", title: "Bench: 1M rating events under 90s", state: "wait" as const },
    { id: "self-check", title: "Self-check against the subgoal", state: "wait" as const },
  ],
};

export const RATE_RECOMPILES = [
  "recompile #1 · 06:58 — interference analysis fanned rating into 4 lanes · bounded 1 of 2",
  "recompile #2 · 08:12 — split currency-rounding out of pricing-matrix after golden-case failures · bounded 2 of 2 · BUDGET EXHAUSTED — next re-plan escalates to the orchestrator",
];

export const RATE_RUNGS = [
  { label: "typecheck clean", state: "pass" as const, age: "1m" },
  { label: "unit 214/214", state: "pass" as const, age: "4m" },
  { label: "review — 5 findings, 2 open", state: "run" as const, age: "live" },
  { label: "property suite", state: "queued" as const, age: "waits on lane E" },
  { label: "bench probe", state: "queued" as const, age: "waits on integrate" },
];

// ---- Root conductor drill-in panels.
export const DECISIONS2 = [
  { time: "09:21", text: "tax-adapter repair exhausted (3 of 3) → escalate to you; thread parked" },
  { time: "09:12", text: "throttle backfill-engine 4 → 2 lanes — heavy-infra semaphore, this machine" },
  { time: "09:01", text: "approve recompile #2 on rates-engine (2 of 2 — budget exhausted, flagged)" },
  { time: "08:47", text: "tax-adapter verify failed 1/4 → repair attempt 1 of 3, window only" },
  { time: "08:31", text: "route statement-pdfs behind invoice-composer — dependency edge added" },
  { time: "08:12", text: "mediate usage-drilldown: flaky chart-lib install → inner-loop retry (rung 0)" },
];

export const MERGE_QUEUE2 = [
  { id: "usage-aggregator", state: "landed 07:54" },
  { id: "billing-settings", state: "landed 08:02" },
  { id: "cutover-plan", state: "landed 08:33" },
  { id: "proration-rules", state: "queued — merges on green" },
  { id: "rates-engine", state: "queued behind proration-rules" },
  { id: "tax-adapter", state: "held — parked on your answer" },
];

export const LADDER2 = [
  { rung: "inner loop", count: 14, note: "retries inside threads" },
  { rung: "mediation", count: 7, note: "resolved by the orchestrator" },
  { rung: "you", count: 1, note: "tax rounding — parked 09:21" },
];

// ---- The lab at scale: heavy stack under the fleet semaphore, a declared
// not-leased service (reality manifest), and a carry file on record.
export const LAB_SERVICES2: LabService[] = [
  {
    name: "postgres-16",
    scope: "project",
    state: "healthy",
    detail: "refcount 1 · tenant stamped from template mig-b7d3 · reset ~1s",
    policy: "restart on death · crash-loop breaker armed",
  },
  {
    name: "novarix-api",
    scope: "loom",
    state: "healthy",
    detail: "warm lane · :4620 · ready = http /health · update: restart on package.json diff",
    policy: "restart on death · crash-loop breaker armed",
  },
  {
    name: "billing-worker",
    scope: "loom",
    state: "healthy",
    detail: "queue consumer · ready = log “worker ready” · update: restart",
    policy: "restart on death · crash-loop breaker armed",
  },
  {
    name: "stripe-mock",
    scope: "loom",
    state: "not-leased",
    detail: "NOT leased — synthetic tax mode per the reality manifest",
    policy: "declared degraded at the gate",
  },
];

export const LAB_META2 = {
  semaphore: "heavy-infra semaphore: 1 of 2 fleet slots in use · queue empty",
  lease: "lease token: ~/.telar-dev/looms/p12-usage-billing/services/*.json",
  carry: "carry: supabase/.env.keys → planted into worktree + lab checkouts",
  window: {
    note: "heavy stack — opening the window borrows it (~2m from template), releases on close",
  },
};

// ── the Prepare receipt as a DAG (consistency pass) ─────────────────────────
// novarix P12 usage-billing's preparation graph, frozen — the heavy end of
// the same map the gate room uses: five drift-spawned sessions blooming from
// the opening, closing through interference + readiness into the gate.

export const PREP_DAG2: { nodes: DagNodeSpec[]; edges: [string, string][] } = {
  nodes: [
    {
      id: "living-model",
      title: "Living model",
      sub: "drift in 5 regions",
      detail: "map read · drift across billing, rating, tax, migration, surfaces",
      state: "done",
      x: 0.5,
      row: 0,
    },
    {
      id: "opening",
      title: "Opening conversation",
      sub: "you + intake · 14 turns",
      detail: "you + intake · 14 turns → drift report · scope pinned to P12 usage billing",
      state: "done",
      x: 0.5,
      row: 1,
    },
    {
      id: "billing-prd",
      title: "Billing PRD delta",
      sub: "21 requirements",
      detail: "prd-writer session · 21 requirements, 3 non-goals",
      state: "done",
      x: 0.1,
      row: 2,
    },
    {
      id: "rating-ux",
      title: "Rating UX / feel",
      sub: "ux + feel-critic",
      detail: "ux-researcher + feel-critic sessions on the rating surfaces",
      state: "done",
      x: 0.3,
      row: 2,
    },
    {
      id: "risk",
      title: "Migration risk study",
      sub: "14 months of history",
      detail: "risk seat · 14 months of billing history sampled for migration hazards",
      state: "done",
      x: 0.5,
      row: 2,
    },
    {
      id: "tax",
      title: "Tax research",
      sub: "synthetic-mode proposal",
      detail: "domain researcher · proposed the synthetic tax mode declared at the gate",
      state: "done",
      x: 0.7,
      row: 2,
    },
    {
      id: "surfaces",
      title: "Surfaces audit",
      sub: "no drift — never spawned",
      detail: "no drift against the surfaces region — this session never ran",
      state: "dormant",
      x: 0.9,
      row: 2,
    },
    {
      id: "interference",
      title: "Interference analysis",
      sub: "3 workstreams mapped",
      detail: "21 subgoals → 3 workstreams · shared-file map · serialization points marked",
      state: "done",
      x: 0.25,
      row: 3,
    },
    {
      id: "readiness",
      title: "Verification readiness",
      sub: "recipe proven in 2m11s",
      detail: "recipe novarix-stack + postgres + worker proven in 2m11s · tax synthetic declared",
      state: "done",
      x: 0.55,
      row: 3,
    },
    {
      id: "flow-compile",
      title: "Flow compile",
      sub: "21 subgoals · 4 lanes",
      detail: "workstreams compiled: 21 subgoals · 11 threads · 4 lanes",
      state: "done",
      x: 0.8,
      row: 3,
    },
  ],
  edges: [
    ["living-model", "opening"],
    ["opening", "billing-prd"],
    ["opening", "rating-ux"],
    ["opening", "risk"],
    ["opening", "tax"],
    ["opening", "surfaces"],
    ["billing-prd", "interference"],
    ["rating-ux", "interference"],
    ["risk", "interference"],
    ["tax", "readiness"],
    ["interference", "flow-compile"],
    ["readiness", "gate"],
    ["flow-compile", "gate"],
  ],
};
