"use client";

import { CircleDotIcon, ExternalLinkIcon, GitPullRequestIcon, RotateCwIcon } from "lucide-react";
import type { GitHubLink } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { issueReference, pullReference, startReferenceDrag } from "@/lib/drag-reference";
import { createEngineApi } from "@/platform/engine";
import { buildForgeTimeline, issueStatus, pullStatus, STATUS_LABEL, STATUS_TONE, UNAVAILABLE, type ForgeStatus } from "../github-forge";
import { cn } from "@/lib/utils";
import { useForgeDetail } from "../hooks/use-forge-detail";
import { ChecksBlock } from "./checks-block";
import { EntryCard, Timeline } from "./entry-card";
import { ForgeFacts } from "./forge-facts";
import { MergeFooter } from "./merge-footer";
import type { ReactHandler } from "./reactions";
import { ReviewThreadsBlock } from "./review-threads";

const api = createEngineApi();

const TONE_CLASS: Record<(typeof STATUS_TONE)[ForgeStatus], string> = {
  active: "text-primary border-primary/40",
  done: "text-success border-success/40",
  info: "text-info border-info/40",
  none: "text-muted-foreground",
};

function ForgeHeader({
  icon,
  number,
  title,
  url,
  status,
  onRefresh,
  refreshing,
  onDrag,
}: {
  icon: React.ReactNode;
  number: number;
  title: string;
  url: string;
  status: ForgeStatus;
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
        <Badge variant="outline" className={cn("mt-1 px-1 py-0 text-4xs font-normal", TONE_CLASS[STATUS_TONE[status]])}>
          {STATUS_LABEL[status]}
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
        draggable={false}
        className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ExternalLinkIcon className="size-3" />
      </a>
    </div>
  );
}

/** One issue or pull request: header, facts, thread, review threads, checks, and the merge footer. */
export function ForgeDetailSurface({
  kind,
  number,
  projectId,
  branch,
  onOpenForge,
}: {
  kind: "issue" | "pull";
  number: number;
  projectId?: string;
  branch?: string;
  onOpenForge?: (kind: "issue" | "pull", number: number) => void;
}) {
  const { issue, pull, setPull, absent, error, refreshing, refresh } = useForgeDetail({ kind, number, projectId });
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
  const timeline = buildForgeTimeline({
    body: thing.body,
    ...(thing.author ? { author: thing.author } : {}),
    ...(thing.authorAvatar ? { authorAvatar: thing.authorAvatar } : {}),
    createdAt: thing.createdAt,
    comments: thing.comments,
    ...(pull ? { reviews: pull.reviews } : {}),
    ...(thing.reactions ? { reactions: thing.reactions } : {}),
    ...(thing.subjectId ? { subjectId: thing.subjectId } : {}),
  });
  const react: ReactHandler = (subjectId, content, add) => api.reactOnProjectForge(projectId, kind, thing.number, { subjectId, content, react: add });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ForgeHeader
        icon={<Icon className="size-3.5" />}
        number={thing.number}
        title={thing.title}
        url={thing.url}
        status={issue ? issueStatus(issue) : pullStatus(pull!)}
        onRefresh={refresh}
        refreshing={refreshing}
        onDrag={(transfer) => startReferenceDrag(transfer, kind === "issue" ? issueReference(thing) : pullReference(thing))}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ForgeFacts
          thing={thing}
          {...(pull ? { pull } : {})}
          mine={mine}
          {...(onOpenForge ? { onOpenLinked: (link: GitHubLink) => onOpenForge(kind === "issue" ? "pull" : "issue", link.number) } : {})}
        />
        <div className="flex flex-col border-t border-border px-3 py-2.5">
          <EntryCard entry={timeline[0]!} onReact={react} />
        </div>
        <Timeline entries={timeline} older={thing.olderComments} onReact={react} />
        {pull && (
          <ReviewThreadsBlock
            threads={pull.reviewThreads}
            more={pull.moreReviewThreads ?? 0}
            onReact={react}
            actions={{
              reply: (threadId, body) => api.replyToProjectThread(projectId, pull.number, threadId, body),
              resolve: (threadId, resolved) => api.resolveProjectThread(projectId, pull.number, threadId, resolved),
            }}
          />
        )}
        {pull && <ChecksBlock checks={pull.checks} projectId={projectId} />}
      </div>
      {pull && <MergeFooter pull={pull} projectId={projectId} onMerged={setPull} onReread={refresh} />}
    </div>
  );
}
