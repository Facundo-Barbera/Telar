"use client";

import { RotateCwIcon, XIcon, type LucideIcon } from "lucide-react";
import type { GitHubIssue, GitHubSnapshot } from "@telar/engine-client";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { fmtAgo } from "@/lib/format";
import { filterChips, UNAVAILABLE } from "../github-forge";
import { cn } from "@/lib/utils";
import type { GitHubList } from "../hooks/use-github-list";
import { listCount, type ForgeListKind } from "../model";
import { FilterMenu } from "./filter-menu";
import { IssueRow, PullRow } from "./forge-row";

type ListProps = {
  kind: ForgeListKind;
  label: string;
  icon: LucideIcon;
  list: GitHubList;
  openNumbers: readonly number[];
  onOpen: (number: number) => void;
  branch?: string;
  refusal?: string;
  starting?: number;
  onStart?: (issue: GitHubIssue) => void;
};

function ListHeader({ kind, label, list, snapshot }: Pick<ListProps, "kind" | "label" | "list"> & { snapshot: GitHubSnapshot }) {
  const count = (kind === "issues" ? snapshot.issues : snapshot.pulls).length;
  return (
    <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-2xs text-muted-foreground">
      <FilterMenu kind={kind} label={label} list={list} />
      <span className="min-w-0 truncate">
        · {listCount(count, label)}
        {snapshot.repository ? ` in ${snapshot.repository}` : ""}
      </span>
      <span className="ml-auto shrink-0">{fmtAgo(snapshot.readAt)}</span>
      <button
        type="button"
        aria-label={`Refresh ${label}`}
        title="Ask gh again"
        onClick={list.refresh}
        className="shrink-0 rounded p-0.5 transition-colors hover:text-foreground"
      >
        <RotateCwIcon className={cn("size-3", list.refreshing && "animate-spin")} />
      </button>
    </div>
  );
}

function ListRows({ kind, snapshot, openNumbers, onOpen, branch, starting, onStart }: ListProps & { snapshot: GitHubSnapshot }) {
  const alreadyOpen = new Set(openNumbers);
  return (
    <div className="flex flex-col group">
      {kind === "issues"
        ? snapshot.issues.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              open={alreadyOpen.has(issue.number)}
              onOpen={() => onOpen(issue.number)}
              busy={starting === issue.number}
              {...(onStart ? { onStart: () => onStart(issue) } : {})}
            />
          ))
        : snapshot.pulls.map((pull) => (
            <PullRow
              key={pull.number}
              pull={pull}
              mine={Boolean(branch) && pull.headRefName === branch}
              open={alreadyOpen.has(pull.number)}
              onOpen={() => onOpen(pull.number)}
            />
          ))}
    </div>
  );
}

function ListFooter({ snapshot }: { snapshot: GitHubSnapshot }) {
  return (
    <>
      {snapshot.projectsUnavailable === "scope" && (
        <p className="border-t border-border px-4 py-2 text-2xs leading-snug text-muted-foreground">
          Boards are not shown: the gh token has no <span className="font-mono">read:project</span> scope. Run{" "}
          <span className="font-mono">gh auth refresh -s read:project</span> and press refresh.
        </p>
      )}
      {snapshot.projectsUnavailable === "failed" && (
        <p className="border-t border-border px-4 py-2 text-2xs leading-snug text-muted-foreground">Boards could not be read this time.</p>
      )}
      <p className="px-4 py-2 text-2xs leading-snug text-muted-foreground">Click a row to read it here; drag one into the message to reference it.</p>
    </>
  );
}

export function ForgeList(props: ListProps) {
  const { kind, label, icon: Icon, list, refusal } = props;
  const { snapshot, error } = list;
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
  // The filter the rows were read under, not the one being edited while a read is in flight.
  const shown = kind === "issues" ? snapshot.issueFilter : snapshot.pullFilter;
  const shownChips = filterChips(shown);

  return (
    <div className="flex flex-col">
      <ListHeader kind={kind} label={label} list={list} snapshot={snapshot} />
      {shownChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-1.5">
          {shownChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => list.clearChip(chip)}
              title={`Stop filtering by ${chip.label}`}
              className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border px-1.5 py-0 text-4xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-foreground"
            >
              <span className="truncate">{chip.label}</span>
              <XIcon className="size-2.5 shrink-0" />
            </button>
          ))}
        </div>
      )}
      {refusal && (
        <p className="tint-warning border-b border-border px-4 py-2 text-2xs leading-snug text-foreground" role="status">
          {refusal}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-2xs leading-snug text-muted-foreground">
          {shownChips.length > 0 ? "Nothing matches those filters." : shown.state === "open" ? "Nothing open." : `No ${label} in this repository match that.`}
        </p>
      ) : (
        <>
          <ListRows {...props} snapshot={snapshot} />
          <ListFooter snapshot={snapshot} />
        </>
      )}
    </div>
  );
}
