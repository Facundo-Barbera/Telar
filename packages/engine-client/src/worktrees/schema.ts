import type { GitReadFailure } from "../protocol/entities";

export type WorktreesRoot = {
  kind: "default" | "configured" | "absent" | "unreadable" | "unverifiable";
  /** Absent only when the record is unreadable. */
  root?: string;
  default: string;
  volume?: { mount: string; uuid?: string };
  label?: string;
  blocker?: string;
};

export type WorktreeMoveSkip = {
  sessionId: string;
  path: string;
  reason: "busy" | "dirty" | "branch-gone" | "detached" | "failed";
  /** Git's own words: diagnostic, never UI copy. */
  detail?: string;
};

export type WorktreeMoveResult = {
  moved: { sessionId: string; from: string; to: string }[];
  skipped: WorktreeMoveSkip[];
  summary: string;
};

export type WorktreeOwner =
  | { kind: "none" }
  | { kind: "session"; sessionId: string; title?: string; lifecycle: "live" | "settled" | "archived" };

export type WorktreeLockReason = "unreadable" | "in-use" | "protected" | "active";

export type WorktreeForceReason = "dirty" | "unmerged" | "unknown" | "no-branch";

export type WorktreeVerdict =
  | { kind: "reclaimable" }
  | { kind: "needs-force"; reasons: WorktreeForceReason[] }
  | { kind: "locked"; reason: WorktreeLockReason };

export type WorktreeRow = {
  /** The row's identity everywhere: what the session records, git registers and a reclaim names. */
  path: string;
  basename: string;
  branch?: string;
  projectId?: string;
  projectName?: string;
  owner: WorktreeOwner;
  registered: boolean;
  onDisk: boolean;
  gitLocked?: boolean;
  bytes?: number;
  updatedAt?: number;
  /** Absent means not proven either way, which differs from `false`. */
  clean?: boolean;
  merged?: boolean;
  mergedInto?: string;
  incomplete?: GitReadFailure;
  verdict: WorktreeVerdict;
};

export type WorktreeInventory = {
  rows: WorktreeRow[];
  roots: string[];
  blocker?: string;
  /** Something under a root could not be read, so sizes are a floor. */
  partial: boolean;
  measuring?: boolean;
  measuredAt: number;
};

/** `unmeasured` of `count` have no size yet, so `bytes` is a floor. */
export type WorktreeTally = { count: number; bytes: number; unmeasured: number };

export type WorktreeState = "in-use" | "archived" | "orphaned" | "unchanged" | "idle" | "recent";

export const RELEASABLE_STATES = ["archived", "orphaned", "unchanged", "idle"] as const satisfies readonly WorktreeState[];
export type ReleasableState = (typeof RELEASABLE_STATES)[number];

export type WorktreeLocationMove = {
  movable: WorktreeTally;
  staying: { busy: number; dirty: number; unowned: number; detached: number };
};

export type WorktreeLocation = {
  folder: string;
  /** The drive's name when the folder is on one; absent means this Mac's own disk. */
  volume?: string;
  present: boolean;
  current: boolean;
  worktrees: WorktreeTally;
  /** Only for a connected folder that is not the current location. */
  move?: WorktreeLocationMove;
};

export type WorktreeStateSummary = { state: WorktreeState; worktrees: WorktreeTally; releasable: WorktreeTally };

export type WorktreeSummary = {
  locations: WorktreeLocation[];
  /** Every worktree falls in exactly one state. */
  states: WorktreeStateSummary[];
  idleDays: number;
  /** When git was last asked; sizes refresh on every read. */
  checkedAt: number;
  measuring: boolean;
  partial: boolean;
  blocker?: string;
};

export type WorktreeReclaimItem ={ path: string; confirm?: string; settled?: "release" | "archive" };

export type WorktreeReclaimRefusal =
  | "not-found"
  | "dirty"
  | "unpushed"
  | "process"
  | "unreadable"
  | "in-use"
  | "protected"
  | "active"
  | "needs-confirm"
  | "confirm-mismatch"
  | "failed";

export type WorktreeReclaimResult = {
  path: string;
  ok: boolean;
  action?: "released" | "archived" | "removed";
  sessionId?: string;
  refusal?: WorktreeReclaimRefusal;
  detail?: string;
  bytes?: number;
};

export type WorktreeReclaimOutcome = { results: WorktreeReclaimResult[]; summary: string };
