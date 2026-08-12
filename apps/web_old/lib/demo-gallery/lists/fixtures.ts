// LANE: lists — self-contained demo fixtures for the index-surface redesigns
// (Dashboard, Projects, Looms). Generous volume on purpose: the whole point is
// to show the scale problem (concern 2 + 5) visibly solved, so we seed 16
// projects, 34 sessions, 24 looms. No @telar/core value imports — only the
// WorkUnitState string-literal type — so nothing drags the Node-only engine
// barrel into the browser bundle.
import type { WorkUnitState } from "@telar/core";
import { DEMO_NOW } from "../now";

// One frozen demo clock (see ../now) — never Date.now() at module load, or SSR
// and the client disagree on every relative time and hydration kills the stage.
const now = DEMO_NOW;
const mins = (n: number) => now - n * 60_000;
const hrs = (n: number) => now - n * 3_600_000;
const days = (n: number) => now - n * 86_400_000;

export type Account = "work" | "personal" | "oss";

export type DemoProject = {
  name: string;
  account: Account;
  stack: string;
  gates: number;
  pinned: boolean;
  lastActive: number;
  running: number; // looms in flight
  sessionsToday: number;
  openLooms: number; // non-terminal
  totalLooms: number;
  health: "ok" | "manifest-error";
  blurb: string;
};

export type DemoSession = {
  id: string;
  title: string;
  project: string;
  updatedAt: number;
  preview: string;
  live: boolean; // agent working right now
  kind: "plan" | "explore";
};

export type LoomRole = "single" | "woven" | "verify";

export type DemoLoom = {
  id: string;
  title: string;
  project: string;
  kind: "quickfix" | "story" | "custom" | "verify";
  role: LoomRole;
  state: WorkUnitState;
  threads: number | null; // total threads for a woven loom
  threadsDone: number; // completed threads
  cost: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

export const DEMO_PROJECTS: DemoProject[] = [
  { name: "telar-core", account: "work", stack: "TypeScript", gates: 4, pinned: true, lastActive: mins(2), running: 2, sessionsToday: 3, openLooms: 3, totalLooms: 41, health: "ok", blurb: "Orchestration engine — dispatcher, executor, verifier." },
  { name: "telar-web", account: "work", stack: "Next.js", gates: 3, pinned: true, lastActive: mins(6), running: 1, sessionsToday: 2, openLooms: 2, totalLooms: 33, health: "ok", blurb: "Operator console — dashboard, looms, chat surfaces." },
  { name: "atlas-api", account: "work", stack: "FastAPI", gates: 5, pinned: false, lastActive: mins(18), running: 1, sessionsToday: 1, openLooms: 1, totalLooms: 27, health: "ok", blurb: "Core REST + auth surface for the platform." },
  { name: "orbit-dashboard", account: "work", stack: "React", gates: 2, pinned: false, lastActive: mins(41), running: 1, sessionsToday: 2, openLooms: 1, totalLooms: 19, health: "ok", blurb: "Customer-facing analytics dashboard." },
  { name: "beacon-auth", account: "work", stack: "Go", gates: 6, pinned: false, lastActive: hrs(1.4), running: 0, sessionsToday: 1, openLooms: 1, totalLooms: 22, health: "ok", blurb: "SSO + token service, OIDC provider." },
  { name: "relay-worker", account: "work", stack: "Rust", gates: 3, pinned: false, lastActive: hrs(2.1), running: 0, sessionsToday: 1, openLooms: 0, totalLooms: 14, health: "ok", blurb: "Async job queue + webhook fanout." },
  { name: "ledger-sync", account: "work", stack: "TypeScript", gates: 4, pinned: false, lastActive: hrs(3.5), running: 0, sessionsToday: 0, openLooms: 1, totalLooms: 16, health: "ok", blurb: "Double-entry reconciliation pipeline." },
  { name: "sonar-metrics", account: "work", stack: "Python", gates: 2, pinned: false, lastActive: hrs(5), running: 0, sessionsToday: 0, openLooms: 0, totalLooms: 11, health: "ok", blurb: "Telemetry rollups + alerting rules." },
  { name: "harbor-deploy", account: "work", stack: "Terraform", gates: 0, pinned: false, lastActive: hrs(7), running: 0, sessionsToday: 0, openLooms: 0, totalLooms: 8, health: "manifest-error", blurb: "IaC for the staging + prod clusters." },
  { name: "cascade-etl", account: "work", stack: "Python", gates: 3, pinned: false, lastActive: hrs(9), running: 0, sessionsToday: 0, openLooms: 0, totalLooms: 13, health: "ok", blurb: "Batch ETL — warehouse loaders." },
  { name: "quill-editor", account: "personal", stack: "Svelte", gates: 1, pinned: false, lastActive: hrs(11), running: 0, sessionsToday: 0, openLooms: 1, totalLooms: 9, health: "ok", blurb: "Markdown-first writing app." },
  { name: "nimbus-cli", account: "personal", stack: "Rust", gates: 2, pinned: false, lastActive: days(1.2), running: 0, sessionsToday: 0, openLooms: 0, totalLooms: 7, health: "ok", blurb: "Cloud resource CLI + TUI." },
  { name: "drift-detector", account: "personal", stack: "Python", gates: 1, pinned: false, lastActive: days(2), running: 0, sessionsToday: 0, openLooms: 0, totalLooms: 5, health: "ok", blurb: "Infra drift scanner side-project." },
  { name: "pathfinder", account: "oss", stack: "TypeScript", gates: 3, pinned: false, lastActive: days(3), running: 0, sessionsToday: 0, openLooms: 0, totalLooms: 12, health: "ok", blurb: "Graph routing library (OSS)." },
  { name: "mosaic-ui", account: "oss", stack: "React", gates: 2, pinned: false, lastActive: days(5), running: 0, sessionsToday: 0, openLooms: 0, totalLooms: 6, health: "ok", blurb: "Headless component kit (OSS)." },
  { name: "inkwell-docs", account: "personal", stack: "Astro", gates: 0, pinned: false, lastActive: days(9), running: 0, sessionsToday: 0, openLooms: 0, totalLooms: 3, health: "ok", blurb: "Personal docs + notes site." },
];

export const DEMO_SESSIONS: DemoSession[] = [
  { id: "s01", title: "Rework dispatcher fan-out for woven looms", project: "telar-core", updatedAt: mins(1), preview: "Running bun test — 3 gates left to wire…", live: true, kind: "plan" },
  { id: "s02", title: "Sticky toolbar spike for looms index", project: "telar-web", updatedAt: mins(4), preview: "Let me check how PageHeader composes with…", live: true, kind: "explore" },
  { id: "s03", title: "OIDC refresh-token rotation", project: "beacon-auth", updatedAt: mins(9), preview: "The rotation window needs a grace period…", live: false, kind: "plan" },
  { id: "s04", title: "Investigate flaky reconciliation test", project: "ledger-sync", updatedAt: mins(22), preview: "It fails only when the clock crosses…", live: false, kind: "explore" },
  { id: "s05", title: "Add cursor pagination to /events", project: "atlas-api", updatedAt: mins(34), preview: "Draft charter ready for review.", live: false, kind: "plan" },
  { id: "s06", title: "Dark-mode contrast audit", project: "orbit-dashboard", updatedAt: mins(47), preview: "chart-3 fails AA on the muted card…", live: false, kind: "explore" },
  { id: "s07", title: "Webhook retry backoff tuning", project: "relay-worker", updatedAt: hrs(1.1), preview: "Exponential with jitter, capped at 5m.", live: false, kind: "plan" },
  { id: "s08", title: "Streaming thinking blocks in chat", project: "telar-web", updatedAt: hrs(1.6), preview: "The collapsible renders empty because…", live: false, kind: "explore" },
  { id: "s09", title: "Verifier report card layout", project: "telar-core", updatedAt: hrs(2), preview: "Gate rows should carry runtime + tone.", live: false, kind: "plan" },
  { id: "s10", title: "Cost aggregation across sub-agents", project: "telar-web", updatedAt: hrs(2.4), preview: "Main + children summed, expandable.", live: false, kind: "plan" },
  { id: "s11", title: "Metric rollup window off-by-one", project: "sonar-metrics", updatedAt: hrs(3), preview: "The 5m bucket double-counts the edge.", live: false, kind: "explore" },
  { id: "s12", title: "ETL loader idempotency", project: "cascade-etl", updatedAt: hrs(4), preview: "Upsert on natural key, dedupe on load.", live: false, kind: "plan" },
  { id: "s13", title: "Editor autosave debounce", project: "quill-editor", updatedAt: hrs(6), preview: "500ms feels right; flush on blur.", live: false, kind: "explore" },
  { id: "s14", title: "TUI resize flicker", project: "nimbus-cli", updatedAt: hrs(8), preview: "Double-buffer the frame before paint.", live: false, kind: "explore" },
  { id: "s15", title: "Graph routing heuristic weights", project: "pathfinder", updatedAt: hrs(10), preview: "A* with landmark preprocessing.", live: false, kind: "plan" },
  { id: "s16", title: "Token refresh race on concurrent tabs", project: "beacon-auth", updatedAt: hrs(13), preview: "Lock via BroadcastChannel leader.", live: false, kind: "explore" },
  { id: "s17", title: "Reconcile decimal rounding", project: "ledger-sync", updatedAt: hrs(20), preview: "Banker's rounding at the boundary.", live: false, kind: "plan" },
  { id: "s18", title: "Dashboard skeleton polish", project: "orbit-dashboard", updatedAt: days(1), preview: "Match the card footprint exactly.", live: false, kind: "explore" },
  { id: "s19", title: "Prod cluster autoscale policy", project: "harbor-deploy", updatedAt: days(1.3), preview: "Target 60% CPU, 4–20 nodes.", live: false, kind: "plan" },
  { id: "s20", title: "Component kit focus rings", project: "mosaic-ui", updatedAt: days(2), preview: "Use ring token, not outline.", live: false, kind: "explore" },
  { id: "s21", title: "Batch loader parallelism", project: "cascade-etl", updatedAt: days(2.4), preview: "8 workers saturates the warehouse.", live: false, kind: "plan" },
  { id: "s22", title: "Drift baseline snapshot format", project: "drift-detector", updatedAt: days(3), preview: "Canonical JSON, sorted keys.", live: false, kind: "explore" },
  { id: "s23", title: "Docs search index", project: "inkwell-docs", updatedAt: days(4), preview: "Prebuilt lunr index at build time.", live: false, kind: "plan" },
  { id: "s24", title: "Rust panic on empty queue", project: "relay-worker", updatedAt: days(4.5), preview: "Guard the pop; return early.", live: false, kind: "explore" },
  { id: "s25", title: "API rate-limit headers", project: "atlas-api", updatedAt: days(5), preview: "Expose X-RateLimit-* on 429.", live: false, kind: "plan" },
  { id: "s26", title: "Metrics alert dedupe", project: "sonar-metrics", updatedAt: days(6), preview: "Group by fingerprint, 10m window.", live: false, kind: "explore" },
  { id: "s27", title: "Editor slash-command menu", project: "quill-editor", updatedAt: days(7), preview: "Filterable, keyboard-first.", live: false, kind: "plan" },
  { id: "s28", title: "CLI config precedence", project: "nimbus-cli", updatedAt: days(8), preview: "Flag > env > file > default.", live: false, kind: "explore" },
  { id: "s29", title: "Routing benchmark harness", project: "pathfinder", updatedAt: days(9), preview: "Criterion suite on the grid maps.", live: false, kind: "plan" },
  { id: "s30", title: "OAuth device flow", project: "beacon-auth", updatedAt: days(10), preview: "Poll interval + slow_down handling.", live: false, kind: "explore" },
  { id: "s31", title: "Warehouse schema migration", project: "cascade-etl", updatedAt: days(11), preview: "Backfill then swap views.", live: false, kind: "plan" },
  { id: "s32", title: "Kit theme tokens", project: "mosaic-ui", updatedAt: days(13), preview: "oklch scale, light + dark.", live: false, kind: "explore" },
  { id: "s33", title: "Docs redirect map", project: "inkwell-docs", updatedAt: days(15), preview: "301 table from the old paths.", live: false, kind: "plan" },
  { id: "s34", title: "Drift ignore rules", project: "drift-detector", updatedAt: days(18), preview: "Glob allowlist per resource type.", live: false, kind: "explore" },
];

export const DEMO_LOOMS: DemoLoom[] = [
  // Running now
  { id: "l01", title: "Wire dispatcher fan-out gates for woven looms", project: "telar-core", kind: "story", role: "woven", state: "running", threads: 5, threadsDone: 2, cost: 3.12, attempts: 1, createdAt: mins(24), updatedAt: mins(1) },
  { id: "l02", title: "Sticky toolbar + grouping on looms index", project: "telar-web", kind: "quickfix", role: "single", state: "running", threads: null, threadsDone: 0, cost: 0.84, attempts: 1, createdAt: mins(12), updatedAt: mins(1) },
  { id: "l03", title: "Cursor pagination for /events endpoint", project: "atlas-api", kind: "story", role: "woven", state: "running", threads: 3, threadsDone: 1, cost: 1.47, attempts: 1, createdAt: mins(18), updatedAt: mins(2) },
  { id: "l04", title: "Retry backoff with jitter", project: "relay-worker", kind: "quickfix", role: "single", state: "verifying", threads: null, threadsDone: 0, cost: 0.63, attempts: 2, createdAt: mins(31), updatedAt: mins(3) },
  { id: "l05", title: "Verify staging deploy acceptance criteria", project: "orbit-dashboard", kind: "verify", role: "verify", state: "verifying", threads: null, threadsDone: 0, cost: 0.29, attempts: 1, createdAt: mins(40), updatedAt: mins(4) },
  { id: "l06", title: "Reconciliation edge-case coverage", project: "ledger-sync", kind: "story", role: "woven", state: "scoping", threads: null, threadsDone: 0, cost: 0.08, attempts: 1, createdAt: mins(6), updatedAt: mins(5) },
  { id: "l07", title: "OIDC refresh rotation grace window", project: "beacon-auth", kind: "story", role: "single", state: "preparing", threads: null, threadsDone: 0, cost: 0.11, attempts: 1, createdAt: mins(9), updatedAt: mins(6) },
  // Needs you
  { id: "l08", title: "Streaming thinking blocks in the chat surface", project: "telar-web", kind: "story", role: "woven", state: "charter-review", threads: 4, threadsDone: 0, cost: 0.22, attempts: 1, createdAt: mins(15), updatedAt: mins(8) },
  { id: "l09", title: "Aggregate sub-agent cost display", project: "telar-web", kind: "quickfix", role: "single", state: "ready", threads: null, threadsDone: 0, cost: 1.03, attempts: 1, createdAt: hrs(1), updatedAt: mins(12) },
  { id: "l10", title: "Verifier report card gate rows", project: "telar-core", kind: "story", role: "woven", state: "ready", threads: 3, threadsDone: 3, cost: 2.41, attempts: 1, createdAt: hrs(1.4), updatedAt: mins(20) },
  { id: "l11", title: "Metric rollup off-by-one at bucket edge", project: "sonar-metrics", kind: "quickfix", role: "single", state: "needs-review", threads: null, threadsDone: 0, cost: 0.71, attempts: 3, createdAt: hrs(2), updatedAt: mins(38), error: "Gate 'unit' green but coverage dropped 4% on the touched module — human call." },
  { id: "l12", title: "ETL loader idempotency on natural key", project: "cascade-etl", kind: "story", role: "single", state: "needs-review", threads: null, threadsDone: 0, cost: 1.55, attempts: 2, createdAt: hrs(3), updatedAt: hrs(1), error: "Could not prove dedupe under concurrent load — needs a design decision." },
  { id: "l13", title: "Autosave debounce + flush on blur", project: "quill-editor", kind: "quickfix", role: "single", state: "blocked", threads: null, threadsDone: 0, cost: 0.34, attempts: 1, createdAt: hrs(4), updatedAt: hrs(2), error: "Missing prerequisite: no storage adapter configured for the editor sandbox." },
  { id: "l13b", title: "Rate-limit headers on 429", project: "atlas-api", kind: "quickfix", role: "single", state: "failed", threads: null, threadsDone: 0, cost: 0.92, attempts: 4, createdAt: hrs(5), updatedAt: hrs(3), error: "Gate 'integration' failed after 4 attempts — upstream contract mismatch." },
  // Recent (terminal)
  { id: "l14", title: "Dashboard skeleton footprint match", project: "orbit-dashboard", kind: "quickfix", role: "single", state: "done", threads: null, threadsDone: 0, cost: 0.48, attempts: 1, createdAt: hrs(6), updatedAt: hrs(5) },
  { id: "l15", title: "Token refresh leader election", project: "beacon-auth", kind: "story", role: "woven", state: "done", threads: 4, threadsDone: 4, cost: 3.87, attempts: 2, createdAt: hrs(9), updatedAt: hrs(7) },
  { id: "l16", title: "Warehouse schema migration + backfill", project: "cascade-etl", kind: "story", role: "woven", state: "done", threads: 6, threadsDone: 6, cost: 5.12, attempts: 1, createdAt: hrs(13), updatedAt: hrs(11) },
  { id: "l17", title: "Focus ring token migration", project: "mosaic-ui", kind: "quickfix", role: "single", state: "done", threads: null, threadsDone: 0, cost: 0.31, attempts: 1, createdAt: hrs(20), updatedAt: hrs(18) },
  { id: "l18", title: "Alert dedupe by fingerprint", project: "sonar-metrics", kind: "story", role: "single", state: "done", threads: null, threadsDone: 0, cost: 1.19, attempts: 1, createdAt: days(1), updatedAt: hrs(22) },
  { id: "l19", title: "Slash-command menu", project: "quill-editor", kind: "story", role: "woven", state: "done", threads: 3, threadsDone: 3, cost: 2.02, attempts: 1, createdAt: days(1.3), updatedAt: days(1) },
  { id: "l20", title: "CLI config precedence resolver", project: "nimbus-cli", kind: "quickfix", role: "single", state: "done", threads: null, threadsDone: 0, cost: 0.57, attempts: 2, createdAt: days(1.6), updatedAt: days(1.2) },
  { id: "l21", title: "Routing benchmark harness", project: "pathfinder", kind: "story", role: "single", state: "halted", threads: null, threadsDone: 0, cost: 0.44, attempts: 1, createdAt: days(2), updatedAt: days(1.8), error: "Halted by operator — superseded by a newer plan." },
  { id: "l22", title: "Device-flow polling", project: "beacon-auth", kind: "quickfix", role: "single", state: "done", threads: null, threadsDone: 0, cost: 0.66, attempts: 1, createdAt: days(2.4), updatedAt: days(2.1) },
  { id: "l23", title: "Docs redirect map", project: "inkwell-docs", kind: "quickfix", role: "single", state: "done", threads: null, threadsDone: 0, cost: 0.18, attempts: 1, createdAt: days(3), updatedAt: days(2.8) },
  { id: "l24", title: "Theme token oklch scale", project: "mosaic-ui", kind: "story", role: "woven", state: "done", threads: 3, threadsDone: 3, cost: 1.74, attempts: 1, createdAt: days(4), updatedAt: days(3.7) },
];

// --- shared derivations the surfaces read off ---

const ACTIVE: WorkUnitState[] = ["scoping", "preparing", "running", "verifying"];
const NEEDS_YOU: WorkUnitState[] = ["charter-review", "ready", "needs-review", "blocked", "failed"];

export const isLoomActive = (s: WorkUnitState) => ACTIVE.includes(s);
export const isLoomNeedsYou = (s: WorkUnitState) => NEEDS_YOU.includes(s);
export const isLoomTerminal = (s: WorkUnitState) =>
  s === "done" || s === "halted" || s === "skipped";

export const ACCOUNT_LABEL: Record<Account, string> = {
  work: "work",
  personal: "personal",
  oss: "oss",
};

export const totalSpendToday = DEMO_LOOMS.filter(
  (l) => l.updatedAt > days(1),
).reduce((s, l) => s + l.cost, 0);

export const runningLooms = DEMO_LOOMS.filter((l) => isLoomActive(l.state));
export const needsYouLooms = DEMO_LOOMS.filter((l) => isLoomNeedsYou(l.state));
export const wovenThreadsInFlight = runningLooms
  .filter((l) => l.role === "woven")
  .reduce((s, l) => s + ((l.threads ?? 0) - l.threadsDone), 0);
