"use client";

import { Fragment, type ReactNode } from "react";
import type { JournalTurn } from "@/platform/engine";
import { groupNotificationTurns } from "@/features/transcript";
import { planDispatches } from "../dispatch";
import { CohortFold, foldCohortTurns } from "./cohort-fold";
import { DispatchBlockView, type SessionDirectory } from "./dispatch-block";

/** Every turn, folded into cohorts, notification strips and one block per dispatch. */
export function TranscriptTurns({ turns, activeRunId, keep, renderTurn, directory, hostId, projectId }: {
  turns: readonly JournalTurn[];
  activeRunId?: string;
  keep: ReadonlySet<string>;
  /** `absorbed`: the turn's arrival is a line of a dispatch block, so it draws nothing of its own. */
  renderTurn: (turn: JournalTurn, absorbed: boolean) => ReactNode;
  directory: SessionDirectory;
  hostId?: string;
  projectId?: string;
}) {
  const { blocks, absorbed } = planDispatches(turns, activeRunId);
  const segments = foldCohortTurns(turns, { ...(activeRunId ? { activeRunId } : {}), keep });
  const row = (turn: JournalTurn) => {
    const block = blocks.get(turn.runId);
    return (
      <Fragment key={turn.runId}>
        {block && <DispatchBlockView block={block} directory={directory} {...(hostId ? { hostId } : {})} {...(projectId ? { projectId } : {})} />}
        {renderTurn(turn, absorbed.has(turn.runId))}
      </Fragment>
    );
  };
  return segments.map((segment) => {
    const rows = groupNotificationTurns(segment.turns, activeRunId).map((group) =>
      group.length === 1 ? (
        <Fragment key={group[0]!.runId}>{group.map(row)}</Fragment>
      ) : (
        <div key={group[0]!.runId} className="flex flex-col gap-0.5" data-notification-strip={group.length}>
          {group.map(row)}
        </div>
      ),
    );
    return segment.kind === "fold" ? (
      <CohortFold key={segment.turns[0]!.runId} turns={segment.turns} members={segment.members}>
        {rows}
      </CohortFold>
    ) : (
      <Fragment key={segment.turns[0]!.runId}>{rows}</Fragment>
    );
  });
}
