"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { CircleDotIcon, GitPullRequestIcon } from "lucide-react";
import type { GitHubIssue } from "@telar/engine-client";
import { emptyForge, openForge, type ForgeOpen } from "../forge-workspace";
import { cn } from "@/lib/utils";
import { useGitHubList } from "../hooks/use-github-list";
import { useIssueSession } from "../hooks/use-issue-session";
import type { ForgeListKind } from "../model";
import { ForgeList } from "./forge-list";
import { ForgeTabs } from "./forge-tabs";

const ForgeDetailSurface = dynamic(() => import("./github-detail-surface").then((mod) => mod.ForgeDetailSurface));

/** Issues or pull requests: a list plus a sub-strip of details opened from it. `open` is the panel-owned open set. */
export function GitHubSurface({
  kind,
  projectId,
  branch,
  open,
  onOpenChange,
  hostId,
  onInsertReference,
  onOpenForge,
}: {
  kind: ForgeListKind;
  projectId?: string;
  branch?: string;
  open?: ForgeOpen;
  onOpenChange?: (next: ForgeOpen) => void;
  hostId?: string;
  onInsertReference?: (text: string) => void;
  onOpenForge?: (kind: "issue" | "pull", number: number) => void;
}) {
  const forge = open ?? emptyForge();
  const detail = forge.at;
  const list = useGitHubList({ projectId, kind, showingDetail: detail !== undefined });
  const session = useIssueSession({
    ...(projectId ? { projectId } : {}),
    ...(hostId ? { hostId } : {}),
    ...(onInsertReference ? { onInsertReference } : {}),
  });
  const Icon = kind === "issues" ? CircleDotIcon : GitPullRequestIcon;
  const one = kind === "issues" ? "issue" : "pull";
  const change = (next: ForgeOpen) => onOpenChange?.(next);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {forge.numbers.length > 0 && <ForgeTabs kind={kind} icon={Icon} forge={forge} onChange={change} />}
      {/* The list scrolls here; a detail owns its height so its pinned merge footer stays on screen. */}
      <div className={cn("min-h-0 flex-1", detail === undefined ? "overflow-y-auto" : "overflow-hidden")}>
        {detail === undefined ? (
          <ForgeList
            kind={kind}
            label={kind === "issues" ? "issues" : "pull requests"}
            icon={Icon}
            list={list}
            openNumbers={forge.numbers}
            onOpen={(number) => change(openForge(forge, number))}
            {...(branch ? { branch } : {})}
            {...(session.refusal ? { refusal: session.refusal } : {})}
            {...(session.starting !== undefined ? { starting: session.starting } : {})}
            {...(projectId ? { onStart: (issue: GitHubIssue) => void session.start(issue) } : {})}
          />
        ) : (
          // `dynamic()` brings no boundary of its own; without this the first open suspends the panel.
          <Suspense fallback={null}>
            <ForgeDetailSurface
              key={detail}
              kind={one}
              number={detail}
              {...(projectId ? { projectId } : {})}
              {...(one === "pull" && branch ? { branch } : {})}
              {...(onOpenForge ? { onOpenForge } : {})}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
