"use client";

import { Fragment, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { JournalTurn } from "@/platform/engine";
import { bareNotificationTurn, groupNotificationTurns, ROW, SessionTitles } from "@/features/transcript";
import { cn } from "@/ui/utils";
import { arrivalsFolded, type DispatchPlan } from "../dispatch";
import { CohortFold, foldCohortTurns } from "./cohort-fold";
import { DispatchBlockView, sessionTitle, type SessionDirectory } from "./dispatch-block";

export type TurnView = { absorbed: boolean; covered: boolean; peerTitle?: string };

function quiet(turn: JournalTurn): boolean {
  const detail = turn.notification;
  if (!detail || !bareNotificationTurn(turn) || turn.state !== "completed") return false;
  return ![detail, ...(detail.entries ?? [])].some((each) => each.kind === "request" || each.wakeKind === "request_opened" || each.intent === "blocker" || each.intent === "task" || each.wakeKind === "turn_failed");
}

function ArrivalStrip({ titles, children }: { titles: string[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const named = [...new Set(titles)];
  return (
    <div className="mx-auto flex w-full max-w-[50rem] flex-col gap-0.5" data-notification-strip={titles.length}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} className={cn(ROW, "text-muted-foreground hover:bg-muted/50")}>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 truncate">{`${titles.length} updates · ${named.join(", ")}`}</span>
      </button>
      {open && children}
    </div>
  );
}

export function TranscriptTurns({ turns, plan, activeRunId, keep, renderTurn, directory, hostId, projectId }: {
  turns: readonly JournalTurn[];
  plan: DispatchPlan;
  activeRunId?: string;
  keep: ReadonlySet<string>;
  renderTurn: (turn: JournalTurn, view: TurnView) => ReactNode;
  directory: SessionDirectory;
  hostId?: string;
  projectId?: string;
}) {
  const segments = foldCohortTurns(turns, { ...(activeRunId ? { activeRunId } : {}), keep });
  const titleOf = (turn: JournalTurn) => {
    const detail = turn.notification;
    if (!detail?.sessionId) return undefined;
    return sessionTitle(directory, detail.sessionId, detail.entries?.find((entry) => entry.sessionId === detail.sessionId)?.title);
  };
  const block = (turn: JournalTurn) => {
    const anchored = plan.blocks.get(turn.runId);
    return anchored && <DispatchBlockView key={`block_${turn.runId}`} block={anchored} directory={directory} {...(hostId ? { hostId } : {})} {...(projectId ? { projectId } : {})} />;
  };
  const view = (turn: JournalTurn): TurnView => {
    const peerTitle = titleOf(turn);
    return { absorbed: plan.absorbed.has(turn.runId), covered: plan.covered.has(turn.runId), ...(peerTitle ? { peerTitle } : {}) };
  };
  const row = (turn: JournalTurn, withBlock = true) => (
    <Fragment key={turn.runId}>
      {withBlock && block(turn)}
      {renderTurn(arrivalsFolded(turn, plan.hidden), view(turn))}
    </Fragment>
  );
  const rows = (group: readonly JournalTurn[], withBlock = true) => {
    const shown = group.filter((turn) => !plan.absorbed.has(turn.runId));
    if (shown.length > 1 && shown.every((turn) => quiet(turn) && turn.runId !== activeRunId)) {
      return (
        <Fragment key={group[0]!.runId}>
          {withBlock && group.map(block)}
          <ArrivalStrip titles={shown.map((turn) => titleOf(turn) ?? "Untitled session")}>{group.map((turn) => row(turn, false))}</ArrivalStrip>
        </Fragment>
      );
    }
    if (group.length === 1) return row(group[0]!, withBlock);
    return (
      <div key={group[0]!.runId} className="flex flex-col gap-0.5" data-notification-strip={group.length}>
        {group.map((turn) => row(turn, withBlock))}
      </div>
    );
  };
  const titles = (sessionId: string) => sessionTitle(directory, sessionId);
  const drawn = segments.map((segment) => {
    const groups = groupNotificationTurns(segment.turns, activeRunId);
    if (segment.kind === "turns") return <Fragment key={segment.turns[0]!.runId}>{groups.map((group) => rows(group))}</Fragment>;
    return (
      <Fragment key={segment.turns[0]!.runId}>
        {segment.turns.map(block)}
        <CohortFold turns={segment.turns} members={segment.members}>
          {groups.map((group) => rows(group, false))}
        </CohortFold>
      </Fragment>
    );
  });
  return <SessionTitles.Provider value={titles}>{drawn}</SessionTitles.Provider>;
}
