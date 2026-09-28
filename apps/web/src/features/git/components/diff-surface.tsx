"use client";

import { useCallback, useMemo, useState } from "react";
import { GitBranchIcon, HardDriveIcon } from "lucide-react";
import type { SessionDiff, TurnState } from "@telar/engine-client";
import { describeReview, reconcileReview, reviewFraming } from "../session-review";
import { diffBaseFor, type DiffScopeKind, type DiffTab } from "@/lib/diff-scope";
import { turnFor, turnLabel, type DiffTurn } from "@/lib/diff-turns";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { api } from "../api";
import { useDiffRead, useDiffRefresh } from "../hooks/use-diff-read";
import { useDiffView } from "../hooks/use-diff-view";
import { usePatchReader } from "../hooks/use-patch-reader";
import { useGitHubReady, useGitRefs } from "../hooks/use-repo-reads";
import { reviewUnderFilter, toggleOpen, turnNote, turnReview, type PatchWitness } from "../model";
import { CommitBox } from "./commit-box";
import { DiffHeader } from "./diff-header";
import { DiffToolbar } from "./diff-toolbar";
import { PublishBox } from "./publish-box";
import type { PullCommentContext } from "./pull-line-comment";
import { CommitList, DiffUnknownBand, ReconciliationBand, ReviewEmptyState, TurnEmptyState } from "./review-bands";
import { ReviewList } from "./review-list";

type DiffSurfaceProps = {
  sessionId?: string;
  /** Read when there is no session yet: a canvas reviews its project's uncommitted work. */
  projectId?: string;
  /** What the journal says this session wrote: path → how many times. */
  reported: ReadonlyMap<string, number>;
  /** The session title, as the default commit message and pull request title. */
  suggestion: string;
  active?: TurnState;
  /** This instance whole (scope, base, turn, filter), kept in the tab's params. Always rewrite it whole. */
  tab: DiffTab;
  /** Absent hides every control that would rewrite the tab. */
  onTabChange?: (tab: DiffTab) => void;
  /** Turns that reported writing something, newest first. */
  turns?: readonly DiffTurn[];
  onOpenFile?: (path: string) => void;
  onOpenInNewPanelTab?: (path: string) => void;
  onInsertReference?: (text: string) => void;
};

/** A review of what this session did to the repository: git's diff joined against the journal. */
export function DiffSurface({ sessionId, projectId, reported, suggestion, active, tab, onTabChange, turns, onOpenFile, onOpenInNewPanelTab, onInsertReference }: DiffSurfaceProps) {
  const [refreshing, setRefreshing] = useState(false);
  const { view, setView } = useDiffView();
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRow = useCallback((path: string) => setOpenPaths((current) => toggleOpen(current, path)), []);

  const turn = useMemo(() => turnFor(turns ?? [], tab.turn), [turns, tab.turn]);
  // Undefined only for a turn with no usable anchor, which keeps the journal as its witness.
  const base = diffBaseFor(tab, turn?.anchor);
  const fromGit = base !== undefined;
  const { diff, error, load } = useDiffRead(sessionId, projectId, base);
  const refs = useGitRefs(tab.kind, projectId);
  const publishable = Boolean(sessionId) && diff?.shared !== true && Boolean(diff?.branch);
  const github = useGitHubReady(publishable, projectId);

  const ahead = diff?.ahead;
  const pullComment = useMemo<PullCommentContext | undefined>(
    () =>
      sessionId && publishable && github === true
        ? {
            read: () => api.sessionPullAnchor(sessionId),
            scope: tab.kind,
            ...(ahead === undefined ? {} : { ahead }),
            send: (input) => api.commentOnSessionPullLine(sessionId, input),
          }
        : undefined,
    [sessionId, publishable, github, tab.kind, ahead],
  );
  const readPatch = usePatchReader({ sessionId, projectId, view, base, fromGit, kind: tab.kind, turn });
  useDiffRefresh(load, active);

  const review = useMemo(() => {
    if (tab.kind === "turn" && !fromGit) return turnReview(turn);
    return diff ? reconcileReview(diff, reported) : undefined;
  }, [tab.kind, fromGit, turn, diff, reported]);
  const shown = useMemo(() => (review ? reviewUnderFilter(review, tab.filter) : undefined), [review, tab.filter]);
  const trimmed = tab.filter?.trim() || undefined;

  const rowMenu = { ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {}), ...(onInsertReference ? { onInsertReference } : {}) };
  const witness: PatchWitness = tab.kind === "turn" ? "journal" : "git";
  const shownPaths = shown?.rows.map((row) => row.file.path) ?? [];
  const anyOpen = shownPaths.some((path) => openPaths.has(path));
  const toggleAll = () => setOpenPaths((current) => (shownPaths.some((path) => current.has(path)) ? new Set() : new Set(shownPaths)));

  const unreadable = unreadableState(sessionId, projectId, error, diff);
  if (unreadable) return unreadable;
  if (!diff || !review || !shown) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
        <Spinner className="size-3" /> reading the repository…
      </p>
    );
  }

  const framing = reviewFraming(diff, shown, Boolean(sessionId));
  const turnFraming = tab.kind === "turn" && turn ? { headline: `${describeReview(shown)} — ${turnLabel(turn)}`, note: turnNote(turn, diff) } : undefined;

  return (
    <div className="flex min-h-full flex-col">
      <DiffHeader
        tab={tab}
        {...(onTabChange ? { onTabChange } : {})}
        hasSession={Boolean(sessionId)}
        refs={refs}
        turns={turns}
        diff={diff}
        fromGit={fromGit}
        headline={turnFraming?.headline ?? framing.headline}
        note={turnFraming?.note ?? framing.note}
        trimmed={trimmed}
        filesInAll={review.filesChanged}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          void load().finally(() => setRefreshing(false));
        }}
      />
      <DiffToolbar view={view} setView={setView} anyOpen={anyOpen} onToggleAll={toggleAll} expandable={shownPaths.length > 0} />
      {fromGit && (
        <>
          <DiffUnknownBand diff={diff} onRetry={load} />
          {sessionId && <ReconciliationBand review={shown} journal={framing.journal} />}
          <CommitList commits={diff.commits} />
        </>
      )}
      {shown.rows.length === 0 ? (
        turnFraming ? (
          <TurnEmptyState noTurns={Boolean(turns && turns.length === 0)} trimmed={trimmed} />
        ) : (
          <ReviewEmptyState review={review} trimmed={trimmed} filesIncomplete={diff.filesIncomplete} />
        )
      ) : (
        <ReviewList
          shown={shown}
          journal={framing.journal}
          view={view}
          witness={witness}
          openPaths={openPaths}
          toggleRow={toggleRow}
          readPatch={readPatch}
          rowMenu={rowMenu}
          pullComment={pullComment}
        />
      )}
      <DiffFooter sessionId={sessionId} suggestion={suggestion} files={review.filesChanged} diff={diff} active={active} kind={tab.kind} github={github} onChanged={() => void load()} />
    </div>
  );
}

/** Unplugged drives and missing folders are checked before `repository`: git calls both "not a git repository". */
function unreadableState(sessionId: string | undefined, projectId: string | undefined, error: string | undefined, diff: SessionDiff | undefined) {
  if (!sessionId && !projectId) {
    return (
      <PanelEmpty icon={<GitBranchIcon />} title="No project">
        Nothing to review yet.
      </PanelEmpty>
    );
  }
  if (error) {
    return (
      <PanelEmpty icon={<GitBranchIcon />} title="Could not read the repository">
        {error}
      </PanelEmpty>
    );
  }
  if (diff?.availability === "unmounted") {
    return (
      <PanelEmpty icon={<HardDriveIcon />} title="The drive is not connected">
        This project lives on a drive that is not plugged in, so there is nothing to read — not nothing to review. Reconnect it and this comes back as it was.
      </PanelEmpty>
    );
  }
  if (diff?.availability === "missing") {
    return (
      <PanelEmpty icon={<HardDriveIcon />} title="The project folder is gone">
        {diff.workspacePath} is not on this machine any more.
      </PanelEmpty>
    );
  }
  if (diff && !diff.repository) {
    return (
      <PanelEmpty icon={<GitBranchIcon />} title="Not a git repository">
        No diff to review.
      </PanelEmpty>
    );
  }
  return undefined;
}

/**
 * The commit box counts the whole tree, not the filtered list. Publishing is only for a session's own
 * branch (`shared` is a local session in the project's checkout) and never from the turn scope.
 */
function DiffFooter({
  sessionId,
  suggestion,
  files,
  diff,
  active,
  kind,
  github,
  onChanged,
}: {
  sessionId: string | undefined;
  suggestion: string;
  files: number;
  diff: SessionDiff;
  active: TurnState | undefined;
  kind: DiffScopeKind;
  github: boolean | undefined;
  onChanged: () => void;
}) {
  const busy = active === "running" || active === "claimed";
  return (
    <div className="mt-auto">
      {sessionId ? (
        <>
          <CommitBox
            sessionId={sessionId}
            suggestion={suggestion}
            files={files}
            {...(diff.filesIncomplete ? { countIncomplete: true } : {})}
            busy={busy}
            workspacePath={diff.workspacePath}
            onCommitted={onChanged}
          />
          {diff.branch && diff.shared !== true && kind !== "turn" && (
            <PublishBox
              sendPush={() => api.pushSessionBranch(sessionId)}
              sendPullRequest={(input) => api.openSessionPullRequest(sessionId, input)}
              {...(github === undefined ? {} : { github })}
              branch={diff.branch}
              {...(diff.ahead === undefined ? {} : { ahead: diff.ahead })}
              commitsSinceBase={diff.commits.length}
              busy={busy}
              suggestion={suggestion}
              onPublished={onChanged}
            />
          )}
        </>
      ) : (
        <p className="border-t border-border p-3 text-2xs leading-snug text-muted-foreground">
          The project&rsquo;s own uncommitted work, before this conversation starts.
        </p>
      )}
    </div>
  );
}
