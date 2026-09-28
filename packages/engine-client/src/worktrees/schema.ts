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
  reason: "dirty" | "branch-gone" | "detached" | "failed";
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

export type WorktreeReclaimItem = { path: string; confirm?: string; settled?: "release" | "archive" };

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
