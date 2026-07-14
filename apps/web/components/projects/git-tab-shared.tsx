// Project Git tab — shared contract types + display primitives.
//
// CLIENT-BUNDLE RULE: every type here is declared LOCALLY (mirrors the frozen
// API contract), never imported from @telar/core, so this module is safe in the
// client bundle. Server route handlers own the real reads; the UI only ever
// sees JSON shaped like this.
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";

/* ------------------------------------------------------------- scalars */

export type Sha = string;
export type EpochMs = number;
export type GitStatus = "M" | "A" | "?" | null;

// Mirrors @telar/core WorkUnitState as a plain string union — the contract
// forbids importing the zod enum into client code.
export type WorkUnitState =
  | "queued"
  | "scoping"
  | "charter-review"
  | "preparing"
  | "running"
  | "verifying"
  | "ready"
  | "done"
  | "needs-review"
  | "blocked"
  | "halted"
  | "failed"
  | "skipped";

// A worktree's loom is ACTIVE (removal ALWAYS refused) in one of these states.
export const ACTIVE_LOOM_STATES: WorkUnitState[] = [
  "queued",
  "scoping",
  "charter-review",
  "preparing",
  "running",
  "verifying",
];

export const isActiveLoomState = (s: WorkUnitState) =>
  ACTIVE_LOOM_STATES.includes(s);

export type CommitRef = {
  sha: Sha;
  subject: string;
  author: string;
  updatedAt: EpochMs;
};

/* ---------------------------------------------------------- overview GET */

export interface WorktreeOwnerLoom {
  kind: "loom";
  loomId: string;
  loomState: WorkUnitState;
}
export type WorktreeOwner = WorktreeOwnerLoom | { kind: "manual" };

export interface WorktreeRow {
  id: string;
  basename: string;
  path: string;
  branch: string | null;
  head: string;
  sha: Sha;
  updatedAt: EpochMs;
  sizeMb: number | null;
  owner: WorktreeOwner;
  merged: boolean;
  dirty: boolean;
  stale: boolean;
  isMainCheckout: boolean;
  isServerWorktree: boolean;
  reclaimable: boolean;
  removable: boolean;
}

export interface BranchRow {
  name: string;
  isDefault: boolean;
  merged: boolean;
  stale: boolean;
  ahead: number;
  behind: number;
  sha: Sha;
  subject: string;
  author: string;
  updatedAt: EpochMs;
  current: boolean;
}

export interface GitOverviewResponse {
  header: {
    branch: string;
    ahead: number;
    behind: number;
    dirtyFiles: number;
    lastCommit: CommitRef;
  };
  worktrees: WorktreeRow[];
  branches: BranchRow[];
  commits: CommitRef[];
  defaultBranch: string;
}

/* ----------------------------------------------------------- cleanup POST */

export type WorktreeCleanupItem = {
  kind: "worktree";
  id: string;
  force?: boolean;
  confirm?: string;
  deleteMergedBranch?: boolean;
};
export type BranchCleanupItem = { kind: "branch"; name: string };
export type CleanupItem = WorktreeCleanupItem | BranchCleanupItem;

export interface CleanupRequest {
  items: CleanupItem[];
}

export type RefusedReason =
  | "main-checkout"
  | "server-worktree"
  | "active-loom"
  | "dirty-needs-force"
  | "unmerged-needs-force"
  | "confirm-mismatch"
  | "branch-not-merged"
  | "not-found"
  | "git-error";

export interface CleanupResult {
  id: string;
  kind: "worktree" | "branch";
  ok: boolean;
  refusedReason?: RefusedReason;
  detail?: string;
}

export interface CleanupResponse {
  results: CleanupResult[];
}

// Human-readable rendering of a machine-stable refusal.
export const REFUSAL_TEXT: Record<RefusedReason, string> = {
  "main-checkout": "the repo's main checkout — never removable",
  "server-worktree": "the tree this server runs from — never removable",
  "active-loom": "backs an active loom — force cannot override this",
  "dirty-needs-force": "has uncommitted changes — needs a typed force",
  "unmerged-needs-force": "not merged — needs a typed force",
  "confirm-mismatch": "the typed confirmation did not match",
  "branch-not-merged": "branch not merged — refused (never escalates to -D)",
  "not-found": "no longer present",
  "git-error": "git reported an error",
};

/* ------------------------------------------------------------ remote GET */

export type RemoteState = "open" | "closed" | "merged" | "draft";
export type ReviewState =
  | "approved"
  | "changes_requested"
  | "review_required"
  | null;

export interface ChecksCluster {
  passed: number;
  failed: number;
  pending: number;
}
export type ChecksVerdict = "pass" | "fail" | "pending" | "none";
export function checksVerdict(c: ChecksCluster): ChecksVerdict {
  if (c.passed + c.failed + c.pending === 0) return "none";
  if (c.failed > 0) return "fail";
  if (c.pending > 0) return "pending";
  return "pass";
}

export interface RemoteIssue {
  number: number;
  title: string;
  state: RemoteState;
  author: string;
  updatedAt: EpochMs;
  labels: string[];
  comments: number;
}
export interface RemotePR {
  number: number;
  title: string;
  state: RemoteState;
  author: string;
  updatedAt: EpochMs;
  branch: string;
  base: string;
  checks: ChecksCluster;
  review: ReviewState;
  linkedLoomId: string | null;
}
export type RemoteReason = "no-gh" | "unauthed" | "no-remote" | "gh-error";
export type RemoteResponse =
  | { connected: false; reason: RemoteReason }
  | { connected: true; repo: string; issues: RemoteIssue[]; prs: RemotePR[] };

/* ---------------------------------------- remote detail + HUMAN-triggered writes */
// Client-local mirrors of the frozen JSON contract for the Remote DETAIL views
// and the four writes (create issue, comment, close/reopen). Server route
// handlers own the real `gh` reads/writes; the UI only ever sees JSON shaped
// like this. Every write is confirmed in the UI and refetches the list — no
// autonomous remote action (Loom Doctrine).

export interface RemoteComment {
  id: string;
  author: string;
  // OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR / NONE — null when unknown.
  authorAssociation: string | null;
  createdAt: EpochMs;
  body: string;
}

export interface IssueDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  author: string;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  body: string; // markdown; may be empty
  comments: RemoteComment[];
  url: string;
}

export type CheckState =
  | "success"
  | "failure"
  | "pending"
  | "skipped"
  | "neutral"
  | "cancelled"
  | "timed_out";
export interface CheckRun {
  name: string;
  state: CheckState;
  durationMs: number | null;
  url: string | null;
}

export type PRReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending";
export interface PRReviewEntry {
  author: string;
  state: PRReviewState;
  submittedAt: EpochMs | null;
}

export type Mergeable = "mergeable" | "conflicting" | "unknown";
export interface PRFileChange {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string | null; // capped by the server
  patchTruncated: boolean; // true when the server truncated the patch
}

export interface PRDetail {
  number: number;
  title: string;
  state: RemoteState; // open | closed | merged | draft
  draft: boolean;
  merged: boolean;
  author: string;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  head: string;
  base: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  mergeable: Mergeable;
  body: string; // markdown; may be empty
  comments: RemoteComment[];
  reviews: PRReviewEntry[];
  checks: CheckRun[];
  files: PRFileChange[];
  url: string;
}

export type IssueDetailResponse =
  | { connected: false; reason: RemoteReason }
  | { connected: true; issue: IssueDetail };
export type PRDetailResponse =
  | { connected: false; reason: RemoteReason }
  | { connected: true; pr: PRDetail };

// Writes — every response is connected-gated and returns { ok } so the UI can
// surface an honest failure inline (never a 500). `T` carries the write's echo.
export type RemoteWriteResponse<T = Record<string, never>> =
  | { connected: false; reason: RemoteReason }
  | ({ connected: true; ok: true } & T)
  | { connected: true; ok: false; error: string };

export type CreateIssueResult = RemoteWriteResponse<{ issue: RemoteIssue }>;
export type CommentResult = RemoteWriteResponse<{ comment: RemoteComment }>;
export type IssueStateResult = RemoteWriteResponse<{ state: "open" | "closed" }>;

// Human-readable rendering of a machine-stable remote disconnect reason.
export const REMOTE_REASON_TEXT: Record<RemoteReason, string> = {
  "no-gh": "the gh CLI isn't installed",
  unauthed: "the gh CLI isn't authenticated (run gh auth login)",
  "no-remote": "this repo has no GitHub remote",
  "gh-error": "the gh CLI returned an error",
};

/* ------------------------------------------------------------- files GET */

export interface FileEntry {
  name: string;
  kind: "dir" | "file";
  status: GitStatus;
  commit: { subject: string; updatedAt: EpochMs; sha: Sha };
  heat: number;
}
export interface FilesResponse {
  path: string;
  breadcrumb: string[];
  entries: FileEntry[];
  // OPTIONAL: server may cap entries and note it; UI renders a truncation note.
  truncated?: boolean;
}

/* ------------------------------------------------------------ formatters */

// ~ size formatter — the tilde is load-bearing (du estimates). null → em dash.
export function fmtSize(mb: number | null): string {
  if (mb == null) return "—";
  if (mb >= 1024) return `~${(mb / 1024).toFixed(1)} GB`;
  return `~${Math.round(mb)} MB`;
}

// GitHub-style label colors keyed by name; class utilities so both themes read.
const LABEL_COLORS: Record<string, string> = {
  git: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  cleanup: "border-teal-500/30 bg-teal-500/10 text-teal-300",
  ux: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  future: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  integration: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
  bug: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  ci: "border-orange-500/30 bg-orange-500/10 text-orange-300",
  resolved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
};
export const labelColor = (name: string) =>
  LABEL_COLORS[name] ?? "border-border bg-muted/40 text-muted-foreground";

/* ------------------------------------------------------------ primitives */

// A tiny state chip in the git tab's quiet vocabulary. Reclaimable earns color.
export function GitChip({
  tone,
  children,
  className,
}: {
  tone: "reclaimable" | "active" | "dirty" | "merged" | "stale" | "muted";
  children: ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    reclaimable: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    active: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    dirty: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    merged: "border-border bg-muted/40 text-muted-foreground",
    stale: "border-border bg-transparent text-muted-foreground/80",
    muted: "border-border bg-transparent text-muted-foreground",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 gap-1 px-1.5 py-0 font-mono text-[10px]",
        tones[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}

// The section band heading each sub-view body.
export function SectionBand({
  icon: Icon,
  label,
  count,
  right,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
        {label}
      </span>
      {count != null && (
        <Badge
          variant="outline"
          className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
        >
          {count}
        </Badge>
      )}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status: GitStatus }) {
  if (!status) return null;
  const map: Record<Exclude<GitStatus, null>, string> = {
    M: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    A: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    "?": "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center p-0 font-mono text-[10px] leading-none",
        map[status],
      )}
    >
      {status}
    </Badge>
  );
}

// Heat dot: recently-churned paths glow warmer. Subtle by design.
export function HeatDot({ heat }: { heat: number }) {
  if (heat < 0.25) return <span className="size-1.5 shrink-0" aria-hidden />;
  const tone =
    heat >= 0.8
      ? "bg-orange-400"
      : heat >= 0.5
        ? "bg-amber-400/80"
        : "bg-amber-400/40";
  return (
    <span
      aria-hidden
      title={`churn ${Math.round(heat * 100)}%`}
      className={cn("size-1.5 shrink-0 rounded-full", tone)}
    />
  );
}

/* -------------------------------------------------- loading / error states */

// A row-list skeleton sized for the git sub-views (two text lines + a trailing
// meta chip), so each sub-view shows the same density it will settle into.
export function SubSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <Skeleton className="size-4 shrink-0 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

export function SubError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="p-4">
      <EmptyState
        icon={TriangleAlertIcon}
        iconClassName="text-destructive/60"
        title="Couldn't load this section"
        description={
          <span className="font-mono text-xs break-words">{message}</span>
        }
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCwIcon />
            Retry
          </Button>
        }
      />
    </div>
  );
}
