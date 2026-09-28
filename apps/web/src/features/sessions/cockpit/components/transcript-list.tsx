"use client";

import { Fragment, type ComponentProps, type RefObject } from "react";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { workspacePath, type EngineRequest } from "@telar/engine-client";
import type { JournalTurn } from "@/platform/engine";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { ConversationContent, ConversationScrollButton, ConversationTopEdge, ConversationViewport, type ConversationFollowHandle } from "@/ui/conversation";
import { groupNotificationTurns, TranscriptWorkspace } from "@/features/transcript";
import type { useSessionSync } from "../hooks/use-session-sync";
import type { useTranscriptModel } from "../hooks/use-transcript-model";
import { transcriptRows } from "../model";
import { CohortFold, foldCohortTurns } from "./cohort-fold";
import { SessionProblem } from "./masthead";
import { ReadReceiptMarker, type useReadReceipt } from "./read-receipt";
import { EmptyTranscript, SessionTurn, TurnFrame } from "./session-turn";

type TurnProps = ComponentProps<typeof SessionTurn>;

/** The conversation: its banners, the earlier-turns edge, and every turn folded into cohorts and notification strips. */
export function TranscriptList({ sync, model, receipt, ...props }: {
  sync: ReturnType<typeof useSessionSync>;
  model: ReturnType<typeof useTranscriptModel>;
  receipt: ReturnType<typeof useReadReceipt>;
  follow: RefObject<ConversationFollowHandle | null>;
  onAtBottomChange: (atBottom: boolean) => void;
  onConversationClick: (event: React.MouseEvent) => void;
  projectId: string | undefined;
  fresh: boolean;
  turn: Pick<TurnProps, "roster" | "sending" | "onInsert" | "onOpenAgent" | "onOpenTab" | "onOpenFile" | "onOpenFileInNewTab" | "onDecide">;
  onResumeNow: (runId: string) => void;
}) {
  const { session, error, loadingOlder, loadOlder } = sync;
  const { active, openRequests, composerQuestion } = model;
  const newestResultRunId = receipt.newestResult?.runId;
  const { shown, hostOf } = transcriptRows(model.transcript);
  const hostRun = (request: EngineRequest) => hostOf.get(request.runId) ?? request.runId;
  // A cohort folds, except a turn with a request (open or decided) and the newest answer, whose marker must show.
  const segments = foldCohortTurns(shown, {
    ...(active ? { activeRunId: active.runId } : {}),
    keep: new Set([...sync.requests.map(hostRun), ...(newestResultRunId ? [newestResultRunId] : [])]),
  });
  const turnRow = (turn: JournalTurn) => (
    <Fragment key={turn.runId}>
      <TurnFrame skippable={turn.runId !== active?.runId}>
        <SessionTurn
          turn={turn}
          live={turn.runId === active?.runId}
          requests={openRequests.filter((request) => hostRun(request) === turn.runId && request.id !== composerQuestion?.id)}
          {...props.turn}
          {...(turn.failureCode === "rate_limited" && turn.state === "failed" ? { onResumeNow: () => props.onResumeNow(turn.runId) } : {})}
        />
      </TurnFrame>
      {turn.runId === newestResultRunId && <ReadReceiptMarker markerRef={receipt.markerRefFor(turn.runId)} />}
    </Fragment>
  );
  return (
    // `display: contents`: a click boundary, never a layout box.
    <div className="contents" onClickCapture={props.onConversationClick}>
      <ConversationViewport className="min-w-0 flex-1" conversation={sync.syncKey} landed={sync.transcriptLanded} followRef={props.follow} onAtBottomChange={props.onAtBottomChange}>
        <ConversationContent>
          {props.projectId !== session?.projectId && session && (
            <Alert variant="destructive" className="mx-auto max-w-[50rem]">
              <TriangleAlertIcon />
              <AlertDescription>This URL’s project does not match the engine-owned session record.</AlertDescription>
            </Alert>
          )}
          {sync.stale !== undefined ? (
            <Alert className="mx-auto max-w-[50rem]">
              <ClockIcon />
              <AlertTitle>Showing what was recorded at {new Date(sync.stale).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</AlertTitle>
              <AlertDescription>The engine is not answering — reconnecting…</AlertDescription>
            </Alert>
          ) : (
            error && <SessionProblem error={error} />
          )}
          {/* A fresh canvas shows nothing here: the composer is the whole interface. */}
          {!error && !props.fresh && shown.length === 0 && <EmptyTranscript loading={sync.loading} />}
          <ConversationTopEdge more={Boolean(sync.page?.more)} loading={loadingOlder} onReach={loadOlder}>
            <div className="mx-auto w-full max-w-[50rem]">
              <Button type="button" variant="ghost" className="text-muted-foreground" disabled={loadingOlder} onClick={loadOlder}>
                {loadingOlder ? "Loading earlier turns…" : "Load earlier turns"}
              </Button>
            </div>
          </ConversationTopEdge>
          <TranscriptWorkspace path={session ? workspacePath(session.workspace) : undefined}>
            {segments.map((segment) => {
              const rows = groupNotificationTurns(segment.turns, active?.runId).map((group) =>
                group.length === 1 ? (
                  <Fragment key={group[0]!.runId}>{group.map(turnRow)}</Fragment>
                ) : (
                  <div key={group[0]!.runId} className="flex flex-col gap-0.5" data-notification-strip={group.length}>
                    {group.map(turnRow)}
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
            })}
          </TranscriptWorkspace>
        </ConversationContent>
        <ConversationScrollButton />
      </ConversationViewport>
    </div>
  );
}
