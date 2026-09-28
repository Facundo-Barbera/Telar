"use client";

import { CircleDotIcon, ExternalLinkIcon, GitMergeIcon, GitPullRequestIcon, MilestoneIcon, SquareKanbanIcon, UserIcon } from "lucide-react";
import type { GitHubIssueDetail, GitHubLink, GitHubPullDetail } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { fmtAgo } from "@/lib/format";
import { exactTime, linkVerb } from "../model";
import { GitHubAvatar } from "./github-avatar";

type Thing = GitHubIssueDetail | GitHubPullDetail;

function BranchLine({ pull, mine }: { pull: GitHubPullDetail; mine?: boolean }) {
  return (
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
      {mine && (
        <Badge variant="secondary" className="px-1 py-0 font-sans text-4xs font-normal">
          this session
        </Badge>
      )}
    </p>
  );
}

// A cross-repository reference can't be opened by this repository's surface, so it links out.
function LinkedLine({ thing, pull, onOpenLinked }: { thing: Thing; pull?: GitHubPullDetail; onOpenLinked?: (link: GitHubLink) => void }) {
  const links = pull ? pull.linkedIssues : (thing as GitHubIssueDetail).linkedPulls;
  if (links.length === 0) return null;
  const Glyph = pull ? CircleDotIcon : GitPullRequestIcon;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
      <Glyph className="size-3 shrink-0" />
      <span>{linkVerb(Boolean(pull), thing.state)}</span>
      {links.map((link) =>
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
}

// Drawn even when empty: "No labels" is a fact, an absent row is indistinguishable from a failed read.
function ChipsLine({ thing }: { thing: Thing }) {
  return (
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
      {thing.projects.map((project) => (
        <Badge key={project} variant="secondary" className="gap-0.5 px-1 py-0 text-4xs font-normal" title={`On the ${project} board`}>
          <SquareKanbanIcon className="size-2.5" />
          {project}
        </Badge>
      ))}
    </div>
  );
}

/** The detail's facts in the list row's grammar; its first line is the thread's one attribution. */
export function ForgeFacts({ thing, pull, mine, onOpenLinked }: { thing: Thing; pull?: GitHubPullDetail; mine?: boolean; onOpenLinked?: (link: GitHubLink) => void }) {
  const openedAt = thing.createdAt;
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
        <GitHubAvatar {...(thing.author ? { login: thing.author } : {})} {...(thing.authorAvatar ? { src: thing.authorAvatar } : {})} className="size-4" />
        <span className="font-medium text-foreground">{thing.author ?? "someone"}</span>
        <span title={exactTime(openedAt)}>opened this {fmtAgo(openedAt)}</span>
        {thing.updatedAt > openedAt && <span>· updated {fmtAgo(thing.updatedAt)}</span>}
        {thing.assignees.length > 0 && (
          <span className="inline-flex items-center gap-0.5 text-foreground" title={`Assigned to ${thing.assignees.join(", ")}`}>
            <UserIcon className="size-2.5" />
            {thing.assignees.join(", ")}
          </span>
        )}
      </p>
      {pull && <BranchLine pull={pull} {...(mine ? { mine } : {})} />}
      {pull?.mergedAt && (
        <p className="flex items-center gap-1 text-2xs text-success">
          <GitMergeIcon className="size-3" />
          Merged{pull.mergedBy ? ` by ${pull.mergedBy}` : ""} <span title={exactTime(pull.mergedAt)}>{fmtAgo(pull.mergedAt)}</span>
        </p>
      )}
      <LinkedLine thing={thing} {...(pull ? { pull } : {})} {...(onOpenLinked ? { onOpenLinked } : {})} />
      <ChipsLine thing={thing} />
    </div>
  );
}
