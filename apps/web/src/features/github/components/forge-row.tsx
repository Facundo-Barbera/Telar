"use client";

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
  MilestoneIcon,
  SquareKanbanIcon,
  UserRoundIcon,
} from "lucide-react";
import type { GitHubIssue, GitHubLink, GitHubPullRequest } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { PanelRow } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { issueReference, pullReference, startReferenceDrag } from "@/lib/drag-reference";
import { fmtAgo } from "@/lib/format";
import { issueStatus, offersMerge, pullStatus, STATUS_LABEL, STATUS_TONE, type ForgeStatus } from "@/lib/github-forge";
import { cn } from "@/lib/utils";
import { GitHubAvatar } from "./github-avatar";

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

const TONE_TEXT: Record<(typeof STATUS_TONE)[ForgeStatus], string> = {
  active: "text-primary",
  done: "text-success",
  info: "text-info",
  none: "text-muted-foreground",
};

type ForgeRowProps = {
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
  links: readonly GitHubLink[];
  extra?: React.ReactNode;
  action?: React.ReactNode;
  open?: boolean;
  onOpen: () => void;
  onDrag: (transfer: DataTransfer) => void;
};

function RowChips({ labels, milestone, projects, links }: Pick<ForgeRowProps, "labels" | "milestone" | "projects" | "links">) {
  if (labels.length === 0 && !milestone && projects.length === 0 && links.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
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
  );
}

/** Click opens it in the panel, drag references it, the link goes to GitHub, and `action` is the row's own verb. */
function ForgeRow({ glyph: Glyph, status, number, title, url, when, author, authorAvatar, assignees, extra, action, open, onOpen, onDrag, ...chips }: ForgeRowProps) {
  const tone = TONE_TEXT[STATUS_TONE[status]];
  return (
    <PanelRow className="p-0 pl-0">
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
        <Glyph className={cn("mt-0.5 size-3.5 shrink-0", tone)} aria-label={STATUS_LABEL[status]} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-3xs text-muted-foreground">#{number}</span>
            <span className="min-w-0 flex-1 truncate text-xs" title={title}>
              {title}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-3xs text-muted-foreground">
            <span className={tone}>{STATUS_LABEL[status]}</span>
            {author && (
              <span className="inline-flex items-center gap-1">
                ·
                <GitHubAvatar login={author} {...(authorAvatar ? { src: authorAvatar } : {})} className="size-3" />
                {author}
              </span>
            )}
            <span>· {fmtAgo(when)}</span>
            {assignees.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-foreground" title={`Assigned to ${assignees.join(", ")}`}>
                <UserRoundIcon className="size-2.5" />
                {assignees.slice(0, 2).join(", ")}
                {assignees.length > 2 && ` +${assignees.length - 2}`}
              </span>
            )}
            {extra}
          </span>
          <RowChips {...chips} />
        </span>
        {action}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open #${number} on GitHub`}
          title="Open on GitHub"
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

// A span, not a button: the row is already a <button>, and a nested one breaks
// parsing so server markup and hydrated DOM would disagree.
function StartSessionAction({ number, busy, onStart }: { number: number; busy: boolean; onStart: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Start a worktree session on #${number}`}
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

export function IssueRow({ issue, open, onOpen, busy, onStart }: { issue: GitHubIssue; open: boolean; onOpen: () => void; busy?: boolean; onStart?: () => void }) {
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
      {...(onStart ? { action: <StartSessionAction number={issue.number} busy={busy === true} onStart={onStart} /> } : {})}
      onDrag={(transfer) => startReferenceDrag(transfer, issueReference(issue))}
    />
  );
}

function PullBadges({ pull, mine, open }: { pull: GitHubPullRequest; mine: boolean; open: boolean }) {
  return (
    <>
      {mine && (
        <Badge variant="secondary" className="px-1 py-0 text-4xs font-normal">
          this session
        </Badge>
      )}
      {open && pull.reviewDecision === "APPROVED" && (
        <Badge variant="outline" className="px-1 py-0 text-4xs font-normal text-success">
          approved
        </Badge>
      )}
      {open && pull.reviewDecision === "CHANGES_REQUESTED" && (
        <Badge variant="outline" className="px-1 py-0 text-4xs font-normal text-warning">
          changes requested
        </Badge>
      )}
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
  );
}

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
      extra={<PullBadges pull={pull} mine={mine} open={status === "open"} />}
      onDrag={(transfer) => startReferenceDrag(transfer, pullReference(pull))}
    />
  );
}
