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
  TagIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import type { GitHubFacets, GitHubIssue, GitHubIssueFilter, GitHubPullFilter, GitHubPullRequest, GitHubSnapshot } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { fmtAgo } from "@/lib/format";
import { filterChips, issueStatus, pullStatus, STATUS_LABEL, STATUS_TONE, UNAVAILABLE, type ForgeFilterChip, type ForgeStatus } from "@/lib/github-forge";
import { issueReference, pullReference, startReferenceDrag } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
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
      <p className="flex items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-muted-foreground">
        <Spinner className="size-3" /> asking gh…
      </p>
    );
  }
  if (!has) return <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">{empty}</p>;
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
            <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">#{number}</span>
            <span className="min-w-0 flex-1 truncate text-xs" title={title}>
              {title}
            </span>
          </span>
          {/* The facts line: status in words, then who opened it, then when. */}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.625rem] text-muted-foreground">
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
                <Badge key={label.name} variant="outline" className="px-1 py-0 text-[0.5625rem] font-normal">
                  {label.name}
                </Badge>
              ))}
              {labels.length > 3 && <span className="text-[0.5625rem] text-muted-foreground">+{labels.length - 3}</span>}
              {milestone && (
                <Badge variant="outline" className="gap-0.5 px-1 py-0 text-[0.5625rem] font-normal" title={`Milestone ${milestone}`}>
                  <MilestoneIcon className="size-2.5" />
                  {milestone}
                </Badge>
              )}
              {projects.map((project) => (
                <Badge key={project} variant="secondary" className="gap-0.5 px-1 py-0 text-[0.5625rem] font-normal" title={`On the ${project} board`}>
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
            <Badge variant="secondary" className="px-1 py-0 text-[0.5625rem] font-normal">
              this session
            </Badge>
          )}
          {/* Only shown while it can still change. A merged pull request's review
              decision is history, and history does not need a badge. */}
          {status === "open" && pull.reviewDecision === "APPROVED" && (
            <Badge variant="outline" className="px-1 py-0 text-[0.5625rem] font-normal text-success">
              approved
            </Badge>
          )}
          {status === "open" && pull.reviewDecision === "CHANGES_REQUESTED" && (
            <Badge variant="outline" className="px-1 py-0 text-[0.5625rem] font-normal text-warning">
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
  const chosen = options.find((entry) => entry.id === filter.state) ?? options[0];
  const chips = filterChips(filter);

  if (error) {
    return (
      <PanelEmpty icon={<Icon />} title="Could not read GitHub">
        {error}
      </PanelEmpty>
    );
  }
  if (!snapshot) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-[0.6875rem] text-muted-foreground">
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
  /** The filter the ROWS were read under, not the one the menu is showing: a read
   *  in flight means those two disagree for a moment, and the sentence under an
   *  empty list has to describe what produced it. */
  const shown = kind === "issues" ? snapshot.issueFilter : snapshot.pullFilter;
  const shownChips = filterChips(shown);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-[0.6875rem] text-muted-foreground">
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
              <span className="rounded-full bg-primary/15 px-1 font-mono text-[0.5625rem] leading-4 text-primary">{chips.length}</span>
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
                            <span className="ml-1 shrink-0 font-mono text-[0.5625rem] text-muted-foreground tabular-nums">{milestone.open}</span>
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
              className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border px-1.5 py-0 text-[0.5625rem] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-foreground"
            >
              <span className="truncate">{chip.label}</span>
              <XIcon className="size-2.5 shrink-0" />
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[0.6875rem] leading-snug text-muted-foreground">
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
            <p className="border-t border-border px-4 py-2 text-[0.6875rem] leading-snug text-muted-foreground">
              Boards are not shown: the gh token has no <span className="font-mono">read:project</span> scope. Run{" "}
              <span className="font-mono">gh auth refresh -s read:project</span> and press refresh.
            </p>
          )}
          {snapshot.projectsUnavailable === "failed" && (
            <p className="border-t border-border px-4 py-2 text-[0.6875rem] leading-snug text-muted-foreground">
              Boards could not be read this time.
            </p>
          )}
          <p className="px-4 py-2 text-[0.6875rem] leading-snug text-muted-foreground">
            Click a row to read it here; drag one into the message to reference it.
          </p>
        </>
      )}
    </div>
  );
}

/** The engine's page size. A list exactly this long is probably truncated, and the
 *  `+` says so rather than claiming the repository has exactly fifty. */
const GITHUB_PAGE_HINT = 50;
