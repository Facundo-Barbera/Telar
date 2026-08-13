"use client";

/**
 * ISSUES AND PULL REQUESTS, AS A LIST YOU CAN READ.
 *
 * WHY THESE ARE PANEL SURFACES RATHER THAN A PAGE. An issue is not something you
 * go and read; it is something you point an agent at. Putting the list beside the
 * conversation — in the same rail as the files it changed and the page it has open
 * — makes "work on this" a drag rather than a copy, a paste and a hope that the
 * number was right.
 *
 * WHAT A ROW SAYS NOW, and why each line is worth its pixels. This was `#82`, a
 * title, an author and a date, which answers none of the questions somebody
 * scanning a list is actually asking. A row carries:
 *
 *   - A STATUS GLYPH, coloured, in GitHub's own vocabulary — six states rather
 *     than two, because a merged pull request, one closed without merging, an issue
 *     completed and an issue abandoned are four different outcomes and the
 *     difference is the whole reason to look (lib/github-forge.ts).
 *   - ASSIGNEES, as logins. "Who has this" is the second question after "what is
 *     it", and a list that cannot answer it sends you to the browser.
 *   - LABELS, MILESTONE AND BOARDS, in that order, each absent when empty rather
 *     than drawn as a placeholder.
 *
 * CLOSED ROWS ARE AVAILABLE, WHICH IS THE OTHER HALF. The list used to be open-only
 * and called that a working set; that is defensible for issues and wrong for pull
 * requests, where the merged ones are the record of what shipped. Each surface has
 * its own filter and its own default — see `STATES`.
 *
 * A NETWORK READ, AND IT SAYS SO. Everything else in this panel folds records the
 * cockpit already holds; this one goes out to GitHub through the `gh` CLI and can
 * be slow, stale, rate-limited or unauthenticated. So it never polls, it carries
 * the time it was read, and each way it can be unavailable gets its own sentence.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  ListFilterIcon,
  MilestoneIcon,
  RotateCwIcon,
  SquareKanbanIcon,
  UserRoundIcon,
} from "lucide-react";
import type { GitHubIssue, GitHubIssueListState, GitHubPullListState, GitHubPullRequest, GitHubSnapshot } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { fmtAgo } from "@/lib/format";
import { issueStatus, pullStatus, STATUS_LABEL, STATUS_TONE, UNAVAILABLE, type ForgeStatus } from "@/lib/github-forge";
import { issueReference, pullReference, startReferenceDrag } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PanelEmpty, PanelRow } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createVNextApi();

/**
 * Which rows each surface can ask for, and what it asks for first.
 *
 * ISSUES DEFAULT TO OPEN AND PULL REQUESTS DEFAULT TO OPEN TOO, but for different
 * reasons: an open issue is work outstanding, and an open pull request is work
 * waiting on you. The closed ones are one click away on both, which is the change —
 * `all` on the pull requests surface is how you find what shipped last week.
 *
 * `merged` IS ONLY ON PULL REQUESTS. `gh issue list --state merged` is not a thing,
 * and offering it here would be a filter that always answers nothing.
 */
const STATES = {
  issues: [
    { id: "open", label: "Open" },
    { id: "closed", label: "Closed" },
    { id: "all", label: "All" },
  ],
  pulls: [
    { id: "open", label: "Open" },
    { id: "merged", label: "Merged" },
    { id: "closed", label: "Closed" },
    { id: "all", label: "All" },
  ],
} as const;

/**
 * The glyph per status.
 *
 * GITHUB'S OWN ICONS, because they are the ones a reader has already learnt: a
 * hollow dot is open, a tick is done, a slashed circle is not-planned, and the
 * three pull-request arrows are merge, close and draft. Inventing a set here would
 * make this panel the only place those shapes mean something different.
 */
const ISSUE_GLYPH: Record<ForgeStatus, typeof CircleDotIcon> = {
  open: CircleDotIcon,
  draft: CircleDotIcon,
  merged: CircleCheckIcon,
  closed: CircleCheckIcon,
  completed: CircleCheckIcon,
  abandoned: CircleSlashIcon,
};

const PULL_GLYPH: Record<ForgeStatus, typeof CircleDotIcon> = {
  open: GitPullRequestIcon,
  draft: GitPullRequestDraftIcon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  completed: GitMergeIcon,
  abandoned: GitPullRequestClosedIcon,
};

const TONE_TEXT: Record<ReturnType<typeof statusTone>, string> = {
  active: "text-primary",
  done: "text-success",
  info: "text-info",
  none: "text-muted-foreground",
};

function statusTone(status: ForgeStatus) {
  return STATUS_TONE[status];
}

/**
 * One row: three gestures, three targets.
 *
 * CLICKING OPENS IT IN THE PANEL — the row is a button, exactly as a row in the
 * file tree is. DRAGGING references it in the message. The link icon goes to
 * GitHub. The three mean different things ("read this here", "talk about this
 * here", "take me to the website") and each has its own pixel, because a row that
 * did two of them from the same one would make one of them an accident.
 *
 * A `<button>` THAT IS ALSO `draggable` is the same arrangement the file tree
 * uses, and it works because a drag never fires the click.
 */
function ForgeRow({
  glyph: Glyph,
  status,
  number,
  title,
  url,
  when,
  author,
  assignees,
  labels,
  milestone,
  projects,
  extra,
  open,
  onOpen,
  onDrag,
}: {
  glyph: typeof CircleDotIcon;
  status: ForgeStatus;
  number: number;
  title: string;
  url: string;
  when: number;
  author?: string;
  assignees: readonly string[];
  labels: readonly { name: string; color?: string }[];
  milestone?: string;
  projects: readonly string[];
  /** Row-specific badges — a pull request's review decision, its branch. */
  extra?: React.ReactNode;
  /** Already open as a tab. Marked rather than prevented — clicking still brings
   *  that tab forward, which is what a person expects. */
  open?: boolean;
  onOpen: () => void;
  onDrag: (transfer: DataTransfer) => void;
}) {
  const tone = TONE_TEXT[statusTone(status)];
  return (
    <PanelRow tone="none" className="p-0 pl-0">
      <button
        type="button"
        draggable
        onDragStart={(event) => onDrag(event.dataTransfer)}
        onClick={onOpen}
        title={`#${number} — click to open it here, drag it into the message`}
        className={cn(
          "flex w-full min-w-0 cursor-grab items-start gap-2 py-2 pr-2 pl-4 text-left transition-colors hover:bg-muted/60 active:cursor-grabbing",
          open && "bg-muted/40",
        )}
      >
        {/* THE GLYPH IS THE STATUS, and it is the first thing on the row because
            it is the thing that decides whether the rest is worth reading. */}
        <Glyph className={cn("mt-0.5 size-3.5 shrink-0", tone)} aria-label={STATUS_LABEL[status]} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{number}</span>
            <span className="min-w-0 flex-1 truncate text-xs" title={title}>
              {title}
            </span>
          </span>
          {/* The facts line: status in words, then who opened it, then when. */}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
            <span className={tone}>{STATUS_LABEL[status]}</span>
            {author && <span>· {author}</span>}
            <span>· {fmtAgo(when)}</span>
            {/* WHO HAS IT. An avatar stack would be prettier and needs a network
                round trip per person; a login is the thing you would say out loud. */}
            {assignees.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-foreground" title={`Assigned to ${assignees.join(", ")}`}>
                <UserRoundIcon className="size-2.5" />
                {assignees.slice(0, 2).join(", ")}
                {assignees.length > 2 && ` +${assignees.length - 2}`}
              </span>
            )}
            {extra}
          </span>
          {/* Chips, and only when there are some. Labels first because they are
              the repository's own taxonomy; then the milestone and the boards,
              which are where the work has been placed. */}
          {(labels.length > 0 || milestone || projects.length > 0) && (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {labels.slice(0, 3).map((label) => (
                <Badge key={label.name} variant="outline" className="px-1 py-0 text-[9px] font-normal">
                  {label.name}
                </Badge>
              ))}
              {labels.length > 3 && <span className="text-[9px] text-muted-foreground">+{labels.length - 3}</span>}
              {milestone && (
                <Badge variant="outline" className="gap-0.5 px-1 py-0 text-[9px] font-normal" title={`Milestone ${milestone}`}>
                  <MilestoneIcon className="size-2.5" />
                  {milestone}
                </Badge>
              )}
              {projects.map((project) => (
                <Badge key={project} variant="secondary" className="gap-0.5 px-1 py-0 text-[9px] font-normal" title={`On the ${project} board`}>
                  <SquareKanbanIcon className="size-2.5" />
                  {project}
                </Badge>
              ))}
            </span>
          )}
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open #${number} on GitHub`}
          title="Open on GitHub"
          // Dragging a link is the browser's own gesture and would replace ours;
          // stopping the click keeps it from also opening the panel tab.
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <ExternalLinkIcon className="size-3" />
        </a>
      </button>
    </PanelRow>
  );
}

function IssueRow({ issue, open, onOpen }: { issue: GitHubIssue; open: boolean; onOpen: () => void }) {
  const status = issueStatus(issue);
  return (
    <ForgeRow
      glyph={ISSUE_GLYPH[status]}
      status={status}
      number={issue.number}
      title={issue.title}
      url={issue.url}
      when={issue.updatedAt}
      {...(issue.author ? { author: issue.author } : {})}
      assignees={issue.assignees}
      labels={issue.labels}
      {...(issue.milestone ? { milestone: issue.milestone } : {})}
      projects={issue.projects}
      open={open}
      onOpen={onOpen}
      onDrag={(transfer) => startReferenceDrag(transfer, issueReference(issue))}
    />
  );
}

function PullRow({ pull, mine, open, onOpen }: { pull: GitHubPullRequest; mine: boolean; open: boolean; onOpen: () => void }) {
  const status = pullStatus(pull);
  return (
    <ForgeRow
      glyph={PULL_GLYPH[status]}
      status={status}
      number={pull.number}
      title={pull.title}
      url={pull.url}
      when={pull.updatedAt}
      {...(pull.author ? { author: pull.author } : {})}
      assignees={pull.assignees}
      labels={pull.labels}
      {...(pull.milestone ? { milestone: pull.milestone } : {})}
      projects={pull.projects}
      open={open}
      onOpen={onOpen}
      extra={
        <>
          {/* The one badge worth the width on a session's panel: this pull
              request is FOR THE BRANCH THIS SESSION IS ON. */}
          {mine && (
            <Badge variant="secondary" className="px-1 py-0 text-[9px] font-normal">
              this session
            </Badge>
          )}
          {/* Only shown while it can still change. A merged pull request's review
              decision is history, and history does not need a badge. */}
          {status === "open" && pull.reviewDecision === "APPROVED" && (
            <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal text-success">
              approved
            </Badge>
          )}
          {status === "open" && pull.reviewDecision === "CHANGES_REQUESTED" && (
            <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal text-warning">
              changes requested
            </Badge>
          )}
        </>
      }
      onDrag={(transfer) => startReferenceDrag(transfer, pullReference(pull))}
    />
  );
}

export function GitHubSurface({
  kind,
  projectId,
  /** The session's own branch, so its pull request can be marked. */
  branch,
  /** Opening one is opening a TAB, which the panel owns — the same arrangement
   *  the file tree has with the file view. */
  onOpen,
  /** Which numbers already have a tab, so a row can say so. */
  openNumbers,
}: {
  kind: "issues" | "pulls";
  projectId?: string;
  branch?: string;
  onOpen?: (number: number) => void;
  openNumbers?: readonly number[];
}) {
  const [snapshot, setSnapshot] = useState<GitHubSnapshot>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  /**
   * WHICH ROWS THIS SURFACE ASKED FOR.
   *
   * Held per surface rather than shared: the Issues tab showing open work while
   * the Pull requests tab shows everything that ever merged is a perfectly
   * ordinary arrangement, and one filter for both would make it impossible.
   */
  const [state, setState] = useState<GitHubIssueListState | GitHubPullListState>("open");

  const load = useCallback(
    async (force = false) => {
      if (!projectId) return;
      try {
        setSnapshot(
          (
            await api.projectGitHub(projectId, {
              ...(force ? { refresh: true } : {}),
              // Only this surface's own filter travels; the other list keeps the
              // engine's default, and its own surface asks again when opened.
              ...(kind === "issues" ? { issueState: state as GitHubIssueListState } : { pullState: state as GitHubPullListState }),
            })
          ).github,
        );
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof VNextApiError ? cause.message : "The engine did not answer.");
      }
    },
    [projectId, kind, state],
  );

  useEffect(() => {
    // ONCE, ON OPEN, and again when the filter changes — which is a person asking,
    // not a timer. No interval: this is somebody else's rate limit, and a panel
    // left open on a second monitor must not spend it.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const label = kind === "issues" ? "issues" : "pull requests";
  const Icon = kind === "issues" ? CircleDotIcon : GitPullRequestIcon;
  const options = STATES[kind];
  const chosen = options.find((entry) => entry.id === state) ?? options[0];

  if (error) {
    return (
      <PanelEmpty icon={<Icon />} title="Could not read GitHub">
        {error}
      </PanelEmpty>
    );
  }
  if (!snapshot) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground">
        <Spinner className="size-3" /> asking gh…
      </p>
    );
  }
  if (snapshot.unavailable) {
    const reason = UNAVAILABLE[snapshot.unavailable];
    return (
      <PanelEmpty icon={<Icon />} title={reason.title}>
        {reason.detail || snapshot.message || "gh exited without an explanation."}
      </PanelEmpty>
    );
  }

  const rows = kind === "issues" ? snapshot.issues : snapshot.pulls;
  const alreadyOpen = new Set(openNumbers ?? []);
  /** The filter the ROWS were read under, not the one the picker is showing: a
   *  refresh in flight means those two disagree for a moment, and the count has to
   *  describe what is on screen. */
  const shown = kind === "issues" ? snapshot.issueState : snapshot.pullState;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-[11px] text-muted-foreground">
        {/* THE FILTER, first, because it is the thing that decides what the count
            beside it means. A dropdown rather than a row of pills: at 320px four
            pills and a count do not fit, and the one you chose is the only one
            worth showing. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={`Which ${label} to show`}
                title={`Which ${label} to show`}
                className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
              />
            }
          >
            <ListFilterIcon className="size-3" />
            <span>{chosen.label}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            {options.map((option) => (
              <DropdownMenuItem key={option.id} onClick={() => setState(option.id)}>
                <span className="truncate">{option.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="min-w-0 truncate">
          · {rows.length === 0 ? `no ${label}` : `${rows.length}${rows.length === GITHUB_PAGE_HINT ? "+" : ""} ${rows.length === 1 ? label.replace(/s$/, "") : label}`}
          {snapshot.repository ? ` in ${snapshot.repository}` : ""}
        </span>
        {/* A network read is not live, and a surface that cannot say how old its
            answer is invites the reader to trust a stale one. */}
        <span className="ml-auto shrink-0">{fmtAgo(snapshot.readAt)}</span>
        <button
          type="button"
          aria-label={`Refresh ${label}`}
          title="Ask gh again"
          onClick={() => {
            setRefreshing(true);
            void load(true).finally(() => setRefreshing(false));
          }}
          className="shrink-0 rounded p-0.5 transition-colors hover:text-foreground"
        >
          <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[11px] leading-snug text-muted-foreground">
          {shown === "open"
            ? `Nothing open. Closed ${label} are one click away in the filter above.`
            : `No ${label} match that filter in this repository.`}
        </p>
      ) : (
        <>
          <div className="flex flex-col group">
            {kind === "issues"
              ? snapshot.issues.map((issue) => (
                  <IssueRow key={issue.number} issue={issue} open={alreadyOpen.has(issue.number)} onOpen={() => onOpen?.(issue.number)} />
                ))
              : snapshot.pulls.map((pull) => (
                  <PullRow
                    key={pull.number}
                    pull={pull}
                    mine={Boolean(branch) && pull.headRefName === branch}
                    open={alreadyOpen.has(pull.number)}
                    onOpen={() => onOpen?.(pull.number)}
                  />
                ))}
          </div>
          {/* WHY THE BOARD CHIPS ARE MISSING, said once at the bottom and only when
              it is true. Silence would make every row look like it is on no board. */}
          {snapshot.projectsUnavailable === "scope" && (
            <p className="border-t border-border px-4 py-2 text-[11px] leading-snug text-muted-foreground">
              Boards are not shown: the gh token has no <span className="font-mono">read:project</span> scope. Run{" "}
              <span className="font-mono">gh auth refresh -s read:project</span> and press refresh.
            </p>
          )}
          {snapshot.projectsUnavailable === "failed" && (
            <p className="border-t border-border px-4 py-2 text-[11px] leading-snug text-muted-foreground">
              Boards could not be read this time. Everything else on these rows is current.
            </p>
          )}
          <p className="px-4 py-2 text-[11px] leading-snug text-muted-foreground">
            Click a row to read it here — body, conversation{kind === "pulls" ? ", checks, reviews and the merge" : " and status"}. Drag one into
            the message to reference it instead; what lands in the box is exactly what the agent gets.
          </p>
        </>
      )}
    </div>
  );
}

/** The engine's page size. A list exactly this long is probably truncated, and the
 *  `+` says so rather than claiming the repository has exactly fifty. */
const GITHUB_PAGE_HINT = 50;
