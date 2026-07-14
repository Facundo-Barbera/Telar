// LANE: project (NEW) — fixtures for the project Git tab (project-git-* entries).
// Self-contained; only the WorkUnitState *type* crosses from core (same
// discipline as the other project fixtures).
//
// DATA HONESTY — what each shape maps to in the real product:
//  • Worktrees   → `git worktree list --porcelain` (packages/core/src/vcs.ts:338)
//    joined to the loom registry by the `telar-wt-<loomId>-<n>` dir naming that
//    vcs.ts already uses. REAL, server-side today.
//  • Sizes (~)   → `du` estimates. Approximate on purpose (the ~ is load-bearing).
//  • Branches / commits → plumbing reads (`git branch`, `git log`). REAL.
//  • Issues / PRs → `gh` CLI, AUTH-GATED. Future / read-only-first.
//  • File tree   → fs walk + `git status`. REAL. But per-node "last touched by"
//    needs the *paths* a session changed — the store records filesTouched as a
//    COUNT only (executor.ts:687 persists `.length`), NOT paths. So the
//    last-touched annotation is aspirational until that schema grows. Flagged.
import type { WorkUnitState } from "@telar/core";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => NOW - ms;

/* --------------------------------------------------------------- header */

export const GIT_HEAD = {
  branch: "ui-v2",
  ahead: 3,
  behind: 1,
  dirtyFiles: 4,
  lastCommit: {
    sha: "d113ea5",
    subject: "feat(core)!: the orchestrator mediates before the human",
    author: "facundo",
    updatedAt: ago(38 * MIN),
  },
} as const;

/* ------------------------------------------------------------ worktrees */

// A worktree's owner: a loom the registry created it for, or a hand-made tree.
export type WorktreeOwner =
  | { kind: "loom"; loomId: string; loomState: WorkUnitState }
  | { kind: "manual" };

export interface DemoWorktree {
  id: string;
  basename: string; // dir name — telar-wt-<loomId>-<n> when a loom owns it
  path: string; // absolute path (shown as a tooltip on the basename)
  branch: string;
  head: string; // HEAD commit subject
  sha: string;
  updatedAt: number;
  sizeMb: number; // ~ du estimate
  owner: WorktreeOwner;
  merged: boolean; // branch merged into its base
  dirty: boolean; // uncommitted changes in the tree
  stale: boolean; // branch gone on origin / untouched for weeks
}

// A worktree is RECLAIMABLE when Telar can prove nothing is lost by removing it:
// merged, clean, and not backing a still-running loom. This is the whole point —
// Telar knows loom lifecycle, so the user never reverse-engineers safety.
export function isReclaimable(w: DemoWorktree): boolean {
  const activeLoom = w.owner.kind === "loom" && isActiveLoomState(w.owner.loomState);
  return w.merged && !w.dirty && !activeLoom;
}

const ACTIVE: WorkUnitState[] = ["scoping", "preparing", "running", "verifying"];
export const isActiveLoomState = (s: WorkUnitState) => ACTIVE.includes(s);

const WT_ROOT = "/var/folders/6k/telar-worktrees";

export const DEMO_WORKTREES: DemoWorktree[] = [
  {
    id: "wt-l05",
    basename: "telar-wt-l05-1",
    path: `${WT_ROOT}/telar-wt-l05-1`,
    branch: "loom/refactor-list-controls",
    head: "refactor(core): collapse list controls into one primitive",
    sha: "a1c9f30",
    updatedAt: ago(1 * DAY + 22 * HOUR),
    sizeMb: 512,
    owner: { kind: "loom", loomId: "l-05", loomState: "done" },
    merged: true,
    dirty: false,
    stale: false,
  },
  {
    id: "wt-l11",
    basename: "telar-wt-l11-1",
    path: `${WT_ROOT}/telar-wt-l11-1`,
    branch: "loom/paginate-chats",
    head: "feat(web): cursor pager for /api/chats",
    sha: "77b0e21",
    updatedAt: ago(3 * DAY + 4 * HOUR),
    sizeMb: 448,
    owner: { kind: "loom", loomId: "l-11", loomState: "done" },
    merged: true,
    dirty: false,
    stale: false,
  },
  {
    id: "wt-l12",
    basename: "telar-wt-l12-1",
    path: `${WT_ROOT}/telar-wt-l12-1`,
    branch: "loom/model-badge-vocab",
    head: "feat(web): quiet mono model badges",
    sha: "3ee5a90",
    updatedAt: ago(6 * DAY),
    sizeMb: 390,
    owner: { kind: "loom", loomId: "l-12", loomState: "done" },
    merged: true,
    dirty: false,
    stale: true, // merged AND branch gone on origin — doubly reclaimable
  },
  {
    id: "wt-l01",
    basename: "telar-wt-l01-2",
    path: `${WT_ROOT}/telar-wt-l01-2`,
    branch: "loom/project-hub-view",
    head: "wip: worktrees section skeleton",
    sha: "0f2ab77",
    updatedAt: ago(6 * MIN),
    sizeMb: 604,
    // THE timeline star: a still-running loom. Replay finishes it -> reclaimable.
    owner: { kind: "loom", loomId: "l-01", loomState: "running" },
    merged: false,
    dirty: true,
    stale: false,
  },
  {
    id: "wt-l06",
    basename: "telar-wt-l06-3",
    path: `${WT_ROOT}/telar-wt-l06-3`,
    branch: "loom/stabilize-snapshot-gate",
    head: "fix: pin snapshot viewport (still diffing)",
    sha: "c4d1e8b",
    updatedAt: ago(3 * DAY + 6 * HOUR),
    sizeMb: 471,
    // a FAILED loom left an unmerged, dirty tree — needs an explicit force step
    owner: { kind: "loom", loomId: "l-06", loomState: "failed" },
    merged: false,
    dirty: true,
    stale: false,
  },
  {
    id: "wt-manual",
    basename: "hotfix-login",
    path: "/Users/facundo/Projects/telar-hotfix-login",
    branch: "hotfix/login-redirect",
    head: "fix(auth): redirect loop on expired token",
    sha: "9a02b14",
    updatedAt: ago(12 * DAY),
    sizeMb: 356,
    owner: { kind: "manual" },
    merged: true,
    dirty: false,
    stale: true, // hand-made, merged, forgotten — reclaimable
  },
  {
    id: "wt-manual-wip",
    basename: "spike-mcp",
    path: "/Users/facundo/Projects/telar-spike-mcp",
    branch: "spike/mcp-transport",
    head: "spike: stdio vs http transport probe",
    sha: "b71c0aa",
    updatedAt: ago(20 * DAY),
    sizeMb: 288,
    owner: { kind: "manual" },
    merged: false,
    dirty: false,
    stale: true, // unmerged spike — NOT auto-selected; force required
  },
];

/* ------------------------------------------------------------- branches */

export interface DemoBranch {
  name: string;
  merged: boolean;
  ahead: number;
  behind: number;
  updatedAt: number;
}

export const DEMO_BRANCHES: DemoBranch[] = [
  { name: "ui-v2", merged: false, ahead: 3, behind: 1, updatedAt: ago(38 * MIN) },
  { name: "loom/refactor-list-controls", merged: true, ahead: 0, behind: 0, updatedAt: ago(1 * DAY + 22 * HOUR) },
  { name: "loom/paginate-chats", merged: true, ahead: 0, behind: 0, updatedAt: ago(3 * DAY) },
  { name: "loom/model-badge-vocab", merged: true, ahead: 0, behind: 0, updatedAt: ago(6 * DAY) },
  { name: "loom/stabilize-snapshot-gate", merged: false, ahead: 2, behind: 5, updatedAt: ago(3 * DAY + 6 * HOUR) },
  { name: "hotfix/login-redirect", merged: true, ahead: 0, behind: 0, updatedAt: ago(12 * DAY) },
  { name: "spike/mcp-transport", merged: false, ahead: 6, behind: 14, updatedAt: ago(20 * DAY) },
];

/* -------------------------------------------------------------- commits */

export interface DemoCommit {
  sha: string;
  subject: string;
  author: string;
  updatedAt: number;
}

export const DEMO_COMMITS: DemoCommit[] = [
  { sha: "d113ea5", subject: "feat(core)!: the orchestrator mediates before the human", author: "facundo", updatedAt: ago(38 * MIN) },
  { sha: "273d7f5", subject: "feat(core)!: threads mediate-then-escalate; coverage re-proves", author: "facundo", updatedAt: ago(5 * HOUR) },
  { sha: "fc38feb", subject: "docs: reconcile to the Loom Doctrine; M11 as-built", author: "facundo", updatedAt: ago(1 * DAY + 2 * HOUR) },
  { sha: "8998e5e", subject: "refactor(core)!: delete dead + superseded features", author: "loom l-05", updatedAt: ago(1 * DAY + 22 * HOUR) },
  { sha: "b408874", subject: "refactor(core)!: one engine — collapse 12 behavior flags", author: "loom l-05", updatedAt: ago(2 * DAY) },
  { sha: "a1c9f30", subject: "chore: green-gate before the de-flag cut", author: "facundo", updatedAt: ago(2 * DAY + 6 * HOUR) },
];

/* ------------------------------------------------------- issues and PRs */

export type RemoteState = "open" | "closed" | "merged" | "draft";
export type ChecksState = "pass" | "fail" | "pending" | "none";

export interface DemoIssue {
  number: number;
  title: string;
  state: RemoteState;
  author: string;
  updatedAt: number;
  labels: string[];
  comments: number;
}

export interface DemoPR {
  number: number;
  title: string;
  state: RemoteState;
  author: string;
  updatedAt: number;
  branch: string;
  checks: ChecksState;
  linkedLoomId: string | null; // a loom wove this branch, when known
}

export const DEMO_ISSUES: DemoIssue[] = [
  { number: 142, title: "Worktrees pile up after woven looms merge", state: "open", author: "facundo", updatedAt: ago(2 * HOUR), labels: ["git", "cleanup"], comments: 3 },
  { number: 138, title: "Charter prompt should name the exact policy gate", state: "open", author: "facundo", updatedAt: ago(1 * DAY), labels: ["ux"], comments: 1 },
  { number: 131, title: "gh CLI integration for issues/PRs in the hub", state: "open", author: "mira", updatedAt: ago(2 * DAY + 5 * HOUR), labels: ["future", "integration"], comments: 7 },
  { number: 129, title: "Snapshot gate flakes on CI viewport", state: "open", author: "loom l-06", updatedAt: ago(3 * DAY), labels: ["bug", "ci"], comments: 2 },
  { number: 120, title: "Dense session rows vs cards at 20+", state: "closed", author: "facundo", updatedAt: ago(5 * DAY), labels: ["ux", "resolved"], comments: 4 },
];

export const DEMO_PRS: DemoPR[] = [
  { number: 145, title: "Cursor pager for /api/chats", state: "open", author: "loom l-11", updatedAt: ago(1 * HOUR + 20 * MIN), branch: "loom/paginate-chats", checks: "pass", linkedLoomId: "l-11" },
  { number: 144, title: "Loom pills on session rows", state: "open", author: "loom l-03", updatedAt: ago(6 * HOUR), branch: "loom/loom-pills", checks: "pending", linkedLoomId: "l-03" },
  { number: 141, title: "Stabilize the snapshot gate", state: "draft", author: "loom l-06", updatedAt: ago(3 * DAY + 6 * HOUR), branch: "loom/stabilize-snapshot-gate", checks: "fail", linkedLoomId: "l-06" },
  { number: 137, title: "Collapse list controls into one primitive", state: "merged", author: "loom l-05", updatedAt: ago(1 * DAY + 22 * HOUR), branch: "loom/refactor-list-controls", checks: "pass", linkedLoomId: "l-05" },
  { number: 133, title: "Bump next to 15.3", state: "merged", author: "facundo", updatedAt: ago(4 * DAY), branch: "chore/next-15-3", checks: "pass", linkedLoomId: null },
];

/* ------------------------------------------------------------ file tree */

export type GitStatus = "M" | "A" | "?" | null; // modified / added / untracked

export interface DemoFileNode {
  name: string;
  kind: "dir" | "file";
  depth: number;
  status: GitStatus;
  // last-touched-by is ASPIRATIONAL — the store records filesTouched counts, not
  // paths (see header). Present in the fixture to show the design; the entry
  // summary flags it as a gap, and the tab carries an inline caveat.
  touchedBy: { who: string; kind: "session" | "loom"; updatedAt: number } | null;
  heat: number; // 0..1 recent-churn intensity (drives the heat dot)
  children?: DemoFileNode[];
}

const t = (who: string, kind: "session" | "loom", ms: number) => ({
  who,
  kind,
  updatedAt: ago(ms),
});

export const DEMO_FILE_TREE: DemoFileNode[] = [
  {
    name: "apps/web",
    kind: "dir",
    depth: 0,
    status: "M",
    touchedBy: null,
    heat: 0.9,
    children: [
      {
        name: "app",
        kind: "dir",
        depth: 1,
        status: "M",
        touchedBy: null,
        heat: 0.7,
        children: [
          { name: "gallery", kind: "dir", depth: 2, status: "M", touchedBy: t("s-01", "session", 8 * MIN), heat: 1, children: [
            { name: "page.tsx", kind: "file", depth: 3, status: "M", touchedBy: t("l-01", "loom", 6 * MIN), heat: 1, children: [] },
          ] },
          { name: "layout.tsx", kind: "file", depth: 2, status: null, touchedBy: t("s-22", "session", 26 * DAY), heat: 0.1, children: [] },
        ],
      },
      {
        name: "lib/demo-gallery",
        kind: "dir",
        depth: 1,
        status: "A",
        touchedBy: null,
        heat: 0.8,
        children: [
          { name: "project", kind: "dir", depth: 2, status: "A", touchedBy: t("l-01", "loom", 6 * MIN), heat: 1, children: [
            { name: "git-tab.tsx", kind: "file", depth: 3, status: "?", touchedBy: t("l-01", "loom", 6 * MIN), heat: 1, children: [] },
            { name: "variant-c.tsx", kind: "file", depth: 3, status: "M", touchedBy: t("s-01", "session", 2 * HOUR), heat: 0.6, children: [] },
          ] },
        ],
      },
      { name: "components/common", kind: "dir", depth: 1, status: "M", touchedBy: t("l-05", "loom", 1 * DAY + 22 * HOUR), heat: 0.4, children: [
        { name: "state-badge.tsx", kind: "file", depth: 2, status: null, touchedBy: t("l-05", "loom", 1 * DAY + 22 * HOUR), heat: 0.3, children: [] },
      ] },
    ],
  },
  {
    name: "packages/core",
    kind: "dir",
    depth: 0,
    status: "M",
    touchedBy: null,
    heat: 0.5,
    children: [
      { name: "src", kind: "dir", depth: 1, status: "M", touchedBy: null, heat: 0.5, children: [
        { name: "vcs.ts", kind: "file", depth: 2, status: "M", touchedBy: t("l-05", "loom", 2 * DAY), heat: 0.5, children: [] },
        { name: "executor.ts", kind: "file", depth: 2, status: null, touchedBy: t("l-05", "loom", 2 * DAY), heat: 0.2, children: [] },
      ] },
    ],
  },
  {
    name: "docs",
    kind: "dir",
    depth: 0,
    status: null,
    touchedBy: t("s-16", "session", 5 * DAY),
    heat: 0.1,
    children: [
      { name: "PRINCIPLES.md", kind: "file", depth: 1, status: null, touchedBy: t("s-16", "session", 5 * DAY), heat: 0.1, children: [] },
    ],
  },
];
