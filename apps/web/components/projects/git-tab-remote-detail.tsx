"use client";

// REMOTE DETAIL — issue + pull-request detail views reached from the Remote
// list (LIST -> DETAIL, same in-place breadcrumb-back pattern as the Files
// browser; no route change). Detail data loads from the auth-gated `gh`
// endpoints; when the API says connected:false we render the same honest
// not-connected panel the list uses — never fabricated rows.
//
// WRITES are all HUMAN-triggered with explicit confirmation (Loom Doctrine):
// the comment composer POSTs then optimistically appends, Close/Reopen requires
// a two-step confirm, and every action is disabled with an honest hint when the
// remote is not connected. After any write we ask the parent to refetch the list.
//
// CLIENT-BUNDLE RULE: types come from ./git-tab-shared (client-safe local
// mirrors); the only markdown path is the app's existing MessageResponse
// renderer — no new dependency, plaintext falls back to preserved whitespace.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ClockIcon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  MilestoneIcon,
  MinusIcon,
  SendHorizonalIcon,
  ShieldCheckIcon,
  TagIcon,
  TriangleAlertIcon,
  UserIcon,
  UsersIcon,
  XCircleIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fmtAgo } from "@/lib/format";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  SubError,
  SubSkeleton,
  labelColor,
  REMOTE_REASON_TEXT,
  type CheckRun,
  type CommentResult,
  type IssueDetail,
  type IssueDetailResponse,
  type IssueStateResult,
  type PRDetail,
  type PRDetailResponse,
  type PRFileChange,
  type PRReviewEntry,
  type RemoteComment,
  type RemoteReason,
  type RemoteState,
} from "./git-tab-shared";

/* ----------------------------------------------------------------- markdown */

// The app's markdown renderer (recon-identified MessageResponse / Streamdown).
// Empty bodies render an honest muted note rather than a blank block; non-empty
// bodies render through the existing pipeline — no new dependency is added, and
// plain text degrades to preserved whitespace inside that renderer.
function RemoteMarkdown({ body }: { body: string }) {
  if (!body.trim()) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No description provided.
      </p>
    );
  }
  return (
    <MessageResponse className="max-w-none text-sm leading-relaxed break-words">
      {body}
    </MessageResponse>
  );
}

/* ------------------------------------------------------------- small helpers */

function fmtDuration(ms: number | null): string | null {
  if (ms == null || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

const STATE_CHIP: Record<
  RemoteState,
  { icon: LucideIcon; label: string; cls: string }
> = {
  open: {
    icon: CircleDotIcon,
    label: "Open",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  closed: {
    icon: CheckCircle2Icon,
    label: "Closed",
    cls: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  },
  merged: {
    icon: GitMergeIcon,
    label: "Merged",
    cls: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  },
  draft: {
    icon: GitPullRequestDraftIcon,
    label: "Draft",
    cls: "border-border bg-muted/40 text-muted-foreground",
  },
};

function StateChip({ state }: { state: RemoteState }) {
  const s = STATE_CHIP[state];
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 gap-1 px-2 py-0.5 text-[11px] font-medium", s.cls)}
    >
      <s.icon className="size-3" />
      {s.label}
    </Badge>
  );
}

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {children}
      </div>
    </div>
  );
}

function DetailMeta({
  labels,
  assignees,
  milestone,
}: {
  labels: string[];
  assignees: string[];
  milestone: string | null;
}) {
  if (labels.length === 0 && assignees.length === 0 && !milestone) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
      {labels.length > 0 && (
        <MetaRow icon={TagIcon} label="Labels">
          {labels.map((l) => (
            <Badge
              key={l}
              variant="outline"
              className={cn(
                "px-1.5 py-0 text-[10px] font-normal",
                labelColor(l),
              )}
            >
              {l}
            </Badge>
          ))}
        </MetaRow>
      )}
      {assignees.length > 0 && (
        <MetaRow icon={UsersIcon} label="Assignees">
          {assignees.map((a) => (
            <span key={a} className="text-foreground/90">
              {a}
            </span>
          ))}
        </MetaRow>
      )}
      {milestone && (
        <MetaRow icon={MilestoneIcon} label="Milestone">
          <span className="text-foreground/90">{milestone}</span>
        </MetaRow>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- shared header */

type DetailKind = "issue" | "pr";

function BreadcrumbBack({
  kind,
  number,
  onBack,
  url,
}: {
  kind: DetailKind;
  number: number;
  onBack: () => void;
  url: string;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-background/40 px-4 py-1.5 text-xs">
      <button
        type="button"
        onClick={onBack}
        className="rounded px-1 py-0.5 font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Remote
      </button>
      <ChevronRightIcon className="size-3 text-muted-foreground/50" />
      <button
        type="button"
        onClick={onBack}
        className="rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        {kind === "issue" ? "Issues" : "Pull requests"}
      </button>
      <ChevronRightIcon className="size-3 text-muted-foreground/50" />
      <span className="px-1 py-0.5 font-mono font-medium text-foreground">
        #{number}
      </span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
        title="Open on GitHub"
      >
        <ExternalLinkIcon className="size-3" />
        <span className="hidden sm:inline">GitHub</span>
      </a>
    </div>
  );
}

function DetailHeader({
  title,
  number,
  state,
  author,
  createdAt,
  extra,
}: {
  title: string;
  number: number;
  state: RemoteState;
  author: string;
  createdAt: number;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-base leading-snug font-semibold break-words text-foreground">
          {title}{" "}
          <span className="font-mono font-normal text-muted-foreground">
            #{number}
          </span>
        </h2>
        <StateChip state={state} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <UserIcon className="size-3" />
          <span className="text-foreground/90">{author}</span>
        </span>
        <span className="text-border">·</span>
        <span>opened {fmtAgo(createdAt)}</span>
        {extra}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- comment thread */

function AuthorAssociationChip({ assoc }: { assoc: string | null }) {
  if (!assoc || assoc === "NONE") return null;
  const pretty = assoc.charAt(0) + assoc.slice(1).toLowerCase();
  return (
    <Badge
      variant="outline"
      className="border-border bg-muted/40 px-1 py-0 text-[9px] font-normal text-muted-foreground uppercase"
    >
      {pretty}
    </Badge>
  );
}

// A comment carries `pending` while its optimistic write is in flight.
type ThreadComment = RemoteComment & { pending?: boolean; failed?: boolean };

function CommentCard({ comment }: { comment: ThreadComment }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card/60",
        comment.pending && "opacity-70",
        comment.failed && "border-destructive/40",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <UserIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground/90">{comment.author}</span>
        <AuthorAssociationChip assoc={comment.authorAssociation} />
        <span className="text-muted-foreground/70">
          {comment.pending
            ? "sending…"
            : comment.failed
              ? "failed to send"
              : fmtAgo(comment.createdAt)}
        </span>
        {comment.pending && (
          <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />
        )}
        {comment.failed && (
          <TriangleAlertIcon className="ml-auto size-3 text-destructive" />
        )}
      </div>
      <div className="px-3 py-2">
        <RemoteMarkdown body={comment.body} />
      </div>
    </div>
  );
}

function CommentThread({ comments }: { comments: ThreadComment[] }) {
  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
        {comments.length} comment{comments.length === 1 ? "" : "s"}
      </div>
      {comments.map((c) => (
        <CommentCard key={c.id} comment={c} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ composer */

// The write bar: comment composer + a Close/Reopen affordance for issues. All
// controls are disabled with an honest hint when the remote is not connected.
function WriteBar({
  gate,
  submitting,
  onComment,
  stateAction,
}: {
  gate: RemoteReason | null;
  submitting: boolean;
  onComment: (body: string) => Promise<boolean>;
  stateAction?: ReactNode;
}) {
  const [body, setBody] = useState("");
  const disabled = gate != null;
  const canSend = !disabled && !submitting && body.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    const ok = await onComment(body.trim());
    if (ok) setBody("");
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-background/40 px-4 py-3">
      {disabled && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
          <p className="text-[11px] text-muted-foreground">
            Writing is unavailable — {REMOTE_REASON_TEXT[gate]}. Nothing was sent.
          </p>
        </div>
      )}
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={disabled || submitting}
        placeholder="Leave a comment… (markdown supported)"
        className="min-h-20 text-sm"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">{stateAction}</div>
        <Button
          size="sm"
          disabled={!canSend}
          onClick={() => void send()}
          className="shrink-0"
        >
          {submitting ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <SendHorizonalIcon />
          )}
          Comment
        </Button>
      </div>
    </div>
  );
}

// Two-step confirm for Close / Reopen (HUMAN-triggered, explicit confirmation).
function StateToggle({
  state,
  gate,
  busy,
  onToggle,
}: {
  state: "open" | "closed";
  gate: RemoteReason | null;
  busy: boolean;
  onToggle: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const disabled = gate != null;
  const closing = state === "open";

  if (disabled) {
    return (
      <Button size="sm" variant="outline" disabled>
        {closing ? "Close" : "Reopen"} issue
      </Button>
    );
  }

  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {closing ? (
          <CheckCircle2Icon className="text-violet-400" />
        ) : (
          <CircleDotIcon className="text-emerald-400" />
        )}
        {closing ? "Close" : "Reopen"} issue
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">
        {closing ? "Close this issue?" : "Reopen this issue?"}
      </span>
      <Button
        size="sm"
        variant={closing ? "destructive" : "default"}
        disabled={busy}
        onClick={onToggle}
      >
        {busy ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />}
        Confirm
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </div>
  );
}

/* --------------------------------------------------- write plumbing (shared) */

// A composer hook shared by issue & PR detail: keeps optimistic thread state and
// posts to the given comment endpoint. On success it swaps the optimistic row
// for the server's canonical comment; on failure it marks the row failed.
function useCommentThread(
  base: RemoteComment[],
  endpoint: string,
  onWrote: () => void,
) {
  const [extra, setExtra] = useState<ThreadComment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [gate, setGate] = useState<RemoteReason | null>(null);
  const seq = useRef(0);

  const comments = useMemo<ThreadComment[]>(
    () => [...base, ...extra],
    [base, extra],
  );

  const onComment = useCallback(
    async (body: string): Promise<boolean> => {
      const tmpId = `tmp-${++seq.current}`;
      const optimistic: ThreadComment = {
        id: tmpId,
        author: "you",
        authorAssociation: null,
        createdAt: Date.now(),
        body,
        pending: true,
      };
      setExtra((xs) => [...xs, optimistic]);
      setSubmitting(true);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        const data = (await res.json().catch(() => null)) as CommentResult | null;
        if (!data) throw new Error(`Comment failed (${res.status}).`);
        if (!data.connected) {
          setGate(data.reason);
          setExtra((xs) => xs.filter((c) => c.id !== tmpId));
          return false;
        }
        if (!data.ok) {
          setExtra((xs) =>
            xs.map((c) =>
              c.id === tmpId ? { ...c, pending: false, failed: true } : c,
            ),
          );
          return false;
        }
        setExtra((xs) =>
          xs.map((c) => (c.id === tmpId ? { ...data.comment } : c)),
        );
        onWrote();
        return true;
      } catch {
        setExtra((xs) =>
          xs.map((c) =>
            c.id === tmpId ? { ...c, pending: false, failed: true } : c,
          ),
        );
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [endpoint, onWrote],
  );

  return { comments, submitting, gate, setGate, onComment };
}

/* ------------------------------------------------------------- ISSUE detail */

export function IssueDetailView({
  name,
  number,
  onBack,
  onListStale,
}: {
  name: string;
  number: number;
  onBack: () => void;
  onListStale: () => void;
}) {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState<RemoteReason | null>(null);
  const [stateBusy, setStateBusy] = useState(false);

  const endpoint = `/api/projects/${encodeURIComponent(name)}/git/remote/issues/${number}`;

  const load = useCallback(async () => {
    setError(null);
    setNotConnected(null);
    setIssue(null);
    try {
      const res = await fetch(endpoint);
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `Issue read failed (${res.status}).`);
      }
      const data = (await res.json()) as IssueDetailResponse;
      if (!data.connected) setNotConnected(data.reason);
      else setIssue(data.issue);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const thread = useCommentThread(
    issue?.comments ?? [],
    `${endpoint}/comment`,
    onListStale,
  );

  const toggleState = useCallback(async () => {
    if (!issue) return;
    const next = issue.state === "open" ? "closed" : "open";
    setStateBusy(true);
    try {
      const res = await fetch(`${endpoint}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: next }),
      });
      const data = (await res.json().catch(() => null)) as IssueStateResult | null;
      if (!data) throw new Error(`State change failed (${res.status}).`);
      if (!data.connected) {
        thread.setGate(data.reason);
        return;
      }
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setIssue({ ...issue, state: data.state });
      onListStale();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStateBusy(false);
    }
  }, [issue, endpoint, onListStale, thread]);

  const gate: RemoteReason | null = notConnected ?? thread.gate;

  return (
    <div>
      <BreadcrumbBack
        kind="issue"
        number={number}
        onBack={onBack}
        url={issue?.url ?? `https://github.com`}
      />
      {error ? (
        <SubError message={error} onRetry={() => void load()} />
      ) : notConnected ? (
        <NotConnectedInline reason={notConnected} onRetry={() => void load()} />
      ) : issue === null ? (
        <SubSkeleton rows={4} />
      ) : (
        <>
          <DetailHeader
            title={issue.title}
            number={issue.number}
            state={issue.state}
            author={issue.author}
            createdAt={issue.createdAt}
          />
          <div className="border-t border-border px-4 py-3">
            <RemoteMarkdown body={issue.body} />
          </div>
          <DetailMeta
            labels={issue.labels}
            assignees={issue.assignees}
            milestone={issue.milestone}
          />
          <CommentThread comments={thread.comments} />
          <WriteBar
            gate={gate}
            submitting={thread.submitting}
            onComment={thread.onComment}
            stateAction={
              <StateToggle
                state={issue.state}
                gate={gate}
                busy={stateBusy}
                onToggle={() => void toggleState()}
              />
            }
          />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- PR sub-parts */

const CHECK_ICON: Record<
  CheckRun["state"],
  { icon: LucideIcon; cls: string }
> = {
  success: { icon: CheckCircle2Icon, cls: "text-emerald-400" },
  failure: { icon: XCircleIcon, cls: "text-destructive" },
  pending: { icon: ClockIcon, cls: "text-amber-400" },
  skipped: { icon: MinusIcon, cls: "text-muted-foreground" },
  neutral: { icon: MinusIcon, cls: "text-muted-foreground" },
  cancelled: { icon: XIcon, cls: "text-muted-foreground" },
  timed_out: { icon: ClockIcon, cls: "text-destructive" },
};

function ChecksList({ checks }: { checks: CheckRun[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="flex flex-col border-t border-border">
      <div className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-muted-foreground">
        <ShieldCheckIcon className="size-3.5" />
        Checks
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {checks.length}
        </span>
      </div>
      <div className="divide-y divide-border border-t border-border">
        {checks.map((c, i) => {
          const ic = CHECK_ICON[c.state];
          const dur = fmtDuration(c.durationMs);
          const row = (
            <>
              <ic.icon className={cn("size-3.5 shrink-0", ic.cls)} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
                {c.name}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground capitalize">
                {c.state.replace("_", " ")}
              </span>
              {dur && (
                <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground/70">
                  {dur}
                </span>
              )}
              {c.url && (
                <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground/50" />
              )}
            </>
          );
          return c.url ? (
            <a
              key={i}
              href={c.url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-4 py-1.5 transition-colors hover:bg-muted/30"
            >
              {row}
            </a>
          ) : (
            <div key={i} className="flex items-center gap-2 px-4 py-1.5">
              {row}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const REVIEW_CHIP: Record<
  PRReviewEntry["state"],
  { label: string; cls: string }
> = {
  approved: {
    label: "approved",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  changes_requested: {
    label: "changes requested",
    cls: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  },
  commented: {
    label: "commented",
    cls: "border-border bg-muted/40 text-muted-foreground",
  },
  dismissed: {
    label: "dismissed",
    cls: "border-border bg-muted/40 text-muted-foreground line-through",
  },
  pending: {
    label: "pending",
    cls: "border-border bg-transparent text-muted-foreground",
  },
};

function ReviewsList({ reviews }: { reviews: PRReviewEntry[] }) {
  if (reviews.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
      <div className="text-xs font-medium text-muted-foreground">Reviews</div>
      <div className="flex flex-col gap-1">
        {reviews.map((r, i) => {
          const chip = REVIEW_CHIP[r.state];
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-foreground/90">
                {r.author}
              </span>
              <Badge
                variant="outline"
                className={cn("shrink-0 px-1.5 py-0 text-[10px]", chip.cls)}
              >
                {chip.label}
              </Badge>
              {r.submittedAt && (
                <span className="w-12 shrink-0 text-right text-muted-foreground/70">
                  {fmtAgo(r.submittedAt)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One diff line, lightly colored by its leading marker (+/-/@@). Kept plain
// mono otherwise; the patch is server-capped and never re-fetched wholesale.
function PatchView({ patch, truncated }: { patch: string; truncated: boolean }) {
  const lines = patch.split("\n");
  return (
    <div className="overflow-x-auto border-t border-border bg-muted/20">
      <pre className="min-w-full py-1 font-mono text-[11px] leading-relaxed">
        {lines.map((ln, i) => {
          const c = ln[0];
          const cls =
            ln.startsWith("@@")
              ? "text-sky-400"
              : c === "+"
                ? "text-emerald-300 bg-emerald-500/5"
                : c === "-"
                  ? "text-rose-300 bg-rose-500/5"
                  : "text-muted-foreground";
          return (
            <div key={i} className={cn("px-3 whitespace-pre", cls)}>
              {ln || " "}
            </div>
          );
        })}
      </pre>
      {truncated && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          Patch truncated for size — open the pull request on GitHub for the full
          diff.
        </p>
      )}
    </div>
  );
}

function FileChangeRow({ file }: { file: PRFileChange }) {
  const [open, setOpen] = useState(false);
  const expandable = !file.binary && !!file.patch;
  return (
    <div>
      <div
        role={expandable ? "button" : undefined}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        className={cn(
          "flex items-center gap-2 px-4 py-1.5",
          expandable && "cursor-pointer hover:bg-muted/30",
        )}
      >
        {expandable ? (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90"
          title={file.path}
        >
          {file.path}
        </span>
        {file.binary ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            binary
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-emerald-400">+{file.additions}</span>{" "}
            <span className="text-rose-400">−{file.deletions}</span>
          </span>
        )}
      </div>
      {expandable && open && file.patch && (
        <PatchView patch={file.patch} truncated={file.patchTruncated} />
      )}
    </div>
  );
}

function FilesChanged({ files }: { files: PRFileChange[] }) {
  if (files.length === 0) return null;
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="flex flex-col border-t border-border">
      <div className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-muted-foreground">
        <FileDiffIcon className="size-3.5" />
        Files changed
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {files.length}
        </span>
        <span className="ml-auto font-mono text-[11px] tabular-nums">
          <span className="text-emerald-400">+{add}</span>{" "}
          <span className="text-rose-400">−{del}</span>
        </span>
      </div>
      <div className="divide-y divide-border border-t border-border">
        {files.map((f) => (
          <FileChangeRow key={f.path} file={f} />
        ))}
      </div>
    </div>
  );
}

const MERGEABLE_TEXT: Record<
  PRDetail["mergeable"],
  { label: string; cls: string }
> = {
  mergeable: { label: "No conflicts with the base branch", cls: "text-emerald-300" },
  conflicting: { label: "Has conflicts with the base branch", cls: "text-amber-300" },
  unknown: { label: "Mergeability not yet computed", cls: "text-muted-foreground" },
};

/* ----------------------------------------------------------------- PR detail */

export function PRDetailView({
  name,
  number,
  onBack,
  onListStale,
}: {
  name: string;
  number: number;
  onBack: () => void;
  onListStale: () => void;
}) {
  const [pr, setPr] = useState<PRDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState<RemoteReason | null>(null);

  const endpoint = `/api/projects/${encodeURIComponent(name)}/git/remote/prs/${number}`;

  const load = useCallback(async () => {
    setError(null);
    setNotConnected(null);
    setPr(null);
    try {
      const res = await fetch(endpoint);
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `PR read failed (${res.status}).`);
      }
      const data = (await res.json()) as PRDetailResponse;
      if (!data.connected) setNotConnected(data.reason);
      else setPr(data.pr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const thread = useCommentThread(
    pr?.comments ?? [],
    `${endpoint}/comment`,
    onListStale,
  );

  const gate: RemoteReason | null = notConnected ?? thread.gate;
  const mergeable = pr ? MERGEABLE_TEXT[pr.mergeable] : null;

  return (
    <div>
      <BreadcrumbBack
        kind="pr"
        number={number}
        onBack={onBack}
        url={pr?.url ?? `https://github.com`}
      />
      {error ? (
        <SubError message={error} onRetry={() => void load()} />
      ) : notConnected ? (
        <NotConnectedInline reason={notConnected} onRetry={() => void load()} />
      ) : pr === null ? (
        <SubSkeleton rows={5} />
      ) : (
        <>
          <DetailHeader
            title={pr.title}
            number={pr.number}
            state={pr.state}
            author={pr.author}
            createdAt={pr.createdAt}
            extra={
              <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
                <span className="truncate">{pr.head}</span>
                <CornerDownRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
                <span className="shrink-0 text-muted-foreground/80">
                  {pr.base}
                </span>
              </span>
            }
          />
          {mergeable && (
            <div className="flex items-center gap-2 border-t border-border px-4 py-2">
              <GitMergeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("text-xs", mergeable.cls)}>
                {mergeable.label}
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground/60">
                merge not offered here
              </span>
            </div>
          )}
          <div className="border-t border-border px-4 py-3">
            <RemoteMarkdown body={pr.body} />
          </div>
          <DetailMeta
            labels={pr.labels}
            assignees={pr.assignees}
            milestone={pr.milestone}
          />
          <ReviewsList reviews={pr.reviews} />
          <ChecksList checks={pr.checks} />
          <FilesChanged files={pr.files} />
          <CommentThread comments={thread.comments} />
          <WriteBar
            gate={gate}
            submitting={thread.submitting}
            onComment={thread.onComment}
          />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------- not-connected (inline) */

// Compact not-connected panel for a detail view (the list owns the full one).
function NotConnectedInline({
  reason,
  onRetry,
}: {
  reason: RemoteReason;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <TriangleAlertIcon className="size-6 text-muted-foreground" />
      <p className="max-w-sm text-xs text-muted-foreground">
        GitHub is no longer connected — {REMOTE_REASON_TEXT[reason]}. This surface
        is read-only until it reconnects.
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Check again
      </Button>
    </div>
  );
}
