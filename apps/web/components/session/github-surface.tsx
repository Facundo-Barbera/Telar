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
 *   - AND, ON AN OPEN PULL REQUEST, THAT IT CAN BE MERGED FROM HERE (#703). The
 *     one outward-facing write this cockpit has was reachable only by somebody
 *     who already knew it existed. A row cannot say whether GitHub will take the
 *     merge — the list read carries no mergeability — so it says the control is
 *     there and the detail says the rest.
 *
 * AND AN ISSUE ROW CAN START A SESSION ON ITSELF (#695) — the one thing on this
 * surface that github.com structurally cannot do. Everything else here is an
 * attempt to be less bad than its lists at reading; this is the panel's only
 * durable advantage, which is that it knows about sessions. One press arms a
 * worktree, defaults its base and puts the issue in the composer; it does NOT
 * create anything, because in Telar the first message is what creates a session
 * and a row action that minted one on sight would litter the rail. When a
 * worktree cannot be cut, it says why and opens nothing — see `lib/issue-session.ts`.
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
 *
 * AND THE DETAILS OPEN INSIDE IT (#693). Clicking a row used to mint a top-level
 * panel tab — the strip read `Diff · Issues · #675 · Pull requests · #666`, four
 * Git tabs of which two were documents rather than surfaces. Issues arrive by the
 * dozen exactly as files do, so they get the treatment files got: a sub-strip of
 * this surface's own, with the list as its first chip. The panel's strip goes back
 * to holding surfaces, and nothing is lost — the open set persists per tab
 * instance (lib/forge-workspace.ts), so it survives a reload and two windows on
 * one session still keep an issue each.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  GitBranchPlusIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LinkIcon,
  ListFilterIcon,
  MilestoneIcon,
  RotateCwIcon,
  SquareKanbanIcon,
  TagIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import type { GitHubFacets, GitHubIssue, GitHubIssueFilter, GitHubLink, GitHubPullFilter, GitHubPullRequest, GitHubSnapshot } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { fmtAgo } from "@/lib/format";
import { filterChips, issueStatus, offersMerge, pullStatus, STATUS_LABEL, STATUS_TONE, UNAVAILABLE, type ForgeFilterChip, type ForgeStatus } from "@/lib/github-forge";
import { insertReference, issueReference, pullReference, startReferenceDrag } from "@/lib/drag-reference";
import { GitHubAvatar } from "@/components/session/github-avatar";
import { readDraft, writeDraft } from "@/lib/composer-draft";
import { issueSessionStart } from "@/lib/issue-session";
import { canvasHref } from "@/lib/session-list";
import {
  activateForge,
  closeForge,
  emptyForge,
  forgeNumbersAfter,
  openForge,
  otherForgeNumbers,
  showForgeList,
  type ForgeOpen,
} from "@/lib/forge-workspace";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PanelEmpty, PanelRow } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * THE DETAIL STAYS A CHUNK OF ITS OWN, for the same reason the panel splits its
 * surfaces (components/right-panel.tsx, "ONE TAB IS OPEN"). This list is cheap —
 * rows and a filter menu — and the detail behind a row is not: a markdown
 * pipeline, a checks block and the merge machinery. Opening Issues must not pay
 * for a detail nobody has clicked yet, so the import that used to sit up in the
 * panel comes DOWN here rather than becoming a static one.
 */
const ForgeDetailSurface = dynamic(() => import("@/components/session/github-detail-surface").then((mod) => mod.ForgeDetailSurface));

const api = createEngineApi();

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

/**
 * WHAT THIS SURFACE IS ASKING FOR.
 *
 * ONE TYPE FOR BOTH KINDS, with the widest state and the milestone that only issues
 * have — because the surface is one component and branching its whole state shape on
 * `kind` would double every handler below. What travels to the engine is narrowed
 * per kind at the call, where `gh`'s actual flags are.
 */
type Filter = { state: GitHubIssueFilter["state"] | GitHubPullFilter["state"]; milestone?: string; assignee?: string; author?: string; labels: string[] };

/**
 * A facet submenu's three states, in one place.
 *
 * EMPTY AND STILL-LOADING ARE DIFFERENT, and a submenu that showed nothing for both
 * would say "this repository has no milestones" about a network call in flight. A
 * facet read that FAILED lands here as empty too — which is honest for a menu, since
 * there is nothing to offer either way, and the list itself is unaffected.
 */
function FacetList({ loading, empty, children }: { loading: boolean; empty: string; children?: React.ReactNode }) {
  const has = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  if (loading && !has) {
    return (
      <p className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted-foreground">
        <Spinner className="size-3" /> asking gh…
      </p>
    );
  }
  if (!has) return <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">{empty}</p>;
  return <>{children}</>;
}

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
 * One row: four gestures, four targets.
 *
 * CLICKING OPENS IT IN THE PANEL — the row is a button, exactly as a row in the
 * file tree is. DRAGGING references it in the message. The link icon goes to
 * GitHub. AND, ON AN ISSUE, `action` STARTS A SESSION ON IT (#695). The four mean
 * different things ("read this here", "talk about this here", "take me to the
 * website", "go and work on this") and each has its own pixel, because a row that
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
  authorAvatar,
  assignees,
  labels,
  milestone,
  projects,
  links,
  extra,
  action,
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
  authorAvatar?: string;
  assignees: readonly string[];
  labels: readonly { name: string; color?: string }[];
  milestone?: string;
  projects: readonly string[];
  /** The other end of the issue↔PR link: what closes this row, or what this row
   *  closes. Empty on the overwhelming majority of rows. */
  links: readonly GitHubLink[];
  /** Row-specific badges — a pull request's review decision, its branch. */
  extra?: React.ReactNode;
  /** A control in the row's trailing gutter, beside the GitHub link — the issue
   *  row's "start a session on this" (#695). Absent draws nothing. */
  action?: React.ReactNode;
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
            <span className="shrink-0 font-mono text-3xs text-muted-foreground">#{number}</span>
            <span className="min-w-0 flex-1 truncate text-xs" title={title}>
              {title}
            </span>
          </span>
          {/* The facts line: status in words, then who opened it, then when. */}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-3xs text-muted-foreground">
            <span className={tone}>{STATUS_LABEL[status]}</span>
            {/* WHO FILED IT, WITH A FACE (#790). The face is beside the login and
                does not replace it: a login is still the thing you would say out
                loud, and this row is scanned for its status glyph first — which is
                why the avatar rides the facts line rather than taking the leading
                edge the glyph earns. */}
            {author && (
              <span className="inline-flex items-center gap-1">
                ·
                <GitHubAvatar login={author} {...(authorAvatar ? { src: authorAvatar } : {})} className="size-3" />
                {author}
              </span>
            )}
            <span>· {fmtAgo(when)}</span>
            {/* WHO HAS IT, AS LOGINS AND NOT AS A STACK OF FACES. Not a cost
                argument any more — #790 established that an avatar costs no `gh`
                call — but a width one: three faces and an overflow count in a
                320px row would push the labels onto a fourth line for names the
                reader would then have to hover to read. */}
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
          {(labels.length > 0 || milestone || projects.length > 0 || links.length > 0) && (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {/**
               * WHAT CLOSES THIS, OR WHAT THIS CLOSES — issue #790.
               *
               * FIRST ON THE CHIPS LINE, because on a list of closed issues it is the
               * chip somebody is actually scanning for: the evidence #790 was filed on
               * is that reading this repository meant asking "is this closed, and by
               * which PR" over and over and answering it with `gh` by hand.
               *
               * NOT A CONTROL, and that is not a shortcut. The row is already a
               * `<button>`, and a nested one is not parseable — the parser closes the
               * outer button at the inner tag, so every row's server markup and its
               * hydrated DOM would disagree (see `StartSessionAction`, which is a
               * `span[role=button]` for exactly this). The jump lives one click away in
               * the detail, where the link has room to say which repository it is in;
               * what a ROW needed was the number, and this is the number.
               */}
              {links.slice(0, 2).map((link) => (
                <Badge
                  key={link.url}
                  variant="outline"
                  className="gap-0.5 px-1 py-0 font-mono text-4xs font-normal tabular-nums"
                  title={
                    link.repository
                      ? `Linked to ${link.repository}#${link.number} — open this row to follow it`
                      : `Linked to #${link.number} — open this row to follow it`
                  }
                >
                  <LinkIcon className="size-2.5" />
                  {link.repository ? `${link.repository}#${link.number}` : `#${link.number}`}
                </Badge>
              ))}
              {links.length > 2 && <span className="text-4xs text-muted-foreground">+{links.length - 2}</span>}
              {labels.slice(0, 3).map((label) => (
                <Badge key={label.name} variant="outline" className="px-1 py-0 text-4xs font-normal">
                  {label.name}
                </Badge>
              ))}
              {labels.length > 3 && <span className="text-4xs text-muted-foreground">+{labels.length - 3}</span>}
              {milestone && (
                <Badge variant="outline" className="gap-0.5 px-1 py-0 text-4xs font-normal" title={`Milestone ${milestone}`}>
                  <MilestoneIcon className="size-2.5" />
                  {milestone}
                </Badge>
              )}
              {projects.map((project) => (
                <Badge key={project} variant="secondary" className="gap-0.5 px-1 py-0 text-4xs font-normal" title={`On the ${project} board`}>
                  <SquareKanbanIcon className="size-2.5" />
                  {project}
                </Badge>
              ))}
            </span>
          )}
        </span>
        {action}
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

/**
 * START A SESSION ON THIS ISSUE — the row's fourth gesture (#695).
 *
 * A `<span role="button">` RATHER THAN A `<button>`, and the reason is the row it
 * sits in: the whole row is already a `<button>`, and a nested one is not
 * parseable — the HTML parser closes the outer button at the inner tag, so the
 * server-rendered markup and the hydrated DOM would disagree about the shape of
 * every row. The GitHub link beside it is an `<a>` for the same reason and has
 * been all along. Keyboard-reachable on the same terms a real button would be:
 * `tabIndex`, Enter and Space, an `aria-label` that says the verb.
 *
 * `stopPropagation` ON BOTH, because the row's own click opens the issue as a tab
 * and starting a session is not that. Same guard the link already carries.
 */
function StartSessionAction({ number, busy, onStart }: { number: number; busy: boolean; onStart: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Start a worktree session on #${number}`}
      // The tooltip says what will happen, not what the icon is: the gesture
      // ends on a canvas with a message half-written, not in a running session,
      // and a reader who expected the latter would think it had failed.
      title={`Start a session on #${number} — a worktree of its own, with this issue in the message`}
      aria-busy={busy || undefined}
      onClick={(event) => {
        event.stopPropagation();
        onStart();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onStart();
      }}
      className="mt-0.5 shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
    >
      {busy ? <Spinner className="size-3" /> : <GitBranchPlusIcon className="size-3" />}
    </span>
  );
}

function IssueRow({ issue, open, onOpen, busy, onStart }: { issue: GitHubIssue; open: boolean; onOpen: () => void; busy?: boolean; onStart?: () => void }) {
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
      {...(issue.authorAvatar ? { authorAvatar: issue.authorAvatar } : {})}
      assignees={issue.assignees}
      labels={issue.labels}
      {...(issue.milestone ? { milestone: issue.milestone } : {})}
      projects={issue.projects}
      links={issue.linkedPulls}
      open={open}
      onOpen={onOpen}
      // Absent without a project to cut in — see `GitHubSurface`. A control that
      // could not work is worse than no control.
      {...(onStart ? { action: <StartSessionAction number={issue.number} busy={busy === true} onStart={onStart} /> } : {})}
      onDrag={(transfer) => startReferenceDrag(transfer, issueReference(issue))}
    />
  );
}

/** Exported for its markup alone, the way `EntryCard` and `MergeFooter` are next
 *  door: the list itself cannot be rendered without a `gh` read, so a claim about
 *  what a ROW says has nowhere else to be made. */
export function PullRow({ pull, mine, open, onOpen }: { pull: GitHubPullRequest; mine: boolean; open: boolean; onOpen: () => void }) {
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
      {...(pull.authorAvatar ? { authorAvatar: pull.authorAvatar } : {})}
      assignees={pull.assignees}
      labels={pull.labels}
      {...(pull.milestone ? { milestone: pull.milestone } : {})}
      projects={pull.projects}
      links={pull.linkedIssues}
      open={open}
      onOpen={onOpen}
      extra={
        <>
          {/* The one badge worth the width on a session's panel: this pull
              request is FOR THE BRANCH THIS SESSION IS ON. */}
          {mine && (
            <Badge variant="secondary" className="px-1 py-0 text-4xs font-normal">
              this session
            </Badge>
          )}
          {/* Only shown while it can still change. A merged pull request's review
              decision is history, and history does not need a badge. */}
          {status === "open" && pull.reviewDecision === "APPROVED" && (
            <Badge variant="outline" className="px-1 py-0 text-4xs font-normal text-success">
              approved
            </Badge>
          )}
          {status === "open" && pull.reviewDecision === "CHANGES_REQUESTED" && (
            <Badge variant="outline" className="px-1 py-0 text-4xs font-normal text-warning">
              changes requested
            </Badge>
          )}
          {/**
           * THE ONE OUTWARD WRITE, ANNOUNCED WHERE IT IS FOUND — issue #703.
           *
           * The merge control is good and it was invisible: you had to already
           * know to open a pull request here to discover that this cockpit can
           * merge one at all, and a capability you must already know about is one
           * you will not find. #692 gave the control a home; this is the sign on
           * the door, in the list, which is where somebody who does not know it
           * exists is standing.
           *
           * IT SAYS THERE IS A CONTROL, NOT THAT IT WILL WORK. A row is drawn from
           * the list snapshot, which carries no `mergeable` and no
           * `mergeStateStatus` — see `offersMerge`. So the wording is an offer of
           * a place ("merge here"), not a verdict: the footer one click away holds
           * the verdict, and it is pinned outside the detail's scroller, so
           * clicking this row lands on it without scrolling anything.
           *
           * NOT ITS OWN BUTTON. The row already opens the detail, and a second
           * control going to the same place would be a nested interactive element
           * for a click the whole row already accepts. What was missing was never
           * a target — it was the word.
           */}
          {offersMerge(pull) && (
            <Badge
              variant="outline"
              className="gap-0.5 px-1 py-0 text-4xs font-normal text-muted-foreground"
              title="Telar can merge this one — open it and the footer says whether GitHub will."
            >
              <GitMergeIcon className="size-2.5" />
              merge here
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
  /**
   * WHICH DETAILS ARE OPEN INSIDE THIS SURFACE, and which one is showing.
   *
   * Owned by the panel — it lives in this tab instance's `params`, which is what
   * persists it and what keeps two windows on one session independent — and
   * handed down here the way the Editor's files are (lib/forge-workspace.ts).
   * Absent means a surface nobody can drill into: the rows still read, which is
   * the right fallback for a caller with no panel to give.
   */
  open,
  onOpenChange,
  /** WHICH MAC this panel is about, so "start a session on this issue" opens a
   *  canvas on the same machine the project is on (#695). */
  hostId,
  /**
   * Put text into the message being written. Used by the issue row's session
   * action for the ONE case where the composer it needs already exists: this
   * panel is open on the very canvas the action is about to arm. Every other
   * case has no composer yet and goes through the canvas draft — see
   * `startSession`.
   */
  onInsertReference,
  /**
   * OPEN THE OTHER END OF THE ISSUE↔PR LINK (#790).
   *
   * Passed straight through to the detail rather than handled here, and it leaves
   * this surface because the other end is the other KIND: an issue's closing pull
   * request belongs to the Pull requests surface, not to this one's sub-strip. The
   * panel maps it onto the cockpit's own `showPanelTab("pull:786")` — the door a
   * GitHub link in a message already goes through. #49 §2 has this becoming a jump
   * within one surface once the two lists collapse; this is the same gesture
   * arriving early, through the existing route.
   */
  onOpenForge,
}: {
  kind: "issues" | "pulls";
  projectId?: string;
  branch?: string;
  open?: ForgeOpen;
  onOpenChange?: (next: ForgeOpen) => void;
  hostId?: string;
  onInsertReference?: (text: string) => void;
  onOpenForge?: (kind: "issue" | "pull", number: number) => void;
}) {
  const [snapshot, setSnapshot] = useState<GitHubSnapshot>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  /**
   * WHAT THIS SURFACE ASKED FOR.
   *
   * Held per surface rather than shared: the Issues tab showing open work assigned
   * to you while the Pull requests tab shows everything that ever merged is a
   * perfectly ordinary arrangement, and one filter for both would make it
   * impossible.
   */
  const [filter, setFilter] = useState<Filter>({ state: "open", labels: [] });
  /**
   * WHAT THERE IS TO FILTER BY, fetched when the menu first opens.
   *
   * LAZY ON PURPOSE. It is four more network calls against somebody else's rate
   * limit, and a reader who never opens the menu should never spend them. Once
   * fetched it is cached in the engine for five minutes, so opening the menu again
   * costs nothing.
   */
  const [facets, setFacets] = useState<GitHubFacets>();
  const [loadingFacets, setLoadingFacets] = useState(false);
  /**
   * WHY A SESSION WAS NOT STARTED, and which row is asking (#695).
   *
   * A SENTENCE IN THE SURFACE RATHER THAN A TOAST. The refusal is about this
   * project's checkout — an unplugged drive, a folder that moved — so it belongs
   * beside the list it refused for, where it stays put long enough to be read and
   * acted on. Cleared by the next attempt; a successful one navigates away.
   */
  const [refusal, setRefusal] = useState<string>();
  /** The issue whose checkout read is in flight, so its own control can spin and
   *  a second press cannot start two. */
  const [starting, setStarting] = useState<number>();
  const router = useRouter();
  const pathname = usePathname();

  /**
   * ISSUE → SESSION (#695). Read the checkout, decide, then either refuse with
   * the reason or hand the canvas a first message and open it.
   *
   * THE READ IS ON THE PRESS, not on mount. It costs nothing for the reader who
   * never uses this, and it is the freshest possible answer about a cable at the
   * moment somebody is relying on it — `assertProjectAvailable`'s own argument
   * for probing rather than trusting the last listing.
   *
   * WHERE THE FIRST MESSAGE GOES, and why there are two answers. A canvas mints
   * no session, so ordinarily there is no composer to write into and the message
   * travels as the project's CANVAS DRAFT — the same key the composer restores
   * from on arrival (`lib/composer-draft.ts`). The exception is this panel being
   * open on that very canvas already: its composer exists, holds the authority
   * over that key, and would overwrite anything written underneath it on its next
   * keystroke — so there the reference goes through `onInsertReference`, live.
   *
   * NOTHING TYPED IS EVER EATEN, on either path: an existing draft is appended
   * to with `insertReference`'s spacing, which is the rule `insertIntoComposer`
   * follows for the same gesture from the other side.
   */
  const startSession = useCallback(
    async (issue: GitHubIssue) => {
      if (!projectId) return;
      setRefusal(undefined);
      setStarting(issue.number);
      let git;
      let unreadable: string | undefined;
      try {
        git = (await api.projectGit(projectId)).git;
      } catch (cause) {
        unreadable = cause instanceof EngineApiError ? cause.message : undefined;
      } finally {
        setStarting(undefined);
      }
      const start = issueSessionStart({
        issue,
        projectId,
        ...(hostId ? { hostId } : {}),
        ...(git ? { git } : {}),
        ...(unreadable ? { unreadable } : {}),
      });
      if (!start.ok) {
        setRefusal(start.reason);
        return;
      }
      if (onInsertReference && pathname === canvasHref(projectId, hostId)) onInsertReference(start.text);
      else {
        const existing = readDraft(undefined, projectId);
        writeDraft(undefined, projectId, existing.trim() ? insertReference(existing, start.text, existing.length).draft : start.text);
      }
      // `push`, not `replace`: the issue list the reader came from is somewhere
      // they may well want Back to return to.
      router.push(start.href);
    },
    [projectId, hostId, onInsertReference, pathname, router],
  );

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
              ...(kind === "issues"
                ? { issues: filter as GitHubIssueFilter }
                : { pulls: { state: filter.state as GitHubPullFilter["state"], ...(filter.assignee ? { assignee: filter.assignee } : {}), ...(filter.author ? { author: filter.author } : {}), labels: filter.labels } }),
            })
          ).github,
        );
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
      }
    },
    [projectId, kind, filter],
  );

  /** Asked once, when the menu opens. A failure is silent: the menu still offers
   *  the states, which is the filter that needs no list of values. */
  const openFacets = useCallback(
    (open: boolean) => {
      if (!open || facets || loadingFacets || !projectId) return;
      setLoadingFacets(true);
      void api
        .projectForgeFacets(projectId)
        .then((read) => setFacets(read.facets))
        .catch(() => undefined)
        .finally(() => setLoadingFacets(false));
    },
    [facets, loadingFacets, projectId],
  );

  /** Setting a facet REPLACES it and clears nothing else; `undefined` removes it.
   *  A label toggles, because `gh` ANDs repeated labels and that is what the
   *  checkbox in the menu means. */
  const choose = (patch: Partial<Filter>) => setFilter((current) => ({ ...current, ...patch }));
  const toggleLabel = (label: string) =>
    setFilter((current) => ({
      ...current,
      labels: current.labels.includes(label) ? current.labels.filter((entry) => entry !== label) : [...current.labels, label],
    }));
  const clearChip = (chip: ForgeFilterChip) =>
    setFilter((current) =>
      chip.clear === "label"
        ? { ...current, labels: current.labels.filter((entry) => entry !== chip.value) }
        : { ...current, [chip.clear]: undefined },
    );

  const forge = open ?? emptyForge();
  const detail = forge.at;
  /** The `load` this surface has already issued. Its identity changes exactly
   *  when the project, the kind or the filter does — which is the whole of what
   *  makes an answer stale — so comparing it is how "read once for this
   *  question" is expressed without a second copy of the question. */
  const issued = useRef<typeof load>(undefined);

  useEffect(() => {
    // ONCE, ON OPEN, and again when the filter changes — which is a person asking,
    // not a timer. No interval: this is somebody else's rate limit, and a panel
    // left open on a second monitor must not spend it.
    //
    // AND NOT WHILE A DETAIL IS SHOWING (#693). The list is behind the sub-strip
    // then, and reading a list nobody is looking at spends the same rate limit
    // for nothing — a session restored onto `#675` would have paid for it before
    // drawing a single row. Coming BACK does not re-read either: the header
    // stamps how old the answer is and offers the refresh, which is the contract
    // this surface has always had with a stale read.
    if (detail !== undefined || issued.current === load) return;
    issued.current = load;
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, detail]);

  const label = kind === "issues" ? "issues" : "pull requests";
  const Icon = kind === "issues" ? CircleDotIcon : GitPullRequestIcon;
  const options = STATES[kind];
  const chosen = options.find((entry) => entry.id === filter.state) ?? options[0];
  const chips = filterChips(filter);

  /**
   * THE LIST, WHICH IS NOW ONE OF TWO BODIES rather than the whole surface.
   *
   * A function rather than three early returns from the component, because the
   * sub-strip above has to stay drawn whatever the list is doing: a read that
   * failed, or a repository `gh` cannot see, must not take away the chips that
   * are the way back to the issue you were reading.
   */
  const list = () => {
    if (error) {
      return (
        <PanelEmpty icon={<Icon />} title="Could not read GitHub">
          {error}
        </PanelEmpty>
      );
    }
    if (!snapshot) {
      return (
        <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
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
    /** Which numbers already have a chip in the sub-strip, so a row can say so
     *  rather than opening a second one for the same issue. */
    const alreadyOpen = new Set(forge.numbers);
    /** The filter the ROWS were read under, not the one the menu is showing: a read
     *  in flight means those two disagree for a moment, and the sentence under an
     *  empty list has to describe what produced it. */
    const shown = kind === "issues" ? snapshot.issueFilter : snapshot.pullFilter;
    const shownChips = filterChips(shown);

    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-2xs text-muted-foreground">
          {/**
           * ONE MENU FOR EVERY NARROWING, with the state at the top level and the
           * facets in submenus. A row of pills does not fit in 320px once there are
           * four states and three facets, and the thing worth showing on the trigger is
           * what you chose rather than what you could choose.
           *
           * `onOpenChange` IS WHAT FETCHES THE FACETS, which is why they are free for
           * anybody who never opens this.
           */}
          <DropdownMenu onOpenChange={openFacets}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Filter ${label}`}
                  title={`Filter ${label}`}
                  className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                />
              }
            >
              <ListFilterIcon className="size-3" />
              <span>{chosen.label}</span>
              {/* A COUNT ON THE TRIGGER, so a collapsed menu still admits it is
                  narrowing. The chips below say by what. */}
              {chips.length > 0 && (
                <span className="rounded-full bg-primary/15 px-1 font-mono text-4xs leading-4 text-primary">{chips.length}</span>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {/* THE LABEL LIVES INSIDE THE GROUP IT NAMES. A label at depth zero is
                  not associated with anything for a screen reader, which this
                  repository has a test for — see ui/dropdown-menu.test.ts. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Show</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={filter.state} onValueChange={(next) => choose({ state: next as Filter["state"] })}>
                  {options.map((option) => (
                    <DropdownMenuRadioItem key={option.id} value={option.id}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>

              <DropdownMenuSeparator />

              {/* MILESTONE IS ISSUES-ONLY. `gh pr list` has no `--milestone` flag, so
                  offering it here would be a control that cannot work. */}
              {kind === "issues" && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <MilestoneIcon />
                    <span className="flex-1 truncate">Milestone</span>
                    <span className="max-w-24 truncate text-muted-foreground">{filter.milestone ?? "any"}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56">
                    <FacetList loading={loadingFacets} empty="This repository has no milestones.">
                      {facets?.milestones.length ? (
                        <DropdownMenuRadioGroup
                          value={filter.milestone ?? ""}
                          onValueChange={(next) => choose({ milestone: next || undefined })}
                        >
                          <DropdownMenuRadioItem value="">Any milestone</DropdownMenuRadioItem>
                          {facets.milestones.map((milestone) => (
                            <DropdownMenuRadioItem key={milestone.title} value={milestone.title}>
                              <span className="flex-1 truncate">{milestone.title}</span>
                              {/* What is LEFT in it, which is the number that decides
                                  whether the milestone is worth opening. */}
                              <span className="ml-1 shrink-0 font-mono text-4xs text-muted-foreground tabular-nums">{milestone.open}</span>
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      ) : null}
                    </FacetList>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <UserRoundIcon />
                  <span className="flex-1 truncate">Assignee</span>
                  <span className="max-w-24 truncate text-muted-foreground">{filter.assignee ?? "anyone"}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <FacetList loading={loadingFacets} empty="No assignees to choose from.">
                    <DropdownMenuRadioGroup value={filter.assignee ?? ""} onValueChange={(next) => choose({ assignee: next || undefined })}>
                      <DropdownMenuRadioItem value="">Anyone</DropdownMenuRadioItem>
                      {/* THE VIEWER FIRST AND BY NAME. "assigned to me" is the filter
                          people actually want, and naming the account says which one
                          gh is signed in as — worth knowing before you trust it. */}
                      {facets?.viewer && <DropdownMenuRadioItem value={facets.viewer}>{facets.viewer} · me</DropdownMenuRadioItem>}
                      {(facets?.assignees ?? [])
                        .filter((login) => login !== facets?.viewer)
                        .map((login) => (
                          <DropdownMenuRadioItem key={login} value={login}>
                            <span className="truncate">{login}</span>
                          </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                  </FacetList>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <TagIcon />
                  <span className="flex-1 truncate">Labels</span>
                  <span className="shrink-0 text-muted-foreground">{filter.labels.length > 0 ? filter.labels.length : "any"}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                  <FacetList loading={loadingFacets} empty="This repository has no labels.">
                    {/* CHECKBOXES, because `gh` ANDs repeated `--label` flags — two
                        ticks means rows carrying both, which is what a reader expects
                        of two ticks. */}
                    {(facets?.labels ?? []).map((entry) => (
                      <DropdownMenuCheckboxItem
                        key={entry.name}
                        checked={filter.labels.includes(entry.name)}
                        onCheckedChange={() => toggleLabel(entry.name)}
                        closeOnClick={false}
                      >
                        <span className="truncate">{entry.name}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </FacetList>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              {chips.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setFilter({ state: filter.state, labels: [] })}>
                    <XIcon />
                    Clear filters
                  </DropdownMenuItem>
                </>
              )}
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

        {/**
         * WHAT IS NARROWING THIS LIST, visible without opening the menu that set it.
         *
         * The failure this prevents: pick a milestone, come back tomorrow, see no rows
         * and conclude the repository is empty. Each chip removes its own filter, which
         * is faster than reopening a submenu to unset one thing.
         *
         * Drawn from the filter the ROWS were read under, not the one being edited, so
         * it never describes a narrowing that has not been applied yet.
         */}
        {shownChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-1.5">
            {shownChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => clearChip(chip)}
                title={`Stop filtering by ${chip.label}`}
                className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border px-1.5 py-0 text-4xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-foreground"
              >
                <span className="truncate">{chip.label}</span>
                <XIcon className="size-2.5 shrink-0" />
              </button>
            ))}
          </div>
        )}

        {/**
         * WHY NO SESSION WAS STARTED (#695).
         *
         * ABOVE THE LIST, NOT IN A TOAST AND NOT IN PLACE OF IT. The rows are
         * still true and still worth reading; what failed is one gesture, and the
         * reason is a fact about this project's disk that the reader has to act on
         * somewhere else — plug a drive in, find a folder. A notice that dismissed
         * itself after four seconds would be the wrong shape for both.
         *
         * INSIDE `list()` RATHER THAN OVER THE WHOLE SURFACE, because the sub-strip
         * above it belongs to the open details (#693): a refusal about cutting a
         * worktree has nothing to do with an issue somebody has open in a chip, and
         * spanning both would make it read as the thread's problem rather than the
         * action's.
         *
         * `attention`, not `danger`: nothing broke and nothing was lost. The cut
         * did not happen, and the sentence says what would make it happen.
         *
         * `tint-warning` RATHER THAN `bg-warning/10`, which is #691's contract and
         * not a style preference: an alpha here would be a tenth of the theme's
         * amber over nine tenths of whatever the wash left behind, so the band
         * would dissolve into the backdrop on a translucent Look and take the
         * sentence with it. The class mixes the same colour INTO the card.
         */}
        {refusal && (
          <p className="tint-warning border-b border-border px-4 py-2 text-2xs leading-snug text-foreground" role="status">
            {refusal}
          </p>
        )}

        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-2xs leading-snug text-muted-foreground">
            {shownChips.length > 0
              ? `Nothing matches those filters.`
              : shown.state === "open"
                ? `Nothing open.`
                : `No ${label} in this repository match that.`}
          </p>
        ) : (
          <>
            <div className="flex flex-col group">
              {kind === "issues"
                ? snapshot.issues.map((issue) => (
                    <IssueRow
                      key={issue.number}
                      issue={issue}
                      open={alreadyOpen.has(issue.number)}
                      onOpen={() => onOpenChange?.(openForge(forge, issue.number))}
                      busy={starting === issue.number}
                      // WITHOUT A PROJECT THERE IS NOWHERE TO CUT, and the surface
                      // itself is empty in that case anyway — but the control is
                      // withheld rather than left to fail, which is the same rule
                      // the base picker follows on a project checkout.
                      {...(projectId ? { onStart: () => void startSession(issue) } : {})}
                    />
                  ))
                : snapshot.pulls.map((pull) => (
                    <PullRow
                      key={pull.number}
                      pull={pull}
                      mine={Boolean(branch) && pull.headRefName === branch}
                      open={alreadyOpen.has(pull.number)}
                      onOpen={() => onOpenChange?.(openForge(forge, pull.number))}
                    />
                  ))}
            </div>
            {/* WHY THE BOARD CHIPS ARE MISSING, said once at the bottom and only when
                it is true. Silence would make every row look like it is on no board. */}
            {snapshot.projectsUnavailable === "scope" && (
              <p className="border-t border-border px-4 py-2 text-2xs leading-snug text-muted-foreground">
                Boards are not shown: the gh token has no <span className="font-mono">read:project</span> scope. Run{" "}
                <span className="font-mono">gh auth refresh -s read:project</span> and press refresh.
              </p>
            )}
            {snapshot.projectsUnavailable === "failed" && (
              <p className="border-t border-border px-4 py-2 text-2xs leading-snug text-muted-foreground">
                Boards could not be read this time.
              </p>
            )}
            <p className="px-4 py-2 text-2xs leading-snug text-muted-foreground">
              Click a row to read it here; drag one into the message to reference it.
            </p>
          </>
        )}
      </div>
    );
  };

  /** `issues`/`pulls` name a LIST; `issue`/`pull` name ONE of them. The detail
   *  surface asks `gh` in the singular, so the translation happens once, here. */
  const one = kind === "issues" ? "issue" : "pull";
  const close = (number: number) => onOpenChange?.(closeForge(forge, number));
  /** A sweep is the ordinary close run repeatedly, not a filter over the open
   *  set — one close path, so the focus rule stays in one place. */
  const closeMany = (numbers: readonly number[]) => {
    let next = forge;
    for (const number of numbers) next = closeForge(next, number);
    onOpenChange?.(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/**
       * THE SUB-STRIP, AND ONLY ONCE THERE IS SOMETHING IN IT.
       *
       * A surface nobody has drilled into reads exactly as it did before this
       * change — its own filter row is still the first thing in the box. Drawing
       * an always-present strip holding one chip that says "Issues", above a
       * surface whose tab already says Issues, would spend 32px to repeat the
       * word above it.
       *
       * SAME VOCABULARY AS THE PANEL'S OWN STRIP and as the Editor's: rounded
       * chips, × on hover, middle-click closes, the four close verbs on the
       * right-press. A second dialect of "tab" one level down is the thing that
       * makes a panel feel like an app inside an app.
       */}
      {forge.numbers.length > 0 && (
        <div
          role="tablist"
          aria-label={kind === "issues" ? "Open issues" : "Open pull requests"}
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1"
        >
          {/* THE LIST IS THE FIRST CHIP AND HAS NO ×. It is what the surface is
              for; closing the last detail comes back here rather than to
              nothing (see `closeForge`). */}
          <button
            type="button"
            role="tab"
            aria-selected={detail === undefined}
            onClick={() => onOpenChange?.(showForgeList(forge))}
            title={`All ${label}`}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              detail === undefined ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <Icon className="size-3" />
            {kind === "issues" ? "Issues" : "Pull requests"}
          </button>
          {forge.numbers.map((number) => {
            const on = number === detail;
            return (
              <span
                key={number}
                className={cn(
                  "group/forge relative flex h-7 min-w-0 shrink-0 rounded-md text-xs transition-colors",
                  on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {/* THE TRIGGER IS THE CHIP'S FLEX ROW, PADDING AND ALL — it
                    cannot be `display: contents`, which is never painted and so
                    is never an event target, and a right-press in the chip's own
                    padding would sail past this menu into the strip behind it.
                    The Editor's strip paid a screenshot to learn that. */}
                <ContextMenu>
                  <ContextMenuTrigger render={<span className="flex min-w-0 flex-1 items-center px-1.5" />}>
                    {/**
                     * A CHIP WEARS ITS NUMBER, not its title. `#675` is the
                     * shortest thing that identifies an issue and the thing a
                     * person says out loud; a truncated title (`Navigation
                     * fr…`) is longer, less recognisable, and would have to be
                     * fetched before the chip could be drawn — so a restored
                     * strip would have no labels until the network answered.
                     */}
                    <button
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => onOpenChange?.(activateForge(forge, number))}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        close(number);
                      }}
                      title={`${one === "issue" ? "Issue" : "Pull request"} #${number}`}
                      className="flex min-w-0 flex-1 items-center font-mono tabular-nums outline-none"
                    >
                      #{number}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close #${number}`}
                      title="Close"
                      onClick={() => close(number)}
                      className={cn(
                        "ml-1 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
                        on ? "opacity-70" : "opacity-0 group-hover/forge:opacity-70",
                      )}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => close(number)}>Close</ContextMenuItem>
                    <ContextMenuItem onClick={() => closeMany(otherForgeNumbers(forge, number))}>Close others</ContextMenuItem>
                    <ContextMenuItem onClick={() => closeMany(forgeNumbersAfter(forge, number))}>Close to the right</ContextMenuItem>
                    <ContextMenuItem onClick={() => closeMany(forge.numbers)}>Close all</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </span>
            );
          })}
        </div>
      )}

      {/* THE LIST SCROLLS IN THIS BOX; THE DETAIL DOES NOT. A detail runs
          `h-full` with its own scroller and a merge footer pinned under it, so a
          second scroller around it would put the footer below the fold — which
          is how an issue's comments became unreachable once before (see the
          panel's `OWNS_ITS_HEIGHT`). */}
      <div className={cn("min-h-0 flex-1", detail === undefined ? "overflow-y-auto" : "overflow-hidden")}>
        {detail === undefined ? (
          list()
        ) : (
          /* KEYED BY THE NUMBER, so switching chips remounts rather than leaving
             the previous issue's thread on screen under the new chip's label
             while `gh` answers. */
          <ForgeDetailSurface
            key={detail}
            kind={one}
            number={detail}
            {...(projectId ? { projectId } : {})}
            {...(one === "pull" && branch ? { branch } : {})}
            {...(onOpenForge ? { onOpenForge } : {})}
          />
        )}
      </div>
    </div>
  );
}

/** The engine's page size. A list exactly this long is probably truncated, and the
 *  `+` says so rather than claiming the repository has exactly fifty. */
const GITHUB_PAGE_HINT = 50;
