// Fake sidebar data for the redesign demos. Shapes mirror what the live
// AppSidebar derives (active looms + per-project recency + today's chats), but
// richer so the pinned / active-first / nested-today grouping is visible.
import type { WorkUnitState } from "@telar/core";

export type DemoLoom = {
  id: string;
  title: string;
  state: WorkUnitState;
};

export type DemoChat = {
  id: string;
  title: string;
  time: string; // relative label, e.g. "2m"
  running?: boolean; // an agent is actively working in this chat
};

export type DemoProject = {
  name: string;
  activity: string; // relative label of last touch, e.g. "2m ago"
  looms: DemoLoom[]; // active (non-terminal) looms in flight
  todayChats: DemoChat[]; // chats touched today, newest first
};

// Projects the user pinned — always visible, above recents, order preserved.
export const PINNED: DemoProject[] = [
  {
    name: "telar",
    activity: "just now",
    looms: [{ id: "l1", title: "wire build fanout", state: "running" }],
    todayChats: [
      { id: "c1", title: "dispatcher park semantics", time: "3m", running: true },
      { id: "c2", title: "m7 env review notes", time: "1h" },
    ],
  },
  {
    name: "ozom-infra",
    activity: "yesterday",
    looms: [],
    todayChats: [],
  },
];

// Recently-touched projects, NOT pinned. Deliberately unsorted here — the
// components sort active-first then by recency so the "last active on top"
// behaviour is provable from the raw list.
export const RECENTS: DemoProject[] = [
  {
    name: "notes-app",
    activity: "3h ago",
    looms: [],
    todayChats: [{ id: "c9", title: "markdown paste handling", time: "3h" }],
  },
  {
    name: "ozom-web",
    activity: "40s ago",
    looms: [
      { id: "l2", title: "checkout redesign", state: "running" },
      { id: "l3", title: "flaky e2e triage", state: "verifying" },
    ],
    todayChats: [
      { id: "c3", title: "cart drawer animation", time: "40s", running: true },
      { id: "c4", title: "stripe webhook retry", time: "22m" },
      { id: "c5", title: "og image generator", time: "2h" },
    ],
  },
  {
    name: "loom-engine",
    activity: "6m ago",
    looms: [{ id: "l4", title: "verifier fail-closed", state: "blocked" }],
    todayChats: [{ id: "c6", title: "mediation ladder trace", time: "6m" }],
  },
  {
    name: "vault-cli",
    activity: "yesterday",
    looms: [],
    todayChats: [],
  },
  {
    name: "portfolio",
    activity: "2 days ago",
    looms: [],
    todayChats: [],
  },
];

// Active looms across everything — drives the top-nav "Looms" badge count.
export function activeLoomCount(...groups: DemoProject[][]): number {
  return groups.flat().reduce((n, p) => n + p.looms.length, 0);
}

// Sort helper: projects with a loom in flight first, then by an ordering hint
// (fixtures list them roughly newest-first within each activity tier). We keep
// input order stable via index so the demo is deterministic.
export function activeFirst(projects: DemoProject[]): DemoProject[] {
  return projects
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const av = a.p.looms.length > 0 ? 1 : 0;
      const bv = b.p.looms.length > 0 ? 1 : 0;
      if (av !== bv) return bv - av;
      // within a tier, keep the fixture's freshest-first intent
      return recencyRank(a.p) - recencyRank(b.p);
    })
    .map((x) => x.p);
}

// Cheap recency rank from the activity label so active-first ordering has a
// stable secondary key without real timestamps.
function recencyRank(p: DemoProject): number {
  const a = p.activity;
  if (a.includes("now") || a.includes("s ago") || a.includes("s")) return 0;
  if (a.includes("m ago") || a.endsWith("m")) return 1;
  if (a.includes("h")) return 2;
  if (a.includes("yesterday")) return 3;
  return 4;
}

// One authenticated Claude account = one "wheel" in the footer. Mirrors the
// per-account PlanBlock/PlanRing list the production AppSidebar renders (outer
// ring = 5h session utilization, inner ring = weekly). Several accounts so the
// reorderable, compact-by-default wheel strip has something to arrange.
export type DemoAccount = {
  name: string;
  subscription: string; // plan label, e.g. "max"
  tier?: string; // cosmetic multiplier label, e.g. "20x" (omitted for some)
  fiveHour: number; // 5-hour session utilization %
  weekly: number; // weekly utilization %
};

export const ACCOUNTS: DemoAccount[] = [
  { name: "personal", subscription: "max", tier: "20x", fiveHour: 42, weekly: 68 },
  { name: "ozom", subscription: "team", tier: "5x", fiveHour: 88, weekly: 54 },
  { name: "labs", subscription: "pro", fiveHour: 12, weekly: 31 },
];
