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
 *
 * THREE OF THE PIECES BELOW ARE EXPORTED and nothing else imports them. They are the
 * three the §1b layout decisions live in — who is attributed where, what the chips
 * line says when it is empty, whether the merge control has a floor and a sentence —
 * and every one of those is a claim about rendered markup that cannot be checked by
 * reading `ForgeDetailSurface`, which does nothing but fetch before it draws them.
 * `github-detail-surface.test.tsx` renders them directly; see the fifth paragraph of
 * `EntryCard` for the regression that motivated it.
 */

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ClockIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GripVerticalIcon,
  MilestoneIcon,
  RotateCwIcon,
  SquareKanbanIcon,
  TriangleAlertIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import type {
  GitHubCheck,
  GitHubIssueDetail,
  GitHubLink,
  GitHubMergeMethod,
  GitHubMergeRefusal,
  GitHubPullDetail,
} from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { fmtAgo } from "@/lib/format";
import {
  buildForgeTimeline,
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
  type ForgeEntry,
} from "@/lib/github-forge";
import { checkReference, failingChecksReference, issueReference, pullReference, startReferenceDrag } from "@/lib/drag-reference";
import { GitHubAvatar } from "@/components/session/github-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MessageResponse } from "@/components/ui/message";
import { PanelDivider, PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createEngineApi();

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
          <span className="shrink-0 font-mono text-3xs text-muted-foreground">#{number}</span>
          <span className="min-w-0 flex-1 text-xs font-medium" title={title}>
            {title}
          </span>
        </span>
        <Badge variant="outline" className={cn("mt-1 px-1 py-0 text-4xs font-normal", TONE_CLASS[state.tone])}>
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
  "[&_h1]:text-sm [&_h1]:mt-3 [&_h2]:text-xs-plus [&_h2]:mt-3 [&_h3]:text-xs [&_h4]:text-xs [&_h5]:text-xs [&_h6]:text-xs [&_pre]:text-3xs [&_code]:text-3xs";

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
 *
 * THE COLUMN IS CAPPED, which is the one thing the panel was not doing. github.com
 * caps its issue body and so does every other surface anybody reads prose in; the
 * measure is the oldest rule in typesetting and the reason is that a line long
 * enough loses the reader on the way back to the start of the next one. This
 * repository's issues are long prose, and the panel is draggable to half the
 * screen — the width where it stops reading is a width somebody will choose. At
 * 320px the cap never binds and nothing changes.
 *
 * THE CAP IS ON THE CARD, NOT ON THE PROSE INSIDE IT. It started on the prose,
 * and at half-screen that drew a full-width card with its text stopped at 64ch
 * and a blank right third inside the border — a column that read as a layout
 * bug rather than as a measure. The card carries the cap and centres itself, so
 * the border is the measure's edge and the space beside it is margin, which is
 * what a capped column looks like everywhere else prose is read.
 */
const READING_MEASURE = "max-w-[64ch]";

function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <MessageResponse className={cn("text-xs", PANEL_MARKDOWN, className)} components={PANEL_IMAGE}>
      {children}
    </MessageResponse>
  );
}

/** A review's verdict, in the five-colour vocabulary. Only these three are worth a
 *  colour; `COMMENTED` and `PENDING` are not verdicts. */
const REVIEW_TONE: Record<string, string> = {
  APPROVED: "text-success",
  CHANGES_REQUESTED: "text-destructive",
  DISMISSED: "text-muted-foreground",
};

/**
 * ONE ENTRY IN THE CONVERSATION, AS A CARD.
 *
 * THE CARD IS THE WHOLE FIX. This surface used to render the body and every comment
 * edge to edge with a hairline label between them, and a thread of four became one
 * wall of prose in a 320px column — nothing said where one person stopped and the
 * next began, and the body did not read as something anybody had written. A bordered
 * box with an author bar is the device GitHub uses for exactly this reason, and it
 * costs one border.
 *
 * THE AUTHOR BAR IS TINTED AND THE BODY IS NOT, so the eye can find the boundaries
 * by scanning one column of grey rather than reading.
 *
 * WHO AND WHEN ARE ONE FACT, SO THEY ARE PRINTED TOGETHER. The time used to be
 * pushed to the far right of the bar, on the reasoning that a ragged left edge of
 * names scans well and a ragged right edge of dates does not. True, and beside the
 * point: widen the panel and the name ends up most of the surface away from the
 * timestamp that belongs to it, so answering "who said this, and when" costs a
 * full-width eye movement on every card in the thread. The link out takes the far
 * right instead — a column of identical glyphs is exactly what a ragged right edge
 * is good for.
 *
 * THE OPENING POST HAS NO AUTHOR BAR. The facts line above the thread already says
 * who opened this and when; repeating it on the first card made the opening post
 * read as a reply to itself, posted by its own author in the same second.
 *
 * A COMMENT GITHUB HID STAYS HIDDEN, behind its reason and a click. Rendering a
 * spam-hidden comment in full beside the real ones shows a reader something the
 * repository decided to hide — and GitHub itself collapses these.
 *
 * AND THE CARD PAINTS — `bg-card`, issue #691. It wore a border, an author bar on
 * the replies, and no fill of its own, which only ever worked because the panel
 * behind it was opaque: turn translucency on, the panel thins to --sidebar-wash,
 * and this becomes a 1px hairline drawn over the desktop with a paragraph inside
 * it. A comment body is read word by word, which makes it a READING SURFACE, and
 * a reading surface never thins at any slider setting. The fill also repairs the
 * author bar in light mode, where `bg-muted/40` over --sidebar was 0.952 over
 * 0.955 — a boundary marker nobody could see. On --card it finally is one.
 */
export function EntryCard({ entry }: { entry: ForgeEntry }) {
  const [revealed, setRevealed] = useState(false);
  const hidden = entry.minimized === true && !revealed;
  const verdict = entry.state ? (REVIEW_TONE[entry.state.toUpperCase()] ?? "text-muted-foreground") : undefined;

  return (
    <div className={cn("w-full min-w-0 self-center overflow-hidden rounded-md border border-border bg-card", READING_MEASURE)}>
      {entry.kind !== "body" && (
        /* `items-center` RATHER THAN `items-baseline` NOW THERE IS A FACE IN IT
           (#790): a circle has no baseline, so on the baseline it sat a pixel low
           against the name and the badge beside it. Everything on this bar is one
           line of the same size, so centring changes nothing else. */
        <div className="flex min-w-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1 text-3xs text-muted-foreground">
          {/* THE FACE, THEN THE NAME. This is the bar the avatar exists for — see
              `GitHubAvatar` on why a column of identical logins is the case where
              one earns its pixels. */}
          <GitHubAvatar {...(entry.author ? { login: entry.author } : {})} {...(entry.avatar ? { src: entry.avatar } : {})} className="size-4" />
          <span className="min-w-0 truncate font-medium text-foreground">{entry.author ?? "someone"}</span>
          {entry.association && (
            <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal">
              {entry.association.toLowerCase()}
            </Badge>
          )}
          {/* WHAT THIS ENTRY IS, in the fewest words that distinguish it: a review
              with a verdict, or a plain comment. A plain comment says nothing — it
              is the default and a word for it would be noise on every card. */}
          {entry.kind === "review" && <span className={cn("shrink-0", verdict)}>{reviewLabel(entry.state ?? "")}</span>}
          <span className="shrink-0 tabular-nums" title={when(entry.at)}>
            {fmtAgo(entry.at)}
          </span>
          {/**
           * WHICH SESSION WROTE THIS — issue #791, and the one thing on this
           * surface github.com structurally cannot do.
           *
           * BESIDE THE AUTHOR, BECAUSE IT IS THE SAME FACT. Every agent comment
           * in this repository says `Facundo-Barbera`, which is true and tells a
           * reader nothing: the author is the account, and this is the
           * conversation. Printed together for the reason the timestamp is — who
           * said this, and when, and out of which thread is one question.
           *
           * A LINK, NOT A BADGE. The marker is a claim the body makes, not a
           * signature (see `GitHubComment.attribution`), and the honest way to
           * draw a claim is as somewhere to go and check: the session it names
           * is one click away, with the reasoning that produced the comment in
           * it. A badge would assert authorship this cannot prove.
           */}
          {entry.sessionId && (
            <a
              href={`/sessions/${encodeURIComponent(entry.sessionId)}`}
              title={`Open the session this comment says it came from — ${entry.sessionId}`}
              className="min-w-0 shrink truncate font-mono text-4xs underline-offset-2 hover:text-foreground hover:underline"
            >
              {entry.sessionId}
            </a>
          )}
          {entry.url && (
            <a
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open this comment on GitHub"
              className="ml-auto shrink-0 rounded p-0.5 transition-colors hover:text-foreground"
            >
              <ExternalLinkIcon className="size-2.5" />
            </a>
          )}
        </div>
      )}
      <div className="min-w-0 px-2 py-1.5">
        {hidden ? (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="w-full rounded border border-dashed border-border px-2 py-1 text-left text-3xs leading-snug text-muted-foreground transition-colors hover:text-foreground"
          >
            Hidden by the repository{entry.minimizedReason ? ` as ${entry.minimizedReason.toLowerCase().replaceAll("_", " ")}` : ""} — show anyway
          </button>
        ) : entry.body.trim() ? (
          <Markdown>{entry.body}</Markdown>
        ) : (
          /* A bare approval has no body, and that is not a missing one. */
          <p className="text-2xs text-muted-foreground">{entry.kind === "review" ? "No comment left with this review." : "No description was written."}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The conversation, in the order it happened.
 *
 * ONE LIST RATHER THAN THREE SECTIONS. The body, the reviews and the comments used
 * to be three lists in that order, which is not how any of it occurred: a review
 * answering a comment appeared above the thing it answered, in a different section.
 * See `buildForgeTimeline` for what is merged and what is dropped.
 */
function Timeline({ entries, older }: { entries: readonly ForgeEntry[]; older: number }) {
  const said = entries.filter((entry) => entry.kind !== "body").length;
  return (
    <>
      <PanelDivider label={said === 0 ? "no replies" : `${said + older} ${said + older === 1 ? "reply" : "replies"}`} />
      {/* NEVER SILENT ABOUT THE CUT. A surface that dropped half a conversation
          without saying so has lied about the conversation. */}
      {older > 0 && (
        <p className="px-3 pb-2 text-3xs leading-snug text-muted-foreground">
          The {older} oldest {older === 1 ? "comment is" : "comments are"} not shown — open it on GitHub for the whole thread.
        </p>
      )}
      <div className="flex flex-col gap-2 px-3 pb-3">
        {entries
          .filter((entry) => entry.kind !== "body")
          .map((entry) => (
            <EntryCard key={entry.id} entry={entry} />
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

/** Whether a check is one somebody needs to look at — failing, or not finished. */
function isNotable(check: GitHubCheck): boolean {
  const conclusion = check.conclusion?.toUpperCase();
  if (check.status.toUpperCase() !== "COMPLETED" || !conclusion) return true;
  return conclusion !== "SUCCESS" && conclusion !== "SKIPPED" && conclusion !== "NEUTRAL" && conclusion !== "CANCELLED";
}

/** Whether it actually failed, as opposed to being skipped or still going — which
 *  is what decides whether there is a failing log to fetch. */
function hasFailed(check: GitHubCheck): boolean {
  return check.status.toUpperCase() === "COMPLETED" && FAILED_CONCLUSIONS.has(check.conclusion?.toUpperCase() ?? "");
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

/**
 * ONE CHECK, DRAGGABLE, AND OPENABLE WHEN IT FAILED.
 *
 * DRAGGING A CHECK IS THE POINT OF THIS BLOCK. Everything else here is reading;
 * this is the one row you want to hand to an agent, and a URL alone would not do it
 * — GitHub Actions logs need an authenticated call the agent cannot make. So opening
 * a failing check fetches the tail of its log, and from then on the drag carries the
 * error rather than a link to it (lib/drag-reference.ts).
 *
 * A GREEN CHECK IS STILL DRAGGABLE, because "why did this pass when it should not
 * have" is a real question, and it costs nothing to allow.
 */
function CheckRow({
  check,
  projectId,
  log,
  onLog,
}: {
  check: GitHubCheck;
  projectId: string;
  log: CheckLogState | undefined;
  onLog: (jobId: string, state: CheckLogState) => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = hasFailed(check);
  const canOpen = failed && Boolean(check.jobId);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Fetched once, on first open. A finished job's log never changes, so there is
    // nothing to re-ask; a second open reads what is already here.
    if (!next || !check.jobId || log) return;
    onLog(check.jobId, { loading: true });
    void api
      .projectCheckLog(projectId, check.jobId)
      .then((read) => onLog(check.jobId!, "unavailable" in read.log ? { unavailable: read.log.unavailable } : { ...read.log }))
      .catch((cause) => onLog(check.jobId!, { unavailable: cause instanceof EngineApiError ? cause.message : "The log could not be read." }));
  };

  return (
    <div className="min-w-0">
      <div
        draggable
        onDragStart={(event) =>
          startReferenceDrag(
            event.dataTransfer,
            checkReference({
              ...check,
              ...(log && "lines" in log ? { log: log.lines, logTruncated: log.truncated } : {}),
            }),
          )
        }
        title={`${check.workflow ? `${check.workflow} · ` : ""}${check.name} — drag into the message to reference it`}
        className="flex min-w-0 cursor-grab items-center gap-1.5 text-2xs active:cursor-grabbing"
      >
        <CheckGlyph check={check} />
        {/* THE NAME IS THE DISCLOSURE when there is a log, and inert when there is
            not — rather than a chevron that does nothing on twenty green rows. */}
        {canOpen ? (
          <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground">
            <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
            <span className="min-w-0 truncate">{check.name}</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate">{check.name}</span>
        )}
        {check.workflow && check.workflow !== check.name && (
          <span className="max-w-24 shrink-0 truncate text-3xs text-muted-foreground">{check.workflow}</span>
        )}
        {check.url && (
          <a
            href={check.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${check.name} on GitHub`}
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3" />
          </a>
        )}
      </div>
      {open && (
        <div className="mt-1 mb-2 ml-4">
          {log?.loading ? (
            <p className="flex items-center gap-2 text-3xs text-muted-foreground">
              <Spinner className="size-3" /> reading the failing step…
            </p>
          ) : log?.unavailable !== undefined ? (
            <p className="text-3xs leading-snug text-muted-foreground">{log.unavailable}</p>
          ) : log?.lines ? (
            <>
              {/* MONOSPACE, SCROLLED, AND CAPPED IN HEIGHT. A log is the one thing on
                  this surface that can be thousands of lines, and it must not push the
                  conversation off the screen.
                  `bg-card` RATHER THAN `bg-muted/40` (#691): a failing step's log is
                  read line by line, so it paints. At 40% it was borrowing the panel's
                  fill, and under translucency there is no panel fill to borrow. */}
              <pre className="max-h-64 overflow-auto rounded border border-border bg-card p-1.5 font-mono text-3xs leading-snug whitespace-pre-wrap">
                {log.lines.join("\n")}
              </pre>
              {log.truncated && (
                <p className="mt-0.5 text-3xs text-muted-foreground">
                  The last {log.lines.length} lines.
                </p>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * What we know about one job's log: nothing, in flight, the lines, or why not.
 *
 * `loading` IS ON EVERY MEMBER rather than only on the in-flight one, so a render can
 * ask "is this still fetching" without first narrowing the union — the arrangement
 * that made the previous version of this a type error at the one place it mattered.
 */
type CheckLogState =
  | { loading: true; lines?: undefined; truncated?: undefined; unavailable?: undefined }
  | { loading?: false; unavailable: string; lines?: undefined; truncated?: undefined }
  | { loading?: false; lines: string[]; truncated: boolean; unavailable?: undefined };

/**
 * The head commit's checks.
 *
 * FAILING AND UNFINISHED ONES ARE OPEN; the green ones are behind a disclosure.
 * Twenty-five green rows in a 320px column is a wall that hides the one red row in
 * it — but "show me everything that ran" is a real question too, and answering it
 * with a count alone was the previous version's mistake.
 *
 * THE WHOLE BLOCK IS DRAGGABLE WHEN SOMETHING IS RED, which is the gesture this
 * exists for: "CI is broken, fix it" is one sentence and one drag rather than five.
 */
function ChecksBlock({ checks, projectId }: { checks: readonly GitHubCheck[]; projectId: string }) {
  const summary = useMemo(() => checkSummary(checks), [checks]);
  const notable = checks.filter(isNotable);
  const quiet = checks.filter((check) => !isNotable(check));
  const failing = checks.filter(hasFailed);
  const [showAll, setShowAll] = useState(false);
  /** Keyed by job id rather than held per row, so it survives the disclosure
   *  collapsing and the drag can read a log the row is no longer showing. */
  const [logs, setLogs] = useState<Record<string, CheckLogState>>({});
  const noteLog = (jobId: string, state: CheckLogState) => setLogs((current) => ({ ...current, [jobId]: state }));

  /** What the drag sends: every failing check, each with its log if it has been
   *  opened. Better the more you looked at, never worse than a list of names. */
  const failingWithLogs = failing.map((check) => {
    const log = check.jobId ? logs[check.jobId] : undefined;
    return { ...check, ...(log && "lines" in log ? { log: log.lines, logTruncated: log.truncated } : {}) };
  });

  return (
    <>
      <PanelDivider label="checks" />
      {summary.total === 0 ? (
        /* NOT "all clear". No checks ran is a different fact from every check
           passing, and a green tick here would invent a CI this repository does
           not have. */
        <p className="px-3 pb-3 text-2xs text-muted-foreground">No checks ran on this commit.</p>
      ) : (
        <div className="flex flex-col gap-1 px-3 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <p className={cn("min-w-0 flex-1 truncate text-2xs", summary.failed > 0 ? "text-destructive" : "text-muted-foreground")}>
              {checkHeadline(summary)}
            </p>
            {/* ONE DRAG FOR ALL OF THEM. Only offered when something is actually
                red — a button to reference nothing is a button that teaches you to
                ignore this row. */}
            {failing.length > 0 && (
              <span
                draggable
                onDragStart={(event) => startReferenceDrag(event.dataTransfer, failingChecksReference(failingWithLogs))}
                title={`Drag ${failing.length === 1 ? "this failure" : `all ${failing.length} failures`} into the message`}
                className="inline-flex shrink-0 cursor-grab items-center gap-1 rounded border border-destructive/40 px-1 py-0 text-4xs text-destructive active:cursor-grabbing"
              >
                <GripVerticalIcon className="size-2.5" />
                {failing.length === 1 ? "drag the failure" : `drag all ${failing.length}`}
              </span>
            )}
          </div>
          {notable.map((check, at) => (
            <CheckRow
              key={`${check.name}-${at}`}
              check={check}
              projectId={projectId}
              {...(check.jobId && logs[check.jobId] ? { log: logs[check.jobId] } : { log: undefined })}
              onLog={noteLog}
            />
          ))}
          {/* THE GREEN ONES, ON REQUEST. Absent by default because they are not the
              question; available because "did the deploy job even run" is. */}
          {quiet.length > 0 &&
            (showAll ? (
              quiet.map((check, at) => (
                <CheckRow key={`quiet-${check.name}-${at}`} check={check} projectId={projectId} log={undefined} onLog={noteLog} />
              ))
            ) : (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="self-start text-3xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                show {quiet.length} that {quiet.length === 1 ? "passed or was skipped" : "passed or were skipped"}
              </button>
            ))}
        </div>
      )}
    </>
  );
}

/**
 * THE MERGE REGION'S HOME.
 *
 * A NAMED FLOOR RATHER THAN A FLOATING BUTTON. The merge shipped as a green pill
 * in the bottom-left corner, over whatever the scroller happened to end on, with
 * no label and — in the one state you actually press it in — no sentence beside
 * it. It read as an accident: the most careful logic in this surface, presented as
 * something that had come loose. A border, a fill and a mono label cost four
 * classes and make it a region of the surface, which is what it is.
 *
 * IT NAMES THE BASE BRANCH IN THE LABEL, so the region says what it does before
 * anybody reads the button in it — the answer to the finding filed with §1b, that
 * the one outward-facing write in this cockpit is also the one nothing announces.
 */
function MergeHome({ base, children }: { base?: string; children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-t border-border bg-card px-3 py-2">
      <p className="mb-1.5 truncate font-mono text-4xs tracking-[0.08em] text-muted-foreground uppercase">
        merge into {base ?? "its base branch"}
      </p>
      {children}
    </div>
  );
}

/**
 * THE MERGE.
 *
 * A FOOTER, OUTSIDE THE SCROLLER, because it is the action this surface exists to
 * make possible and scrolling a forty-comment thread to find it would be a joke.
 * The checks sit immediately above it, at the end of the scroller, for the same
 * reason github.com puts them there: "is CI green" is a question you ask while
 * deciding to merge.
 *
 * TWO PRESSES, AND THE SECOND ONE SPELLS OUT WHAT IT WILL DO. The first press
 * arms; the row becomes a sentence naming the number, the base branch and the
 * method, and offers Cancel first. Merging a public branch is not undoable from
 * here, and a single-press primary button in a panel you are dragging tabs around
 * in is a mis-click away from doing it.
 */
export function MergeFooter({
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
      <MergeHome {...(pull.baseRefName ? { base: pull.baseRefName } : {})}>
        <p className="text-2xs leading-snug text-muted-foreground">
          gh did not report this branch&apos;s head commit, so merging is not offered.
        </p>
      </MergeHome>
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
      setProblem({ refusal: "failed", message: cause instanceof EngineApiError ? cause.message : "The merge could not be sent." });
    } finally {
      setMerging(false);
      setArmed(false);
    }
  };

  return (
    <MergeHome {...(pull.baseRefName ? { base: pull.baseRefName } : {})}>
      {/* WHY IT WOULD NOT WORK, above the button rather than after pressing it.
          Every state here is one GitHub would also refuse; saying it in front of
          the reader turns a round trip and a red banner into a sentence. */}
      {problem ? (
        <div className="flex items-start gap-2 text-2xs leading-snug">
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
          <p className="text-2xs leading-snug">
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
          {/* THE MERGEABILITY LINE, AGAINST THE BUTTON IT DESCRIBES. `mergeReadiness`
              now answers for the clean case too, so this is present in every state an
              open pull request can be in — the button never stands on its own. Stacked
              rather than beside it because a 320px column has room for one of them per
              line, and the sentence is the half you read first. */}
          {readiness.note && (
            <p className={cn("text-2xs leading-snug", readiness.canMerge ? "text-muted-foreground" : "text-warning")}>{readiness.note}</p>
          )}
          {methods.length === 0 ? (
            <p className="text-2xs leading-snug text-muted-foreground">
              This repository has every merge method turned off.
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
                    <span aria-hidden className="text-3xs">
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
    </MergeHome>
  );
}

/**
 * THE FACTS, IN THE SAME GRAMMAR AS A LIST ROW.
 *
 * This was four stacked icon rows in four shades of grey, each a sentence, which is
 * why the top of the panel read as a blob. The list row's shape — one line of facts,
 * then one line of chips — is the shape that works at this width, and using it twice
 * means clicking a row does not change the language it was described in.
 *
 * THE FIRST LINE IS THE THREAD'S ONE ATTRIBUTION. Who opened this and when, with the
 * "when" against the "who" rather than a column away, and it is the only place either
 * is printed: the opening post below carries no author bar because this line is it.
 */
export function ForgeFacts({
  thing,
  pull,
  mine,
  onOpenLinked,
}: {
  thing: GitHubIssueDetail | GitHubPullDetail;
  pull?: GitHubPullDetail;
  mine?: boolean;
  /**
   * Open the other end of the issue↔PR link, here in the panel (#790). Absent
   * leaves every link a plain link out — which is what a caller with no panel to
   * jump in should get, and what a cross-repository reference gets regardless.
   */
  onOpenLinked?: (link: GitHubLink) => void;
}) {
  const openedAt = thing.createdAt;
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
        {/* The thread's one attribution gets the face too, so the opening post is
            marked the same way every reply below it is. */}
        <GitHubAvatar
          {...(thing.author ? { login: thing.author } : {})}
          {...(thing.authorAvatar ? { src: thing.authorAvatar } : {})}
          className="size-4"
        />
        <span className="font-medium text-foreground">{thing.author ?? "someone"}</span>
        <span title={when(openedAt)}>opened this {fmtAgo(openedAt)}</span>
        {thing.updatedAt > openedAt && <span>· updated {fmtAgo(thing.updatedAt)}</span>}
        {thing.assignees.length > 0 && (
          <span className="inline-flex items-center gap-0.5 text-foreground" title={`Assigned to ${thing.assignees.join(", ")}`}>
            <UserIcon className="size-2.5" />
            {thing.assignees.join(", ")}
          </span>
        )}
      </p>

      {/* THE BRANCH PAIR AND THE DIFFSTAT ON ONE LINE. Two facts about the same
          thing — what this changes and where it goes — and separating them cost
          a whole row each for six words. */}
      {pull && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-3xs text-muted-foreground">
          <span className="text-foreground">{pull.headRefName ?? "?"}</span>
          <span aria-hidden>→</span>
          <span className="text-foreground">{pull.baseRefName ?? "?"}</span>
          <span className="tabular-nums">
            <span className="text-success">+{pull.additions.toLocaleString("en-US")}</span>{" "}
            <span className="text-destructive">−{pull.deletions.toLocaleString("en-US")}</span>{" "}
            <span>
              in {pull.changedFiles.toLocaleString("en-US")} {pull.changedFiles === 1 ? "file" : "files"}
            </span>
          </span>
          {/* The one badge worth the width on a session's panel: this pull
              request is FOR THE BRANCH THIS SESSION IS ON. */}
          {mine && (
            <Badge variant="secondary" className="px-1 py-0 font-sans text-4xs font-normal">
              this session
            </Badge>
          )}
        </p>
      )}

      {pull?.mergedAt && (
        <p className="flex items-center gap-1 text-2xs text-success">
          <GitMergeIcon className="size-3" />
          Merged{pull.mergedBy ? ` by ${pull.mergedBy}` : ""} <span title={when(pull.mergedAt)}>{fmtAgo(pull.mergedAt)}</span>
        </p>
      )}

      {/**
       * THE OTHER END OF THE LINK — issue #790, and #49's design calls it "the
       * single most useful thing on a GitHub issue page and we do not have it".
       *
       * DIRECTLY UNDER THE ATTRIBUTION, which is where github.com puts it: beside
       * the state badge, and again in a Development sidebar. §5 of the design rules
       * out that sidebar at panel width, so it becomes one line of the facts region
       * — the same grammar the branch pair and the chips line already use.
       *
       * AND IT IS A JUMP, not a link out, whenever it can be. The evidence #790 was
       * filed on is that reading this repository meant asking "is this closed, and
       * by which PR" and answering it with `gh` by hand. A URL to github.com would
       * be a fourth way to leave the cockpit; opening #786 in the Pull requests
       * surface is the answer arriving where the question was asked.
       *
       * THROUGH THE DOOR THAT ALREADY EXISTS. `onOpenLinked` ends at the cockpit's
       * `showPanelTab("pull:786")` — the same verb a GitHub link in a message and a
       * restored layout both use, which reads the number back out and opens it
       * INSIDE the list surface (components/right-panel.tsx, `pullPanelTab`). #49 §2
       * notes this becomes a jump within ONE surface once Issues and pull requests
       * collapse together; until then it is a jump between two, and it is the
       * cockpit's existing one rather than a second route cut for this line.
       *
       * ABSENT WHEN THERE IS NO LINK, unlike the chips line below it. An unlinked
       * issue is the common case and "no linked pull request" is not a fact worth a
       * row on every issue in the repository — where the chips line earns its
       * always-drawn state because an empty chips line and a failed read look
       * identical, this cannot be mistaken for a failure: the field travels with the
       * rows, so a read that drew this header got this field too.
       */}
      {(() => {
        const links = pull ? pull.linkedIssues : (thing as GitHubIssueDetail).linkedPulls;
        if (links.length === 0) return null;
        const Glyph = pull ? CircleDotIcon : GitPullRequestIcon;
        /**
         * WHAT TO CALL IT, AND WHY THE ISSUE SIDE NEEDS TWO WORDINGS. A pull
         * request's `closingIssuesReferences` is a declaration in its own body, so
         * "closes" is true the moment it is written. An issue's
         * `closedByPullRequestsReferences` is NOT an outcome — measured against
         * cli/cli, an open issue answers a reference to a pull request that closed
         * without merging — so "closed by" would claim a merge on an open issue that
         * may never get one.
         */
        const label = pull ? "closes" : thing.state.toUpperCase() === "CLOSED" ? "closed by" : "will close with";
        return (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
            <Glyph className="size-3 shrink-0" />
            <span>{label}</span>
            {links.map((link) =>
              /**
               * A CROSS-REPOSITORY REFERENCE IS A LINK OUT AND SAYS WHOSE. The panel's
               * Pull requests surface can only open THIS repository's numbers, so a
               * jump here would land on a different #768 entirely — see
               * `GitHubLink.repository`, which is present only in that case.
               */
              link.repository || !onOpenLinked ? (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  title={link.repository ? `Open ${link.repository}#${link.number} on GitHub` : `Open #${link.number} on GitHub`}
                  className="inline-flex items-center gap-0.5 font-mono tabular-nums text-foreground underline-offset-2 hover:underline"
                >
                  {link.repository ? `${link.repository}#${link.number}` : `#${link.number}`}
                  <ExternalLinkIcon className="size-2.5" />
                </a>
              ) : (
                <button
                  key={link.url}
                  type="button"
                  onClick={() => onOpenLinked(link)}
                  title={`Open #${link.number} here`}
                  className="font-mono tabular-nums text-foreground underline-offset-2 hover:underline"
                >
                  #{link.number}
                </button>
              ),
            )}
          </p>
        );
      })()}

      {/**
       * THE CHIPS LINE, DRAWN EVEN WHEN IT IS EMPTY. Labels, then the milestone, then
       * the boards — the same order and the same shapes the list row uses.
       *
       * IT USED TO VANISH, and that is why a bare issue looked broken rather than
       * bare. An unlabelled issue and an issue whose labels failed to arrive rendered
       * identically: as nothing at all. "No labels" is a fact about the issue; an
       * absent row is a fact about the renderer, and a reader cannot tell which one
       * they are looking at. This is deliberately the whole of the fix — §5 rules out
       * the sidebar that would otherwise hold this, on the grounds that at panel width
       * it spends 250px on metadata that is usually empty.
       */}
      <div className="flex flex-wrap items-center gap-1">
        {thing.labels.length === 0 ? (
          <span className="text-3xs text-muted-foreground">No labels</span>
        ) : (
          thing.labels.map((label) => (
            <Badge key={label.name} variant="outline" className="px-1 py-0 text-4xs font-normal">
              {label.name}
            </Badge>
          ))
        )}
        {thing.milestone && (
          <Badge variant="outline" className="gap-0.5 px-1 py-0 text-4xs font-normal" title={`Milestone ${thing.milestone}`}>
            <MilestoneIcon className="size-2.5" />
            {thing.milestone}
          </Badge>
        )}
        {/* Absent rather than empty when there are none, and the LIST surface is
            where the "no read:project scope" sentence lives — a detail view has
            no way to tell an unscoped token from an unplaced issue. */}
        {thing.projects.map((project) => (
          <Badge key={project} variant="secondary" className="gap-0.5 px-1 py-0 text-4xs font-normal" title={`On the ${project} board`}>
            <SquareKanbanIcon className="size-2.5" />
            {project}
          </Badge>
        ))}
      </div>
    </div>
  );
}

export function ForgeDetailSurface({
  kind,
  number,
  projectId,
  /** The session's own branch, so its pull request can say it is this one's. */
  branch,
  /**
   * Open the OTHER kind at a number (#790) — an issue's closing pull request, or
   * the issue a pull request closes. The kind is flipped here rather than by the
   * caller: this surface is the one that knows which end of the link it is looking
   * at, and a caller that had to work it out would be a second place to get it
   * backwards.
   */
  onOpenForge,
}: {
  kind: "issue" | "pull";
  number: number;
  projectId?: string;
  branch?: string;
  onOpenForge?: (kind: "issue" | "pull", number: number) => void;
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
        setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
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
        No repository to ask about yet.
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
      <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
        <Spinner className="size-3" /> asking gh about #{number}…
      </p>
    );
  }

  const mine = kind === "pull" && Boolean(branch) && pull?.headRefName === branch;
  const status = issue ? issueStatus(issue) : pullStatus(pull!);
  const openedAt = issue ? issue.createdAt : pull!.createdAt;
  /** The body, then comments and reviews in the order they were written — see
   *  `buildForgeTimeline` for what it merges and what it drops. */
  const timeline = buildForgeTimeline({
    body: thing.body,
    ...(thing.author ? { author: thing.author } : {}),
    ...(thing.authorAvatar ? { authorAvatar: thing.authorAvatar } : {}),
    createdAt: openedAt,
    comments: thing.comments,
    ...(pull ? { reviews: pull.reviews } : {}),
  });

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
        <ForgeFacts
          thing={thing}
          {...(pull ? { pull } : {})}
          mine={mine}
          // An issue's link points at a pull request and a pull request's at an
          // issue, always — the relation has exactly two ends.
          {...(onOpenForge ? { onOpenLinked: (link: GitHubLink) => onOpenForge(kind === "issue" ? "pull" : "issue", link.number) } : {})}
        />

        {/**
         * THE BODY IS THE FIRST CARD, not a bare block above the conversation.
         *
         * It is the first thing somebody said, and drawing it as unattributed prose
         * made the whole surface read as a document with comments stapled underneath.
         * As a card it is the opening of a thread, which is what it is — and it is the
         * one card with no author bar, because the line directly above it already
         * named the author and the hour.
         */}
        <div className="flex flex-col border-t border-border px-3 py-2.5">
          <EntryCard entry={timeline[0]!} />
        </div>

        <Timeline entries={timeline} older={thing.olderComments} />

        {/**
         * CHECKS AT THE BOTTOM, AGAINST THE MERGE.
         *
         * They used to sit between the body and the replies, which put 11px of grey
         * status through the middle of a conversation — and a check is not something
         * anybody said. github.com keeps them at the foot of the thread beside the
         * merge button, and the reason is not habit: "is CI green" is a question you
         * ask while deciding whether to merge, not while reading what somebody wrote.
         * Here that also gives the merge footer a block above it to sit against
         * rather than floating over the end of the last comment.
         */}
        {pull && <ChecksBlock checks={pull.checks} projectId={projectId} />}
      </div>

      {pull && <MergeFooter pull={pull} projectId={projectId} onMerged={setPull} onReread={refresh} />}
    </div>
  );
}
