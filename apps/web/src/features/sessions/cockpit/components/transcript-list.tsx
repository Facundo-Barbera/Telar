"use client";

import { Fragment, type ComponentProps, type RefObject } from "react";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { workspacePath, type EngineRequest, type Session, type SnapshotPage } from "@telar/engine-client";
import type { EngineApiError, JournalTurn } from "@/platform/engine";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { ConversationContent, ConversationScrollButton, ConversationTopEdge, ConversationViewport, type ConversationFollowHandle } from "@/ui/conversation";
import { groupNotificationTurns, TranscriptWorkspace } from "@/features/transcript";
import { transcriptRows } from "../model";
import { CohortFold, foldCohortTurns } from "./cohort-fold";
import { SessionProblem } from "./masthead";
import { ReadReceiptMarker } from "./read-receipt";
import { EmptyTranscript, SessionTurn, TurnFrame } from "./session-turn";

type TurnProps = ComponentProps<typeof SessionTurn>;

/** The conversation: its banners, the earlier-turns edge, and every turn folded into cohorts and notification strips. */
export function TranscriptList(props: {
  conversation: string;
  landed: boolean;
  follow: RefObject<ConversationFollowHandle | null>;
  onAtBottomChange: (atBottom: boolean) => void;
  onConversationClick: (event: React.MouseEvent) => void;
  projectId: string | undefined;
  session: Session | undefined;
  stale: number | undefined;
  error: EngineApiError | undefined;
  fresh: boolean;
  loading: boolean;
  page: SnapshotPage | undefined;
  loadingOlder: boolean;
  loadOlder: () => void;
  transcript: JournalTurn[];
  active: JournalTurn | undefined;
  requests: EngineRequest[];
  openRequests: EngineRequest[];
  composerQuestion: EngineRequest | undefined;
  newestResultRunId: string | undefined;
  markerRefFor: (runId: string) => ComponentProps<typeof ReadReceiptMarker>["markerRef"];
  turn: Pick<TurnProps, "roster" | "sending" | "onInsert" | "onOpenAgent" | "onOpenTab" | "onOpenFile" | "onOpenFileInNewTab" | "onDecide" | "onRetry">;
  onResumeNow: (runId: string) => void;
}) {
  const { session, active, error, loadingOlder, loadOlder } = props;
  const { shown, hostOf } = transcriptRows(props.transcript);
  const hostRun = (request: EngineRequest) => hostOf.get(request.runId) ?? request.runId;
  // A cohort folds, except a turn with a request (open or decided) and the newest answer, whose marker must show.
  const segments = foldCohortTurns(shown, {
    ...(active ? { activeRunId: active.runId } : {}),
    keep: new Set([...props.requests.map(hostRun), ...(props.newestResultRunId ? [props.newestResultRunId] : [])]),
  });
  const turnRow = (turn: JournalTurn) => (
    <Fragment key={turn.runId}>
      <TurnFrame skippable={turn.runId !== active?.runId}>
        <SessionTurn
          turn={turn}
          live={turn.runId === active?.runId}
          requests={props.openRequests.filter((request) => hostRun(request) === turn.runId && request.id !== props.composerQuestion?.id)}
          {...props.turn}
          {...(turn.failureCode === "rate_limited" && turn.state === "failed" ? { onResumeNow: () => props.onResumeNow(turn.runId) } : {})}
        />
      </TurnFrame>
      {turn.runId === props.newestResultRunId && <ReadReceiptMarker markerRef={props.markerRefFor(turn.runId)} />}
    </Fragment>
  );
  return (
    // `display: contents`: a click boundary, never a layout box.
    <div className="contents" onClickCapture={props.onConversationClick}>
      <ConversationViewport className="min-w-0 flex-1" conversation={props.conversation} landed={props.landed} followRef={props.follow} onAtBottomChange={props.onAtBottomChange}>
        <ConversationContent>
          {props.projectId !== session?.projectId && session && (
            <Alert variant="destructive" className="mx-auto max-w-[50rem]">
              <TriangleAlertIcon />
              <AlertDescription>This URL’s project does not match the engine-owned session record.</AlertDescription>
            </Alert>
          )}
          {props.stale !== undefined ? (
            <Alert className="mx-auto max-w-[50rem]">
              <ClockIcon />
              <AlertTitle>Showing what was recorded at {new Date(props.stale).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</AlertTitle>
              <AlertDescription>The engine is not answering — reconnecting…</AlertDescription>
            </Alert>
          ) : (
            error && <SessionProblem error={error} />
          )}
          {/* A fresh canvas shows nothing here: the composer is the whole interface. */}
          {!error && !props.fresh && shown.length === 0 && <EmptyTranscript loading={props.loading} />}
          <ConversationTopEdge more={Boolean(props.page?.more)} loading={loadingOlder} onReach={loadOlder}>
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
