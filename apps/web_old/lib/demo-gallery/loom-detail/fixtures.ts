// LANE: loom-detail (UX brainstorm 2026-07-23) — one shared mid-flight loom
// so the three navigation proposals argue over identical facts. The loom is
// ozom's "P10 · client role + access seeding": prepare is locked (with two
// human edits on record), execute is live (2 threads running, 1 waiting),
// judge is partially lit (5/9 assertions already green). Nothing needs a
// human right now — on purpose: the cockpit must be worth opening even when
// it is only a window.

import type { DagNodeSpec } from "../prep-gate/shared";

export const LOOM = {
  id: "client-role-seeding",
  project: "ozom",
  title: "P10 · client role + access seeding",
  goal: "Clients can log in, see only their own campaigns, and reach checkout with seeded access.",
  started: "07:15",
  spend: "$3.10",
  budget: "$6.00",
  subgoalsDone: 5,
  subgoalsTotal: 8,
};

export type NodeState = "done" | "build" | "verify" | "wait";

export type GraphNode = {
  id: string;
  title: string;
  state: NodeState;
  lane: number; // row in the left→right graph, for the mini-map
  deps?: string[];
};

export const NODES: GraphNode[] = [
  { id: "schema", title: "Roles table + client role", state: "done", lane: 0 },
  { id: "seed", title: "Seed script: demo client accounts", state: "done", lane: 1 },
  { id: "auth", title: "Role-aware session claims", state: "done", lane: 0, deps: ["schema"] },
  { id: "api", title: "Campaign list scoping", state: "done", lane: 0, deps: ["auth"] },
  { id: "ui-nav", title: "Client nav variant", state: "build", lane: 1, deps: ["auth"] },
  { id: "checkout", title: "Checkout access gate", state: "wait", lane: 0, deps: ["api", "seed"] },
  { id: "e2e", title: "E2E: login → campaigns → checkout", state: "verify", lane: 2, deps: ["api"] },
  { id: "runbook", title: "Seeding runbook", state: "wait", lane: 2, deps: ["seed"] },
];

// Two human edits happened before lock — modify-on-the-go has provenance.
export const GRAPH_EDITS = [
  "you split seeding out of the schema node (07:21)",
  "you added the runbook node (07:22) — then locked",
];

export const READINESS = "recipe next-dev+postgres stood up in 41s · readiness green 07:24";

export type Thread = {
  id: string;
  state: "build" | "verify" | "wait";
  activity: string;
  evidence?: { label: string; age: string };
};

export const THREADS: Thread[] = [
  {
    id: "ui-client-nav",
    state: "build",
    activity: "wiring role-aware nav · hiding admin affordances",
    evidence: { label: "client-nav.png", age: "2m" },
  },
  {
    id: "e2e-client-path",
    state: "verify",
    activity: "verify panel driving checkout as the client role",
    evidence: { label: "login-as-client.png", age: "1m" },
  },
  {
    id: "checkout-gate",
    state: "wait",
    activity: "waiting on: campaign scoping ✓ · seed accounts ✓ · nav (building)",
  },
];

export const MEDIATION =
  "08:41 selector drift on ui-client-nav → inner-loop retry · resolved at rung 1, never climbed";

export type AssertState = "pass" | "running" | "pending";

export type ContractAssert = {
  id: string;
  desc: string;
  state: AssertState;
};

export const CONTRACT: ContractAssert[] = [
  { id: "A1", desc: "client can log in with a seeded account", state: "pass" },
  { id: "A2", desc: "campaign list shows only the client's own", state: "pass" },
  { id: "A3", desc: "admin routes return 403 for the client role", state: "pass" },
  { id: "A4", desc: "seeding is idempotent across two runs", state: "pass" },
  { id: "A5", desc: "checkout reachable with seeded access", state: "running" },
  { id: "A6", desc: "campaign without access blocks checkout", state: "pending" },
  { id: "A7", desc: "client nav exposes no admin affordances", state: "pending" },
  { id: "A8", desc: "a11y ≥ 90 on the three client pages", state: "pass" },
  { id: "A9", desc: "runbook executes clean on a blank DB", state: "pending" },
];

export type Actor = "you" | "orchestrator" | "builder" | "verifier" | "system";

// ---- Thread drill-in: ui-client-nav — "a thread is a team behind a feature".
// Its main agent COMPILED this flow (DAG artifact, schema-validated, run
// deterministically): per-node context manifests, two parallel builder lanes
// in isolated worktrees, one bounded recompile on record.

export type FlowNodeState = "done" | "build" | "wait";

export type FlowNode = {
  id: string;
  title: string;
  state: FlowNodeState;
  lane?: "A" | "B"; // parallel builder lanes — isolated worktrees, merged on green
  manifest: string; // the node's context manifest, compressed to one line
};

export const THREAD_FLOW: FlowNode[] = [
  { id: "ctx", title: "Context gather", state: "done", manifest: "map: form/UX + surfaces · 4 files" },
  { id: "nav-desktop", title: "Desktop nav variant", state: "done", lane: "A", manifest: "6 files · no secrets · wt-a" },
  { id: "guards", title: "Role guards on admin routes", state: "done", lane: "A", manifest: "3 files + session-claim types" },
  { id: "nav-mobile", title: "Mobile nav variant", state: "build", lane: "B", manifest: "5 files · no secrets · wt-b" },
  { id: "integrate", title: "Integrate — merge lanes on green", state: "wait", manifest: "wt-a + wt-b → thread branch" },
  { id: "self-check", title: "Self-check against the subgoal", state: "wait", manifest: "subgoal text + rung results" },
];

export const RECOMPILE =
  "recompile #1 · 07:52 — interference analysis split nav into desktop/mobile lanes · bounded (1 of 2) · audited";

// Thread-altitude verification: cheap, serviceless, streaming — and it
// doubles as the progress heartbeat. The lab verdict belongs to the loom.
export type Rung = { label: string; state: "pass" | "run" | "queued"; age: string };

export const THREAD_RUNGS: Rung[] = [
  { label: "typecheck clean", state: "pass", age: "2m" },
  { label: "unit 34/34", state: "pass", age: "3m" },
  { label: "review — 2 findings, both resolved", state: "pass", age: "9m" },
  { label: "a11y probe on the nav", state: "queued", age: "waits on lane B" },
];

// ---- Orchestrator drill-in: the conductor's seat. Holds no pen — its whole
// output is decisions; its whole anxiety is progress liveness.

export const HEARTBEAT: { time: string; text: string }[] = [
  { time: "09:04", text: "evidence frame from the verify panel" },
  { time: "09:01", text: "loom-verify started (repo mutex acquired)" },
  { time: "08:47", text: "evidence frame from lane B" },
  { time: "08:41", text: "mediation resolved — lane B retried" },
  { time: "08:12", text: "subgoal landed on the loom branch" },
];

export const DECISIONS: { time: string; text: string }[] = [
  { time: "09:01", text: "start e2e verify — A5 entrypoint, dev-grade lab" },
  { time: "08:41", text: "mediate ui-client-nav: selector drift → inner-loop retry (rung 1), not a recompile" },
  { time: "08:12", text: "mark roles-schema done; unblock campaign scoping" },
  { time: "07:52", text: "approve recompile #1 on ui-client-nav (bounded 1 of 2)" },
  { time: "07:25", text: "schedule schema ∥ seed — interference analysis: disjoint files" },
];

export const MERGE_QUEUE = [
  { id: "schema", state: "landed 08:12" },
  { id: "seed-script", state: "landed 08:19" },
  { id: "ui-client-nav", state: "queued — merges on green" },
  { id: "checkout-gate", state: "blocked by nav" },
];

export const LADDER = [
  { rung: "inner loop", count: 2, note: "retries inside a thread" },
  { rung: "mediation", count: 1, note: "resolved by the orchestrator" },
  { rung: "you", count: 0, note: "none today" },
];

// ---- The lab: what this loom's supervisor holds. "The UI reads the
// registry" — services surface here, not in a terminal that spawned them.
export type LabService = {
  name: string;
  scope: "project" | "loom" | "ephemeral";
  state: "healthy" | "live" | "not-leased";
  detail: string;
  policy: string;
};

export const LAB_SERVICES: LabService[] = [
  {
    name: "postgres-16",
    scope: "project",
    state: "healthy",
    detail: "refcount 1 · tenant stamped from template mig-4f21 · reset ~1s",
    policy: "restart on death · crash-loop breaker armed",
  },
  {
    name: "next-dev",
    scope: "loom",
    state: "healthy",
    detail: "warm lane · :4310 · ready = http /api/health 200 · update: hmr",
    policy: "restart on death · crash-loop breaker armed",
  },
  {
    name: "verify panel",
    scope: "ephemeral",
    state: "live",
    detail: "driving A5 now · torn down after the round",
    policy: "one loom-verify per repo — mutex held",
  },
];

export const LAB_META = {
  lease: "lease token: ~/.telar-dev/looms/client-role-seeding/services/*.json",
  carry: "carry: none declared for this project",
  window: {
    url: "localhost:4310",
    note: "merged-so-far · landings: schema 08:12, seed-script 08:19",
  },
};

// ── the Prepare receipt as a DAG (consistency pass) ─────────────────────────
// The same map the gate room uses (UX 4), frozen: ozom client-role-seeding's
// preparation graph as the receipt of planning. Short subs on the map, full
// detail on expand — same rules as the live graph.

export const PREP_DAG: { nodes: DagNodeSpec[]; edges: [string, string][] } = {
  nodes: [
    {
      id: "living-model",
      title: "Living model",
      sub: "drift in 2 regions",
      detail: "map read · drift found in surfaces + verification norms",
      state: "done",
      x: 0.5,
      row: 0,
    },
    {
      id: "opening",
      title: "Opening conversation",
      sub: "you + intake · 6 turns",
      detail: "you + intake · 6 turns → drift report · click to reopen the conversation",
      state: "done",
      x: 0.5,
      row: 1,
    },
    {
      id: "context",
      title: "Context gathering",
      sub: "9 files · auth + roles",
      detail: "auth + role audit across 9 files · session surfaces flagged",
      state: "done",
      x: 0.18,
      row: 2,
    },
    {
      id: "ux-delta",
      title: "UX / feel delta",
      sub: "client-nav feel notes",
      detail: "ux-researcher session · client-nav feel notes for the nav thread",
      state: "done",
      x: 0.52,
      row: 2,
    },
    {
      id: "prd",
      title: "PRD delta",
      sub: "no drift — never spawned",
      detail: "no drift against the PRD — this session never ran",
      state: "dormant",
      x: 0.86,
      row: 2,
    },
    {
      id: "readiness",
      title: "Verification readiness",
      sub: "recipe proven in 41s",
      detail: "recipe next-dev + postgres · lab stood up and torn down in 41s · no degraded modes",
      state: "done",
      x: 0.3,
      row: 3,
    },
    {
      id: "flow-compile",
      title: "Flow compile",
      sub: "8 subgoals · 2 lanes",
      detail: "branches converged: 8 subgoals over 3 threads · 2 lanes",
      state: "done",
      x: 0.7,
      row: 3,
    },
  ],
  edges: [
    ["living-model", "opening"],
    ["opening", "context"],
    ["opening", "ux-delta"],
    ["opening", "prd"],
    ["context", "readiness"],
    ["context", "flow-compile"],
    ["ux-delta", "flow-compile"],
    ["readiness", "gate"],
    ["flow-compile", "gate"],
  ],
};
