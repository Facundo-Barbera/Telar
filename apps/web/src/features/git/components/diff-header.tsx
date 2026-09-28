"use client";

import { GitBranchIcon, ListFilterIcon, RotateCwIcon, XIcon } from "lucide-react";
import type { GitRefEntry, SessionDiff } from "@telar/engine-client";
import type { DiffTab } from "@/lib/diff-scope";
import type { DiffTurn } from "@/lib/diff-turns";
import { cn } from "@/lib/utils";
import { DiffScopePicker } from "./diff-scope-picker";

/** The scope, the branch, the headline figure and what it answers, and the tab's filter field. */
export function DiffHeader({
  tab,
  onTabChange,
  hasSession,
  refs,
  turns,
  diff,
  fromGit,
  headline,
  note,
  trimmed,
  filesInAll,
  refreshing,
  onRefresh,
}: {
  tab: DiffTab;
  onTabChange?: (tab: DiffTab) => void;
  hasSession: boolean;
  refs: readonly GitRefEntry[] | undefined;
  turns: readonly DiffTurn[] | undefined;
  diff: SessionDiff;
  fromGit: boolean;
  headline: string;
  note: string;
  trimmed: string | undefined;
  filesInAll: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="border-b border-border px-4 py-2.5">
      <div className="flex items-baseline gap-2 text-2xs">
        <DiffScopePicker
          tab={tab}
          {...(onTabChange ? { onTabChange } : {})}
          hasSession={hasSession}
          {...(refs ? { refs } : {})}
          {...(turns ? { turns } : {})}
          sessionBase={diff.base}
        />
        {diff.branch && tab.kind !== "turn" && (
          <>
            <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-mono">{diff.branch}</span>
          </>
        )}
        <button
          type="button"
          aria-label="Refresh the review"
          title="Refresh"
          onClick={onRefresh}
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
        </button>
      </div>
      <p className={cn("mt-1 text-sm font-medium tabular-nums", fromGit && diff.filesIncomplete && "text-warning")}>
        {headline}
        {fromGit && diff.filesIncomplete && <span className="ml-1.5 text-2xs font-normal">· incomplete</span>}
      </p>
      <p className="mt-0.5 text-2xs leading-snug text-muted-foreground">
        {note}
        {trimmed ? ` Filtered to ${trimmed} — ${filesInAll} ${filesInAll === 1 ? "file" : "files"} in all.` : ""}
        {fromGit && tab.kind !== "turn" && diff.ahead !== undefined && diff.ahead > 0 ? ` ${diff.ahead} ahead of upstream.` : ""}
        {fromGit && diff.truncated ? " The list below is capped; the figures above are not." : ""}
      </p>
      {onTabChange && <DiffFilterField tab={tab} onTabChange={onTabChange} />}
    </div>
  );
}

/** Writes the whole tab, never `{ filter }` alone: tab params are a replace, so a partial write would reset the scope. */
function DiffFilterField({ tab, onTabChange }: { tab: DiffTab; onTabChange: (tab: DiffTab) => void }) {
  return (
    <div className="mt-2 flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 focus-within:border-ring">
      <ListFilterIcon className="size-3 shrink-0 text-muted-foreground" />
      <input
        type="text"
        value={tab.filter ?? ""}
        onChange={(event) => onTabChange({ ...tab, filter: event.target.value })}
        placeholder="Filter by folder or file"
        aria-label="Filter this review by path"
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent font-mono text-2xs outline-none placeholder:font-sans placeholder:text-muted-foreground"
      />
      {tab.filter && (
        <button
          type="button"
          aria-label="Clear the filter"
          title="Clear the filter"
          onClick={() => onTabChange({ ...tab, filter: "" })}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}
