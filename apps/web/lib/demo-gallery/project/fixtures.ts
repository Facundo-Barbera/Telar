// LANE: project (NEW) — the per-project hub view nobody's redesign lane covered.
// Generous, self-contained fixtures for both hub variants: 22 sessions and 7
// looms for one project, mixed ages / costs / states so grouping, search,
// filtering, and the loom vocabulary all have something to bite on. No engine
// imports beyond the WorkUnitState *type* (matches the other lanes' discipline).
import type { WorkUnitState } from "@telar/core";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A fixed "now" per module load keeps relative times stable within a render.
const NOW = Date.now();
const ago = (ms: number) => NOW - ms;

// A loom that sprang from a session, shown as a pill on that session's row.
export type SessionLoomRef = { id: string; state: WorkUnitState };

export interface DemoSession {
  id: string;
  title: string;
  preview: string; // one-line last-exchange snippet for the dense row
  lastUser: string; // last user turn — the preview pane shows the real exchange
  lastAssistant: string; // last assistant reply
  model: string;
  turns: number;
  costUsd: number;
  updatedAt: number;
  loom?: SessionLoomRef; // a loom this session wove, if any
}

export type LoomRole = "single" | "woven" | "verify";

export interface DemoLoom {
  id: string;
  title: string;
  kind: string;
  state: WorkUnitState;
  role: LoomRole;
  threads: number | null;
  threadsDone: number;
  attempts: number;
  cost: number;
  updatedAt: number;
  error?: string;
  fromSession?: string;
}

export const DEMO_PROJECT = {
  name: "telar-web",
  stack: "Next.js · TypeScript",
  account: "work",
  branch: "main",
  root: "~/Projects/personal/telar/apps/web",
  gates: 3,
} as const;

// 22 sessions across today / this week / older, mixed models + costs. A handful
// carry a loom pill (the loom that session set in motion).
export const DEMO_SESSIONS: DemoSession[] = [
  {
    id: "s-01",
    title: "Project hub — the missing view",
    preview: "Left column lists sessions, right pane opens the selected one…",
    lastUser: "Which column should own the New session button?",
    lastAssistant:
      "Keep it primary at the top of the list rail — it's the one action a hub is for. Everything else (search, filters) sits under it so the button never scrolls away.",
    model: "opus-4.8",
    turns: 14,
    costUsd: 1.842,
    updatedAt: ago(8 * MIN),
    loom: { id: "l-01", state: "running" },
  },
  {
    id: "s-02",
    title: "Dense session rows vs cards",
    preview: "Rows win at 20+ — cards waste vertical space you scroll past…",
    lastUser: "Rows or cards for the session list?",
    lastAssistant:
      "Rows. At this volume a grid of cards is all scroll and no signal; a dense row surfaces state, cost, and age on one line.",
    model: "opus-4.8",
    turns: 9,
    costUsd: 0.973,
    updatedAt: ago(42 * MIN),
  },
  {
    id: "s-03",
    title: "Wire the /api/chats pager",
    preview: "Cursor pagination lands; empty-state copy still TODO…",
    lastUser: "Cursor or offset for the sessions endpoint?",
    lastAssistant:
      "Cursor — offsets drift when a session archives mid-scroll. The cursor is the updatedAt of the last row.",
    model: "sonnet-4.5",
    turns: 22,
    costUsd: 0.418,
    updatedAt: ago(2 * HOUR),
    loom: { id: "l-02", state: "needs-review" },
  },
  {
    id: "s-04",
    title: "Manifest rail health dots",
    preview: "MCP status polls only when an http server exists…",
    lastUser: "Should the rail poll on every load?",
    lastAssistant:
      "Only when there's an http server to probe — stdio shows a static 'Local' dot, no fetch.",
    model: "opus-4.8",
    turns: 6,
    costUsd: 0.221,
    updatedAt: ago(4 * HOUR),
  },
  {
    id: "s-05",
    title: "Loom pill on session rows",
    preview: "A session that wove a loom carries a state-toned pill…",
    lastUser: "How do I show the loom a session started?",
    lastAssistant:
      "A small StateBadge pill on the right of the row, colored by the loom's live state — it's the thread from 'explore' to 'execute'.",
    model: "opus-4.8",
    turns: 11,
    costUsd: 1.104,
    updatedAt: ago(7 * HOUR),
    loom: { id: "l-03", state: "ready" },
  },
  {
    id: "s-06",
    title: "Archive drawer lazy fetch",
    preview: "Collapsed by default; expands to archived=only…",
    lastUser: "Fetch archived eagerly?",
    lastAssistant:
      "Never eagerly — it's a drawer. Fetch on first expand, invalidate on telar:refresh so reopening is fresh.",
    model: "sonnet-4.5",
    turns: 8,
    costUsd: 0.152,
    updatedAt: ago(11 * HOUR),
  },
  {
    id: "s-07",
    title: "New-session route scaffolding",
    preview: "/sessions/new pre-selects the project's default model…",
    lastUser: "Where does the model default come from?",
    lastAssistant:
      "The manifest's adapter default, overridable in the composer. New session inherits it so you start typing, not configuring.",
    model: "opus-4.8",
    turns: 5,
    costUsd: 0.331,
    updatedAt: ago(20 * HOUR),
    loom: { id: "l-04", state: "verifying" },
  },
  {
    id: "s-08",
    title: "Sticky toolbar backdrop blur",
    preview: "supports-[backdrop-filter] fallback to solid bg…",
    lastUser: "Blur or solid for the sticky header?",
    lastAssistant:
      "Blur where supported, solid /95 fallback — never a transform on the ancestor or the group headers detach.",
    model: "sonnet-4.5",
    turns: 7,
    costUsd: 0.098,
    updatedAt: ago(1 * DAY + 3 * HOUR),
  },
  {
    id: "s-09",
    title: "Gate config read-only rail",
    preview: "Gates render from telar.yaml; editing lives in settings…",
    lastUser: "Can I edit gates from the hub?",
    lastAssistant:
      "The rail is a glance, not a control panel. It deep-links to settings — one source of truth for the manifest.",
    model: "opus-4.8",
    turns: 10,
    costUsd: 0.874,
    updatedAt: ago(1 * DAY + 9 * HOUR),
  },
  {
    id: "s-10",
    title: "Cost column tabular-nums",
    preview: "Four-place USD, mono, right-aligned so digits line up…",
    lastUser: "Why does the cost column jitter?",
    lastAssistant:
      "Non-tabular figures. Switch to font-mono tabular-nums and every $ lines up regardless of value.",
    model: "haiku-4",
    turns: 4,
    costUsd: 0.021,
    updatedAt: ago(1 * DAY + 14 * HOUR),
  },
  {
    id: "s-11",
    title: "Weave a refactor across three files",
    preview: "Woven loom fanned to 3 threads; merged on green…",
    lastUser: "Split this refactor into parallel threads?",
    lastAssistant:
      "Yes — three isolated worktrees, one per file boundary, merged on green. I'll weave it now.",
    model: "opus-4.8",
    turns: 17,
    costUsd: 2.611,
    updatedAt: ago(2 * DAY),
    loom: { id: "l-05", state: "done" },
  },
  {
    id: "s-12",
    title: "Empty-state illustrations",
    preview: "No-sessions and no-looms share the EmptyState primitive…",
    lastUser: "Different empty states per section?",
    lastAssistant:
      "Same primitive, different icon + copy. Sessions explore; looms execute — the copy should say so.",
    model: "sonnet-4.5",
    turns: 6,
    costUsd: 0.143,
    updatedAt: ago(2 * DAY + 5 * HOUR),
  },
  {
    id: "s-13",
    title: "Keyboard nav for the list",
    preview: "j/k moves selection, Enter opens, / focuses search…",
    lastUser: "Can I drive the list from the keyboard?",
    lastAssistant:
      "j/k to move, Enter to open the preview, / to jump to search. The palette grammar, applied to the hub.",
    model: "opus-4.8",
    turns: 13,
    costUsd: 1.287,
    updatedAt: ago(3 * DAY),
  },
  {
    id: "s-14",
    title: "Failed gate — flaky snapshot test",
    preview: "tsc clean but the visual snapshot diffed on CI…",
    lastUser: "Why did the loom go to needs-review?",
    lastAssistant:
      "A snapshot test flaked — the gate is fail-closed, so it escalated rather than fabricate a green. Re-run or update the baseline.",
    model: "opus-4.8",
    turns: 19,
    costUsd: 1.943,
    updatedAt: ago(3 * DAY + 8 * HOUR),
    loom: { id: "l-06", state: "failed" },
  },
  {
    id: "s-15",
    title: "Sparkline of project activity",
    preview: "14-day bars of sessions + looms for the hero strip…",
    lastUser: "What does the hero sparkline count?",
    lastAssistant:
      "Sessions and looms per day over two weeks — a glance at whether the repo is hot or resting.",
    model: "sonnet-4.5",
    turns: 8,
    costUsd: 0.204,
    updatedAt: ago(4 * DAY),
  },
  {
    id: "s-16",
    title: "Charter review copy pass",
    preview: "Reworded the charter prompt to name the policy asked…",
    lastUser: "The charter prompt reads too generic.",
    lastAssistant:
      "Tightened it to name the exact policy gate that triggered the ask — the human touches the process at most three times, so each touch must earn it.",
    model: "opus-4.8",
    turns: 12,
    costUsd: 0.998,
    updatedAt: ago(5 * DAY),
    loom: { id: "l-07", state: "charter-review" },
  },
  {
    id: "s-17",
    title: "Two-column responsive collapse",
    preview: "Preview pane stacks under the list below lg…",
    lastUser: "What happens to the preview on mobile?",
    lastAssistant:
      "It stacks — the list is full-width, tapping a row slides the preview in. No side-by-side under lg.",
    model: "sonnet-4.5",
    turns: 7,
    costUsd: 0.167,
    updatedAt: ago(6 * DAY),
  },
  {
    id: "s-18",
    title: "Model badge vocabulary",
    preview: "opus/sonnet/haiku render as quiet mono tags…",
    lastUser: "Color the model badges?",
    lastAssistant:
      "Keep them quiet mono — the state colors carry the signal, the model is metadata. Coloring both competes.",
    model: "haiku-4",
    turns: 5,
    costUsd: 0.034,
    updatedAt: ago(8 * DAY),
  },
  {
    id: "s-19",
    title: "Deep-link a session by id",
    preview: "?session=<id> opens the preview pane pre-selected…",
    lastUser: "Can I share a link straight to one session?",
    lastAssistant:
      "Yes — the id is in the query, the hub opens with that row selected and the preview pane already populated.",
    model: "opus-4.8",
    turns: 9,
    costUsd: 0.612,
    updatedAt: ago(11 * DAY),
  },
  {
    id: "s-20",
    title: "Unregister confirm popover",
    preview: "Two-click destructive path mirrors the card control…",
    lastUser: "One click to unregister feels dangerous.",
    lastAssistant:
      "Made it two-click: opening the popover is the first, Unregister the second. The repo and telar.yaml stay untouched either way.",
    model: "sonnet-4.5",
    turns: 6,
    costUsd: 0.121,
    updatedAt: ago(14 * DAY),
  },
  {
    id: "s-21",
    title: "Prototype: activity feed on the hub",
    preview: "Rejected — the hub is a workbench, not a timeline…",
    lastUser: "Should the hub lead with an activity feed?",
    lastAssistant:
      "Tried it; the feed answers 'what changed' but the hub's job is 'what do I open next'. The list stays the hero.",
    model: "opus-4.8",
    turns: 15,
    costUsd: 1.556,
    updatedAt: ago(19 * DAY),
  },
  {
    id: "s-22",
    title: "Initial telar-web registration",
    preview: "Registered the repo; first manifest parse succeeded…",
    lastUser: "Register this repo on the loom.",
    lastAssistant:
      "Registered telar-web — manifest parsed, three gates detected, main as the base branch. You're ready to weave.",
    model: "sonnet-4.5",
    turns: 4,
    costUsd: 0.087,
    updatedAt: ago(26 * DAY),
  },
];

// 7 looms across the state palette + roles, mixed ages/costs.
export const DEMO_LOOMS: DemoLoom[] = [
  {
    id: "l-01",
    title: "Build the project hub view",
    kind: "feature",
    state: "running",
    role: "single",
    threads: null,
    threadsDone: 0,
    attempts: 1,
    cost: 0.842,
    updatedAt: ago(6 * MIN),
    fromSession: "s-01",
  },
  {
    id: "l-02",
    title: "Paginate /api/chats with a cursor",
    kind: "feature",
    state: "needs-review",
    role: "single",
    threads: null,
    threadsDone: 0,
    attempts: 2,
    cost: 1.318,
    updatedAt: ago(1 * HOUR + 40 * MIN),
    error: "gate `bun test` failed on the pager edge case",
    fromSession: "s-03",
  },
  {
    id: "l-03",
    title: "Loom pills on session rows",
    kind: "feature",
    state: "ready",
    role: "single",
    threads: null,
    threadsDone: 0,
    attempts: 1,
    cost: 0.704,
    updatedAt: ago(6 * HOUR),
    fromSession: "s-05",
  },
  {
    id: "l-04",
    title: "Scaffold the new-session route",
    kind: "chore",
    state: "verifying",
    role: "verify",
    threads: null,
    threadsDone: 0,
    attempts: 1,
    cost: 0.293,
    updatedAt: ago(18 * HOUR),
    fromSession: "s-07",
  },
  {
    id: "l-05",
    title: "Refactor list controls across three files",
    kind: "refactor",
    state: "done",
    role: "woven",
    threads: 3,
    threadsDone: 3,
    attempts: 1,
    cost: 2.446,
    updatedAt: ago(1 * DAY + 22 * HOUR),
    fromSession: "s-11",
  },
  {
    id: "l-06",
    title: "Stabilize the snapshot gate",
    kind: "fix",
    state: "failed",
    role: "single",
    threads: null,
    threadsDone: 0,
    attempts: 3,
    cost: 1.771,
    updatedAt: ago(3 * DAY + 6 * HOUR),
    error: "visual snapshot diffed on CI three runs straight",
    fromSession: "s-14",
  },
  {
    id: "l-07",
    title: "Rework the charter prompt",
    kind: "feature",
    state: "charter-review",
    role: "woven",
    threads: 2,
    threadsDone: 1,
    attempts: 1,
    cost: 0.912,
    updatedAt: ago(4 * DAY + 20 * HOUR),
    fromSession: "s-16",
  },
];

// 14-day activity bars for the hero sparkline (sessions + looms per day, oldest
// first). Hand-tuned so the shape reads as "busy lately, quiet before".
export const ACTIVITY_14D: number[] = [
  1, 0, 2, 1, 3, 0, 1, 2, 4, 3, 2, 5, 6, 8,
];
