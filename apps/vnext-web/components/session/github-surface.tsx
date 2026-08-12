"use client";

/**
 * ISSUES AND PULL REQUESTS, and the thing they are mainly for: dragging one
 * into the message you are writing.
 *
 * WHY THESE ARE PANEL SURFACES RATHER THAN A PAGE. An issue is not something
 * you go and read; it is something you point an agent at. Putting the list
 * beside the conversation — in the same rail as the files it changed and the
 * page it has open — makes "work on this" a drag rather than a copy, a paste
 * and a hope that the number was right.
 *
 * A NETWORK READ, AND IT SAYS SO. Everything else in this panel folds records
 * the cockpit already holds; this one goes out to GitHub through the `gh` CLI
 * and can be slow, stale, rate-limited or unauthenticated. So it never polls,
 * it carries the time it was read, and each of the four ways it can be
 * unavailable gets its own sentence — "install gh", "log in", "this is not a
 * GitHub repository" and "here is what gh said" need four different responses
 * from a reader, and one grey empty list would earn none of them.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleDotIcon, ExternalLinkIcon, GitPullRequestIcon, RotateCwIcon } from "lucide-react";
import type { GitHubIssue, GitHubPullRequest, GitHubSnapshot } from "@telar/engine-client";
import { createVNextApi, VNextApiError } from "@/lib/vnext/client";
import { fmtAgo } from "@/lib/format";
import { issueReference, pullReference, startReferenceDrag } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
import { PanelEmpty, PanelRow } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createVNextApi();

/** What each kind of absence means, and what to do about it. Four sentences
 *  rather than one, because they need four different responses. */
const UNAVAILABLE: Record<NonNullable<GitHubSnapshot["unavailable"]>, { title: string; detail: string }> = {
  not_installed: {
    title: "The gh CLI is not installed",
    detail: "Telar reads GitHub through gh so it never has to hold a token. Install it and this fills in.",
  },
  not_authenticated: {
    title: "gh is not signed in",
    detail: "Run gh auth login on this machine. Sign-in lives outside Telar, the same as it does for Claude and Codex.",
  },
  no_repository: {
    title: "No GitHub remote",
    detail: "This project is not a GitHub repository, which is a perfectly ordinary thing for a project to be.",
  },
  failed: { title: "gh could not answer", detail: "" },
};

/**
 * One row, draggable.
 *
 * THE WHOLE ROW IS THE DRAG HANDLE and the link is a separate target, because
 * the two gestures mean different things: dragging says "talk about this here",
 * clicking says "take me to GitHub". A row that did both from the same pixel
 * would make one of them an accident.
 */
function ForgeRow({
  icon,
  number,
  title,
  url,
  meta,
  badges,
  onDrag,
}: {
  icon: React.ReactNode;
  number: number;
  title: string;
  url: string;
  meta: string;
  badges?: React.ReactNode;
  onDrag: (transfer: DataTransfer) => void;
}) {
  return (
    <PanelRow tone="none" className="p-0 pl-0">
      <div
        draggable
        onDragStart={(event) => onDrag(event.dataTransfer)}
        title="Drag into the message to reference it"
        className="flex w-full min-w-0 cursor-grab items-start gap-2 py-2 pr-2 pl-4 active:cursor-grabbing"
      >
        <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{number}</span>
            <span className="min-w-0 flex-1 truncate text-xs" title={title}>
              {title}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            {meta}
            {badges}
          </span>
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open #${number} on GitHub`}
          title="Open on GitHub"
          // Dragging a link is the browser's own gesture and would replace ours.
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <ExternalLinkIcon className="size-3" />
        </a>
      </div>
    </PanelRow>
  );
}

function IssueRow({ issue }: { issue: GitHubIssue }) {
  return (
    <ForgeRow
      icon={<CircleDotIcon className="size-3.5" />}
      number={issue.number}
      title={issue.title}
      url={issue.url}
      meta={`${issue.author ? `${issue.author} · ` : ""}${fmtAgo(issue.updatedAt)}`}
      badges={issue.labels.slice(0, 3).map((label) => (
        <Badge key={label.name} variant="outline" className="px-1 py-0 text-[9px] font-normal">
          {label.name}
        </Badge>
      ))}
      onDrag={(transfer) => startReferenceDrag(transfer, issueReference(issue))}
    />
  );
}

function PullRow({ pull, mine }: { pull: GitHubPullRequest; mine: boolean }) {
  return (
    <ForgeRow
      icon={<GitPullRequestIcon className={cn("size-3.5", mine && "text-primary")} />}
      number={pull.number}
      title={pull.title}
      url={pull.url}
      meta={`${pull.author ? `${pull.author} · ` : ""}${fmtAgo(pull.updatedAt)}`}
      badges={
        <>
          {/* The one badge worth the width on a session's panel: this pull
              request is FOR THE BRANCH THIS SESSION IS ON. */}
          {mine && (
            <Badge variant="secondary" className="px-1 py-0 text-[9px] font-normal">
              this session
            </Badge>
          )}
          {pull.isDraft && (
            <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal">
              draft
            </Badge>
          )}
          {pull.reviewDecision === "APPROVED" && (
            <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal text-success">
              approved
            </Badge>
          )}
          {pull.reviewDecision === "CHANGES_REQUESTED" && (
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
}: {
  kind: "issues" | "pulls";
  projectId?: string;
  branch?: string;
}) {
  const [snapshot, setSnapshot] = useState<GitHubSnapshot>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (force = false) => {
      if (!projectId) return;
      try {
        setSnapshot((await api.projectGitHub(projectId, force ? { refresh: true } : {})).github);
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof VNextApiError ? cause.message : "The engine did not answer.");
      }
    },
    [projectId],
  );

  useEffect(() => {
    // ONCE, ON OPEN. No interval: this is somebody else's rate limit, and a
    // panel left open on a second monitor must not spend it.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const label = kind === "issues" ? "issues" : "pull requests";

  if (error) {
    return (
      <PanelEmpty icon={kind === "issues" ? <CircleDotIcon /> : <GitPullRequestIcon />} title="Could not read GitHub">
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
      <PanelEmpty icon={kind === "issues" ? <CircleDotIcon /> : <GitPullRequestIcon />} title={reason.title}>
        {reason.detail || snapshot.message || "gh exited without an explanation."}
      </PanelEmpty>
    );
  }

  const rows = kind === "issues" ? snapshot.issues : snapshot.pulls;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {rows.length === 0 ? `No open ${label}` : `${rows.length} open ${rows.length === 1 ? label.replace(/s$/, "") : label}`}
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
        <p className="px-4 py-6 text-center text-[11px] text-muted-foreground">
          Nothing open. Closed {label} are not listed — this is a working set, not an archive.
        </p>
      ) : (
        <>
          <div className="flex flex-col group">
            {kind === "issues"
              ? snapshot.issues.map((issue) => <IssueRow key={issue.number} issue={issue} />)
              : snapshot.pulls.map((pull) => (
                  <PullRow key={pull.number} pull={pull} mine={Boolean(branch) && pull.headRefName === branch} />
                ))}
          </div>
          <p className="px-4 py-2 text-[11px] leading-snug text-muted-foreground">
            Drag any row into the message to reference it. What lands in the box is exactly what the agent gets.
          </p>
        </>
      )}
    </div>
  );
}
