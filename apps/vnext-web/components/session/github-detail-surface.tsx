"use client";

/**
 * ONE ISSUE OR ONE PULL REQUEST, OPEN IN THE PANEL — AND MERGEABLE FROM IT.
 *
 * WHY A TAB PER THING, exactly as a file gets one. The panel already has a
 * grammar for "something I opened that is not a fold over the session": one tab
 * per browser page, one per file. An issue is the same kind of thing — you opened
 * it, several can be open at once, each closes on its own, and the arrangement
 * survives a reload. `issue:82` and `pull:12` sit beside `file:<path>` and
 * `browser:<id>` for that reason, and not one line of tab machinery was added to
 * support them.
 *
 * WHAT THE LIST COULD NOT SHOW, which is most of what an issue IS: the body, the
 * conversation, who is assigned, which milestone, why it was closed. For a pull
 * request also the branch pair, the diffstat, every review round, the head
 * commit's checks, and whether GitHub will merge it.
 *
 * MERGING IS THE ONE OUTWARD-FACING ACTION IN THIS COCKPIT. Everything else here
 * writes into the engine's own state or into a checkout on this machine; this
 * changes a public repository and cannot be undone from Telar. Three things follow:
 *
 *   - IT ASKS. One press arms, a second merges. Not a dialog — a dialog covers the
 *     pull request you are deciding about — but the button row becoming a sentence
 *     with the branch names in it.
 *   - IT IS PINNED TO WHAT YOU READ. The merge carries the `headRefOid` this read
 *     returned, and GitHub refuses if a commit landed since. Same shape as the file
 *     editor's hash precondition, and it exists for the same reason: an AGENT may
 *     be pushing to this branch while you look at it.
 *   - IT ONLY OFFERS METHODS THE REPOSITORY ALLOWS, because a squash button on a
 *     repository with squashing turned off is a refusal nobody could have predicted
 *     from the screen.
 *
 * IT DOES NOT POLL, and it does not re-read when a turn settles. This is somebody
 * else's rate limit — the same reason the list surface does not — and a detail tab
 * is the one most likely to be left open on a second monitor. The refresh button is
 * the only thing that asks again.
 */

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  CheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ClockIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  MilestoneIcon,
  RotateCwIcon,
  SquareKanbanIcon,
  TriangleAlertIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import type {
  GitHubCheck,
  GitHubComment,
  GitHubIssueDetail,
  GitHubMergeMethod,
  GitHubMergeRefusal,
  GitHubPullDetail,
  GitHubReview,
} from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { fmtAgo } from "@/lib/format";
import {
  checkHeadline,
  checkSummary,
  issueStatus,
  mergeReadiness,
  MERGE_REFUSAL,
  pullStatus,
  reviewLabel,
  STATUS_LABEL,
  STATUS_TONE,
  UNAVAILABLE,
} from "@/lib/github-forge";
import { issueReference, pullReference, startReferenceDrag } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MessageResponse } from "@/components/ui/message";
import { PanelDivider, PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createVNextApi();

/** What each method's button says. GitHub's own wording, because these are
 *  GitHub's operations and a reader who has merged on the website knows them. */
const METHOD_LABEL: Record<GitHubMergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/** An exact timestamp for the hover, because "3 days ago" is the right thing to
 *  read and the wrong thing to quote. */
function when(ts: number): string {
  return new Date(ts).toLocaleString();
}

/**
 * The five-colour vocabulary, applied to a state badge.
 *
 * THE SAME `ForgeStatus` THE LIST ROWS USE, so the badge on this header and the
 * glyph on the row you clicked to get here cannot disagree about whether an issue
 * closed as "done" or "not planned" — which they would, immediately, as two
 * hand-written mappings of GitHub's words.
 */
const TONE_CLASS: Record<"active" | "done" | "info" | "none", string> = {
  active: "text-primary border-primary/40",
  done: "text-success border-success/40",
  info: "text-info border-info/40",
  none: "text-muted-foreground",
};

/**
 * The shared header row.
 *
 * DRAGGABLE, for the same reason the file view's address row is: the thing you
 * are looking at is usually the thing you want to point the agent at, and this
 * carries the same reference the list row does — so a tab you opened from a row
 * still drags as that row.
 */
function ForgeHeader({
  icon,
  number,
  title,
  url,
  state,
  onRefresh,
  refreshing,
  onDrag,
}: {
  icon: React.ReactNode;
  number: number;
  title: string;
  url: string;
  state: { words: string; tone: keyof typeof TONE_CLASS };
  onRefresh: () => void;
  refreshing: boolean;
  onDrag: (transfer: DataTransfer) => void;
}) {
  return (
    <div
      draggable
      onDragStart={(event) => onDrag(event.dataTransfer)}
      title={`#${number} — drag into the message to reference it`}
      className="flex shrink-0 cursor-grab items-start gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
    >
      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{number}</span>
          <span className="min-w-0 flex-1 text-xs font-medium" title={title}>
            {title}
          </span>
        </span>
        <Badge variant="outline" className={cn("mt-1 px-1 py-0 text-[9px] font-normal", TONE_CLASS[state.tone])}>
          {state.words}
        </Badge>
      </span>
      <button
        type="button"
        aria-label="Read this again"
        title="Ask gh again"
        onClick={onRefresh}
        className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
      </button>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open #${number} on GitHub`}
        title="Open on GitHub"
        // Dragging a link is the browser's own gesture and would replace ours.
        draggable={false}
        className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ExternalLinkIcon className="size-3" />
      </a>
    </div>
  );
}

/** One line of `label: value` facts. Rows with nothing to say are absent rather
 *  than empty — an assignee row reading "—" is a row that taught you nothing. */
function MetaRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-[11px] text-muted-foreground">
      <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center [&_svg]:size-3">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/**
 * HEADINGS, RESCALED FOR A PANEL.
 *
 * The transcript's markdown is tuned for a 50rem reading lane, where an `h1` at
 * 24px is right. This column can be 320px, and its own chrome is 10–11px — so the
 * donor scale puts a heading four times the size of the label above it and the
 * body stops reading as one surface. The HIERARCHY is what matters and it is kept:
 * three distinct steps, all of them inside the panel's register.
 *
 * Measured in the real window rather than assumed: at panel width the unscaled
 * `h2` was the largest text on screen, larger than the session title beside it.
 */
const PANEL_MARKDOWN =
  "[&_h1]:text-sm [&_h1]:mt-3 [&_h2]:text-[13px] [&_h2]:mt-3 [&_h3]:text-xs [&_h4]:text-xs [&_h5]:text-xs [&_h6]:text-xs [&_pre]:text-[10px] [&_code]:text-[10px]";

/**
 * IMAGES ARE PLAIN, WHICH FIXES A REAL HYDRATION ERROR.
 *
 * Streamdown renders a link as `<button data-streamdown=link>` — that is how its
 * link-safety gate works — and renders an image with a "Download image" `<button>`
 * on top. A LINKED IMAGE therefore nests a button inside a button, which is
 * invalid HTML and a React hydration error. That is not a corner case here:
 * `[![badge](img)](link)` is how every GitHub body carries a badge, and the first
 * real pull request this surface opened had one.
 *
 * Overriding the IMAGE rather than the link is deliberate. Making links plain
 * `<a>` would also fix the nesting, and would throw away the safety gate on
 * markdown that arrived from a stranger's issue — exactly the content that gate is
 * for. Nobody needs a download button on a badge in a 320px column; everybody
 * benefits from knowing where a link goes.
 *
 * The transcript's own `MessageResponse` keeps Streamdown's controls, because an
 * agent's generated chart IS worth downloading. It has the same latent nesting bug
 * for a linked image, which nothing has produced yet.
 */
const PANEL_IMAGE = {
  /** `src` is typed `string | Blob` by the markdown pipeline — a Blob is not
   *  something a GitHub body can produce, and it is not something `<img src>`
   *  takes, so a non-string is dropped rather than coerced. */
  img: ({ src, alt, title }: ComponentProps<"img">) =>
    typeof src === "string" && src ? (
      /* eslint-disable-next-line @next/next/no-img-element -- an arbitrary remote
         host from somebody's issue body; next/image cannot optimise what it is not
         configured for, and configuring it would mean allow-listing GitHub's CDNs. */
      <img
        src={src}
        alt={alt ?? ""}
        {...(title ? { title } : {})}
        loading="lazy"
        // A badge is small and a screenshot pasted into an issue is not: capped so
        // one image cannot own the panel.
        className="my-1 max-h-64 max-w-full rounded border border-border"
      />
    ) : null,
};

/**
 * A body or a comment, rendered as markdown by the SAME renderer as the
 * transcript.
 *
 * Not a cosmetic choice: an issue body is markdown written for GitHub, and
 * rendering it with anything other than the component that already draws the
 * agent's prose would put two markdown engines in one window, disagreeing about
 * code fences in a panel whose whole job is to make the two feel like one
 * instrument.
 */
function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <MessageResponse className={cn("text-xs", PANEL_MARKDOWN, className)} components={PANEL_IMAGE}>
      {children}
    </MessageResponse>
  );
}

/**
 * The conversation.
 *
 * A COMMENT GITHUB HID STAYS HIDDEN, behind its reason and a click. Rendering a
 * spam-hidden comment in full beside the real ones shows a reader something the
 * repository decided to hide — and GitHub itself collapses these.
 */
function CommentBody({ comment }: { comment: GitHubComment }) {
  const [revealed, setRevealed] = useState(false);
  if (comment.minimized && !revealed) {
    return (
      <button
        type="button"
        onClick={() => setRevealed(true)}
        className="rounded border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
      >
        Hidden by the repository{comment.minimizedReason ? ` as ${comment.minimizedReason.toLowerCase().replaceAll("_", " ")}` : ""} — show anyway
      </button>
    );
  }
  return <Markdown>{comment.body}</Markdown>;
}

function CommentThread({ comments, older }: { comments: readonly GitHubComment[]; older: number }) {
  if (comments.length === 0 && older === 0) return null;
  return (
    <>
      <PanelDivider label={`${comments.length + older} ${comments.length + older === 1 ? "comment" : "comments"}`} />
      {/* NEVER SILENT ABOUT THE CUT. A surface that dropped half a conversation
          without saying so has lied about the conversation. */}
      {older > 0 && (
        <p className="px-3 pb-2 text-[10px] text-muted-foreground">
          The {older} oldest {older === 1 ? "comment is" : "comments are"} not shown — open it on GitHub for the whole thread.
        </p>
      )}
      <div className="flex flex-col gap-3 px-3 pb-3">
        {comments.map((comment) => (
          <div key={comment.url} className="min-w-0">
            <p className="mb-1 flex items-baseline gap-1.5 text-[10px] text-muted-foreground">
              <span className="font-medium text-foreground">{comment.author ?? "someone"}</span>
              {comment.authorAssociation && comment.authorAssociation !== "NONE" && (
                <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal">
                  {comment.authorAssociation.toLowerCase()}
                </Badge>
              )}
              <span title={when(comment.createdAt)}>{fmtAgo(comment.createdAt)}</span>
            </p>
            <CommentBody comment={comment} />
          </div>
        ))}
      </div>
    </>
  );
}

/** Which glyph a check wears. A running check gets a clock rather than a faded
 *  tick, because "not failed yet" and "passed" must not look alike. */
function CheckGlyph({ check }: { check: GitHubCheck }) {
  const conclusion = check.conclusion?.toUpperCase();
  if (check.status.toUpperCase() !== "COMPLETED" || !conclusion) return <ClockIcon className="size-3 text-primary" />;
  if (conclusion === "SUCCESS") return <CheckIcon className="size-3 text-success" />;
  if (conclusion === "SKIPPED" || conclusion === "NEUTRAL" || conclusion === "CANCELLED")
    return <CircleSlashIcon className="size-3 text-muted-foreground" />;
  return <XIcon className="size-3 text-destructive" />;
}

/**
 * The head commit's checks.
 *
 * FAILING AND RUNNING ONES ARE LISTED; passing ones are counted. Twenty-five green
 * rows in a 320px column is a wall that hides the one red row in it, and the
 * question this block answers is "is anything wrong", not "what ran".
 */
function ChecksBlock({ checks }: { checks: readonly GitHubCheck[] }) {
  const summary = useMemo(() => checkSummary(checks), [checks]);
  const notable = checks.filter((check) => {
    const conclusion = check.conclusion?.toUpperCase();
    if (check.status.toUpperCase() !== "COMPLETED" || !conclusion) return true;
    return conclusion !== "SUCCESS" && conclusion !== "SKIPPED" && conclusion !== "NEUTRAL" && conclusion !== "CANCELLED";
  });

  return (
    <>
      <PanelDivider label="checks" />
      {summary.total === 0 ? (
        /* NOT "all clear". No checks ran is a different fact from every check
           passing, and a green tick here would invent a CI this repository does
           not have. */
        <p className="px-3 pb-3 text-[11px] text-muted-foreground">No checks ran on this commit.</p>
      ) : (
        <div className="flex flex-col gap-1 px-3 pb-3">
          <p className={cn("text-[11px]", summary.failed > 0 ? "text-destructive" : "text-muted-foreground")}>{checkHeadline(summary)}</p>
          {notable.map((check, at) => (
            <div key={`${check.name}-${at}`} className="flex min-w-0 items-center gap-1.5 text-[11px]">
              <CheckGlyph check={check} />
              <span className="min-w-0 flex-1 truncate" title={check.workflow ? `${check.workflow} · ${check.name}` : check.name}>
                {check.name}
              </span>
              {check.url && (
                <a
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${check.name} on GitHub`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ExternalLinkIcon className="size-3" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const REVIEW_TONE: Record<string, string> = {
  APPROVED: "text-success",
  CHANGES_REQUESTED: "text-destructive",
  DISMISSED: "text-muted-foreground",
};

function ReviewsBlock({ reviews }: { reviews: readonly GitHubReview[] }) {
  if (reviews.length === 0) return null;
  return (
    <>
      <PanelDivider label={`${reviews.length} ${reviews.length === 1 ? "review" : "reviews"}`} />
      <div className="flex flex-col gap-2.5 px-3 pb-3">
        {reviews.map((review, at) => (
          <div key={`${review.author ?? "?"}-${review.submittedAt}-${at}`} className="min-w-0">
            <p className="mb-1 flex items-baseline gap-1.5 text-[10px] text-muted-foreground">
              <span className="font-medium text-foreground">{review.author ?? "someone"}</span>
              <span className={cn(REVIEW_TONE[review.state.toUpperCase()] ?? "text-muted-foreground")}>{reviewLabel(review.state)}</span>
              <span title={when(review.submittedAt)}>{fmtAgo(review.submittedAt)}</span>
            </p>
            {review.body.trim() && <Markdown>{review.body}</Markdown>}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * THE MERGE.
 *
 * A FOOTER, OUTSIDE THE SCROLLER, because it is the action this surface exists to
 * make possible and scrolling a forty-comment thread to find it would be a joke.
 *
 * TWO PRESSES, AND THE SECOND ONE SPELLS OUT WHAT IT WILL DO. The first press
 * arms; the row becomes a sentence naming the number, the base branch and the
 * method, and offers Cancel first. Merging a public branch is not undoable from
 * here, and a single-press primary button in a panel you are dragging tabs around
 * in is a mis-click away from doing it.
 */
function MergeFooter({
  pull,
  onMerged,
  onReread,
  projectId,
}: {
  pull: GitHubPullDetail;
  onMerged: (merged: GitHubPullDetail) => void;
  onReread: () => void;
  projectId: string;
}) {
  const readiness = useMemo(() => mergeReadiness(pull), [pull]);
  /** The repository's own list, in GitHub's order, so the default button is the
   *  one GitHub's own default would be. All three when the setting is unknown. */
  const methods = pull.mergeMethods.length > 0 ? pull.mergeMethods : (["merge", "squash", "rebase"] as GitHubMergeMethod[]);
  const [chosen, setChosen] = useState<GitHubMergeMethod>();
  const method = chosen && methods.includes(chosen) ? chosen : methods[0];
  const [armed, setArmed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [problem, setProblem] = useState<{ refusal: GitHubMergeRefusal; message?: string }>();

  // A closed or merged pull request has no action, and the badge in the header
  // already says which. A disabled button under it would be explaining something
  // nobody asked about.
  if (pull.state.toUpperCase() !== "OPEN") return null;

  if (!pull.headRefOid) {
    return (
      <div className="shrink-0 border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
        gh did not report this branch&apos;s head commit, so there is nothing to pin a merge to. Merging without that check is not offered.
      </div>
    );
  }

  const merge = async () => {
    if (!method) return;
    setMerging(true);
    setProblem(undefined);
    try {
      const result = await api.mergeProjectPull(projectId, pull.number, { method, expectedHeadOid: pull.headRefOid! });
      if (result.merged) {
        setArmed(false);
        onMerged(result.pull);
        return;
      }
      setProblem({ refusal: result.refusal, ...(result.message ? { message: result.message } : {}) });
    } catch (cause) {
      setProblem({ refusal: "failed", message: cause instanceof VNextApiError ? cause.message : "The merge could not be sent." });
    } finally {
      setMerging(false);
      setArmed(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-border px-3 py-2">
      {/* WHY IT WOULD NOT WORK, above the button rather than after pressing it.
          Every state here is one GitHub would also refuse; saying it in front of
          the reader turns a round trip and a red banner into a sentence. */}
      {problem ? (
        <div className="flex items-start gap-2 text-[11px] leading-snug">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            {MERGE_REFUSAL[problem.refusal]}
            {problem.message && <span className="block text-muted-foreground">{problem.message}</span>}
            {/* The same remedy the file editor offers for the same class of
                problem: what you read is out of date, so read it again. */}
            {problem.refusal === "head_moved" && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="mt-1.5"
                onClick={() => {
                  setProblem(undefined);
                  onReread();
                }}
              >
                Re-read this pull request
              </Button>
            )}
            {problem.refusal !== "head_moved" && (
              <Button type="button" size="xs" variant="ghost" className="mt-1.5" onClick={() => setProblem(undefined)}>
                Dismiss
              </Button>
            )}
          </span>
        </div>
      ) : armed ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-snug">
            {METHOD_LABEL[method!]} <span className="font-mono">#{pull.number}</span> into{" "}
            <span className="font-mono">{pull.baseRefName ?? "its base branch"}</span>?{" "}
            <span className="text-muted-foreground">This happens on GitHub and cannot be undone from Telar.</span>
          </p>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setArmed(false)} disabled={merging}>
              Cancel
            </Button>
            <Button type="button" size="xs" onClick={() => void merge()} disabled={merging}>
              {merging ? <Spinner className="size-3" /> : <GitMergeIcon className="size-3" />}
              {merging ? "Merging…" : "Merge"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {readiness.note && (
            <p className={cn("text-[11px] leading-snug", readiness.canMerge ? "text-muted-foreground" : "text-warning")}>{readiness.note}</p>
          )}
          {methods.length === 0 ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              This repository has every merge method turned off, so nothing here can merge it.
            </p>
          ) : (
            <div className="flex items-center gap-1">
              <Button type="button" size="xs" disabled={!readiness.canMerge} onClick={() => setArmed(true)} className="min-w-0">
                <GitMergeIcon className="size-3" />
                <span className="truncate">{METHOD_LABEL[method!]}</span>
              </Button>
              {/* The method picker only offers what the repository allows, so
                  `method_not_allowed` is a refusal this surface cannot cause. */}
              {methods.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Choose how to merge"
                        title="Choose how to merge"
                        disabled={!readiness.canMerge}
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                      />
                    }
                  >
                    <span aria-hidden className="text-[10px]">
                      ▾
                    </span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-52">
                    {methods.map((candidate) => (
                      <DropdownMenuItem key={candidate} onClick={() => setChosen(candidate)}>
                        {candidate === method && <CheckIcon />}
                        <span className="truncate">{METHOD_LABEL[candidate]}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** `+40 −3 across 2 files`, in the register the diff surface uses. */
function DiffStat({ pull }: { pull: GitHubPullDetail }) {
  return (
    <span className="font-mono tabular-nums">
      <span className="text-success">+{pull.additions.toLocaleString("en-US")}</span>{" "}
      <span className="text-destructive">−{pull.deletions.toLocaleString("en-US")}</span>{" "}
      <span className="text-muted-foreground">
        across {pull.changedFiles.toLocaleString("en-US")} {pull.changedFiles === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

export function ForgeDetailSurface({
  kind,
  number,
  projectId,
  /** The session's own branch, so its pull request can say it is this one's. */
  branch,
}: {
  kind: "issue" | "pull";
  number: number;
  projectId?: string;
  branch?: string;
}) {
  const [issue, setIssue] = useState<GitHubIssueDetail>();
  const [pull, setPull] = useState<GitHubPullDetail>();
  const [absent, setAbsent] = useState<{ unavailable: keyof typeof UNAVAILABLE; message?: string }>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (force = false) => {
      if (!projectId) return;
      try {
        const read =
          kind === "issue"
            ? await api.projectIssue(projectId, number, force ? { refresh: true } : {})
            : await api.projectPull(projectId, number, force ? { refresh: true } : {});
        if ("issue" in read) {
          setIssue(read.issue);
          setAbsent(undefined);
        } else if ("pull" in read) {
          setPull(read.pull);
          setAbsent(undefined);
        } else {
          setAbsent({ unavailable: read.unavailable, ...(read.message ? { message: read.message } : {}) });
        }
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof VNextApiError ? cause.message : "The engine did not answer.");
      }
    },
    [projectId, kind, number],
  );

  useEffect(() => {
    // Deferred like every other read in this panel: a synchronous
    // fetch-and-setState on mount is a cascading render.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load(true).finally(() => setRefreshing(false));
  };

  const Icon = kind === "issue" ? CircleDotIcon : GitPullRequestIcon;

  if (!projectId) {
    return (
      <PanelEmpty icon={<Icon />} title="No project">
        Issues and pull requests belong to a repository, and there is not one to name yet.
      </PanelEmpty>
    );
  }
  if (error) {
    return (
      <PanelEmpty icon={<Icon />} title="Could not read GitHub">
        {error}
      </PanelEmpty>
    );
  }
  if (absent) {
    const reason = UNAVAILABLE[absent.unavailable];
    return (
      <PanelEmpty icon={<Icon />} title={reason.title}>
        {reason.detail || absent.message || "gh exited without an explanation."}
      </PanelEmpty>
    );
  }

  const thing = kind === "issue" ? issue : pull;
  if (!thing) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground">
        <Spinner className="size-3" /> asking gh about #{number}…
      </p>
    );
  }

  const mine = kind === "pull" && Boolean(branch) && pull?.headRefName === branch;
  const status = issue ? issueStatus(issue) : pullStatus(pull!);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ForgeHeader
        icon={<Icon className="size-3.5" />}
        number={thing.number}
        title={thing.title}
        url={thing.url}
        state={{ words: STATUS_LABEL[status], tone: STATUS_TONE[status] }}
        onRefresh={refresh}
        refreshing={refreshing}
        onDrag={(transfer) =>
          startReferenceDrag(transfer, kind === "issue" ? issueReference(thing) : pullReference(thing))
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1 px-3 py-2.5">
          <MetaRow icon={<UserIcon />}>
            <span className="font-medium text-foreground">{thing.author ?? "someone"}</span> opened this{" "}
            <span title={when(kind === "issue" ? issue!.createdAt : pull!.createdAt)}>{fmtAgo(kind === "issue" ? issue!.createdAt : pull!.createdAt)}</span>
            {thing.updatedAt > (kind === "issue" ? issue!.createdAt : pull!.createdAt) && (
              <span className="text-muted-foreground"> · updated {fmtAgo(thing.updatedAt)}</span>
            )}
          </MetaRow>
          {pull && (
            <MetaRow icon={<GitPullRequestIcon />}>
              <span className="font-mono">{pull.headRefName ?? "?"}</span> → <span className="font-mono">{pull.baseRefName ?? "?"}</span>
              {/* The one badge worth the width on a session's panel: this pull
                  request is FOR THE BRANCH THIS SESSION IS ON. */}
              {mine && (
                <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[9px] font-normal">
                  this session
                </Badge>
              )}
            </MetaRow>
          )}
          {pull && (
            <MetaRow icon={<MessageSquareIcon />}>
              <DiffStat pull={pull} />
            </MetaRow>
          )}
          {pull?.mergedAt && (
            <MetaRow icon={<GitMergeIcon />}>
              <span className="text-success">Merged</span>
              {pull.mergedBy ? <span className="text-foreground"> by {pull.mergedBy}</span> : null}{" "}
              <span title={when(pull.mergedAt)}>{fmtAgo(pull.mergedAt)}</span>
            </MetaRow>
          )}
          {(thing.assignees.length > 0 || thing.milestone) && (
            <MetaRow icon={<MilestoneIcon />}>
              {[
                thing.assignees.length > 0 ? `assigned to ${thing.assignees.join(", ")}` : undefined,
                thing.milestone ? `milestone ${thing.milestone}` : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </MetaRow>
          )}
          {/* THE BOARDS. Absent rather than empty when there are none, and the list
              surface is where the "no read:project scope" sentence lives — a detail
              view has no way to tell an unscoped token from an unplaced issue. */}
          {thing.projects.length > 0 && (
            <MetaRow icon={<SquareKanbanIcon />}>
              {thing.projects.map((project) => (
                <Badge key={project} variant="secondary" className="mr-1 px-1 py-0 text-[9px] font-normal">
                  {project}
                </Badge>
              ))}
            </MetaRow>
          )}
          {thing.labels.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {thing.labels.map((label) => (
                <Badge key={label.name} variant="outline" className="px-1 py-0 text-[9px] font-normal">
                  {label.name}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* THE BODY, and a sentence when there is none. A blank space where a
            description goes reads as a surface that failed to load one. */}
        <div className="border-t border-border px-3 py-2.5">
          {thing.body.trim() ? (
            <Markdown>{thing.body}</Markdown>
          ) : (
            <p className="text-[11px] text-muted-foreground">No description was written.</p>
          )}
        </div>

        {pull && <ChecksBlock checks={pull.checks} />}
        {pull && <ReviewsBlock reviews={pull.reviews} />}
        <CommentThread comments={thing.comments} older={thing.olderComments} />
      </div>

      {pull && <MergeFooter pull={pull} projectId={projectId} onMerged={setPull} onReread={refresh} />}
    </div>
  );
}
