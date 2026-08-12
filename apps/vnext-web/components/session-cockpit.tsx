"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotIcon, ChevronRightIcon, FolderIcon, GitBranchIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import {
  displayToolName,
  type EngineEvent,
  type EngineRequest,
  type Item,
  type RuntimeMode,
  type Session,
  type Task,
  type Turn,
  type TurnState,
} from "@telar/engine-client";
import { createVNextApi, newVNextRunId, retryAmbiguousTurn, VNextApiError } from "@/lib/vnext/client";
import { appendJournalEvents, isActiveTurn, itemText, projectJournal, type JournalTurn } from "@/lib/vnext/journal";
import { hydrateVNextSession, tailVNextSession } from "@/lib/vnext/session-sync";
import { Composer } from "./composer";
import { ActivityGroup, Marker, TranscriptItem, WorkingIndicator } from "./transcript";
import { VNextRightPanel } from "./right-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConversationContent, ConversationScrollButton, ConversationViewport } from "@/components/ui/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ui/message";

const api = createVNextApi();
const terminal: Record<Exclude<TurnState, "queued" | "claimed" | "running">, string> = {
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  ambiguous: "Needs recovery decision",
  discarded: "Discarded after recovery decision",
};

export function describeTurnState(state: TurnState): { label: string; tone: "active" | "done" | "attention" | "danger" | "muted" } {
  if (state === "queued") return { label: "Queued", tone: "active" };
  if (state === "claimed") return { label: "Claimed", tone: "active" };
  if (state === "running") return { label: "Streaming", tone: "active" };
  if (state === "completed") return { label: terminal.completed, tone: "done" };
  if (state === "failed") return { label: terminal.failed, tone: "danger" };
  if (state === "ambiguous") return { label: terminal.ambiguous, tone: "attention" };
  if (state === "stopped") return { label: terminal.stopped, tone: "muted" };
  return { label: terminal.discarded, tone: "muted" };
}

function SessionProblem({ error }: { error: VNextApiError }) {
  const unavailable = error.code === "engine_unavailable" || error.code === "engine_locked";
  return (
    <Alert variant="destructive" className="mx-auto max-w-[50rem]">
      <TriangleAlertIcon />
      <AlertTitle>{unavailable ? "Engine unavailable" : "Request failed"}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

/**
 * The masthead is a BREADCRUMB, not a title bar.
 *
 * It carries identity and nothing else: no model, no cost, no working indicator.
 * A running turn is announced at the TAIL of the transcript where the work is,
 * so the eye has one place to look rather than two that can disagree.
 */
function SessionMasthead({
  projectId,
  session,
  sending,
  onRename,
  panel,
}: {
  projectId: string;
  session?: Session;
  sending: boolean;
  onRename: (title: string) => void;
  /** The session panel's trigger. Passed in rather than constructed here so the
   *  masthead stays identity-only and does not acquire the session record's
   *  items, tasks, turns and events just to hand them straight through. */
  panel: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const title = session?.title ?? "Session";

  const commit = () => {
    setEditing(false);
    const next = draftTitle.trim();
    // Empty or unchanged is a silent cancel, not an error and not a write.
    if (next && next !== title) onRename(next.slice(0, 120));
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3 text-sm">
      <Button variant="ghost" size="icon-sm" aria-label="Back to projects" render={<Link href="/" />}>
        <FolderIcon className="size-4" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="shrink-0 truncate text-muted-foreground">{session?.projectId ?? projectId}</span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
        {editing ? (
          <input
            className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm font-medium outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label="Session title"
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <>
            <strong className="min-w-0 truncate font-medium" title={title}>
              {title}
            </strong>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Rename session"
              disabled={!session || sending}
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/masthead:opacity-100 hover:opacity-100"
              onClick={() => {
                setDraftTitle(title);
                setEditing(true);
              }}
            >
              <PencilIcon className="size-3.5" />
            </Button>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* What this session IS, at a glance: which provider runs it, and
            whether it has a checkout of its own or shares the project's. */}
        {session && (
          <Badge variant="secondary" className="gap-1 font-normal">
            <BotIcon className="size-3" />
            {session.driver === "codex" ? "Codex" : "Claude"}
          </Badge>
        )}
        {session?.workspace.mode === "worktree" && (
          <Badge variant="outline" className="gap-1 font-normal" title={`Worktree on ${session.workspace.branch}`}>
            <GitBranchIcon className="size-3" />
            {session.workspace.branch}
          </Badge>
        )}
        {panel}
      </div>
    </header>
  );
}

function RecoveryActions({ sending, onRetry, onDiscard }: { sending: boolean; onRetry: () => void; onDiscard: () => void }) {
  return (
    <Alert className="mt-2" aria-label="Recovered turn decision">
      <TriangleAlertIcon />
      <AlertTitle>Recovered work needs your decision</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>This run may have reached the provider before recovery. Retrying first records a discard and creates a new run.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={sending} onClick={onRetry}>
            Retry as new run
          </Button>
          <Button size="sm" variant="ghost" disabled={sending} onClick={onDiscard}>
            Discard recovered run
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/**
 * A price, at a precision that matches its size.
 *
 * A flat four decimals prints `$0.4210` — a trailing zero that reads as spurious
 * accuracy on a figure whose last digit does not matter. Sub-cent runs still
 * need the digits, so the precision scales instead of being fixed.
 */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** The journal separates the submitted prompt from streamed agent output. */
export function retryInputForJournalTurn(turn: Pick<JournalTurn, "runId" | "state" | "prompt">): Pick<Turn, "runId" | "state" | "input"> {
  return { runId: turn.runId, state: turn.state, input: turn.prompt };
}

/** The one-liner an approval card leads with, per request kind. */
function requestSummary(detail: EngineRequest["detail"]): { label: string; body?: string } {
  switch (detail.kind) {
    case "command_execution":
      return { label: "wants to run a command", body: detail.command.command };
    case "file_change":
      return { label: `wants to ${detail.change.kind} a file`, body: detail.change.path };
    case "file_read":
      return { label: "wants to read a file", body: detail.read.path };
    case "tool_call":
      // `wants to use browser_click`, not `mcp__telar__browser_click`. The
      // qualified name is addressing; a human being asked to permit something
      // should read the verb.
      return { label: `wants to use ${displayToolName(detail.call.name)}`, body: undefined };
    case "user_input":
      return { label: "is asking you something", body: detail.prompt };
  }
}

/**
 * A parked approval.
 *
 * SHOWN AT THE TOP OF THE TURN, not inline in the timeline, because it is the
 * one thing blocking progress — everything below it has already happened and
 * nothing more will happen until this is answered.
 *
 * --warning, the app's one "a person has to move" colour. Not --destructive: an
 * approval is a question, not a failure.
 */
function ApprovalCard({
  request,
  sending,
  onDecide,
}: {
  request: EngineRequest;
  sending: boolean;
  onDecide: (requestId: string, decision: "accept" | "acceptForSession" | "decline") => void;
}) {
  const summary = requestSummary(request.detail);
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3" aria-label="Approval required">
      <p className="text-sm font-medium">Telar {summary.label}</p>
      {summary.body && (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] break-words whitespace-pre-wrap">
          {summary.body}
        </pre>
      )}
      {request.notified === false && (
        <p className="text-xs text-muted-foreground">This parked while nothing was watching, and no notification was sent.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={sending} onClick={() => onDecide(request.id, "accept")}>
          Allow once
        </Button>
        <Button size="sm" variant="outline" disabled={sending} onClick={() => onDecide(request.id, "acceptForSession")}>
          Allow for session
        </Button>
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => onDecide(request.id, "decline")}>
          Decline
        </Button>
      </div>
    </section>
  );
}

function SessionTurn({
  turn,
  requests,
  sending,
  live,
  now,
  onDecide,
  onRetry,
  onDiscard,
}: {
  requests: EngineRequest[];
  onDecide: (requestId: string, decision: "accept" | "acceptForSession" | "decline") => void;
  turn: JournalTurn;
  sending: boolean;
  /** This turn is the one currently executing. Drives the live step window. */
  live: boolean;
  now: number;
  onRetry: (turn: Pick<Turn, "runId" | "state" | "input">) => void;
  onDiscard: (turn: Pick<Turn, "runId">) => void;
}) {
  /**
   * THE CLOSING PROSE IS SEPARATED FROM THE WORK.
   *
   * A settled turn shows its answer and folds everything that produced it, so
   * history reads as conclusions. The split point is the LAST assistant message:
   * everything before it is activity, and narration in the middle folds with the
   * work it narrates rather than stranding itself above the fold.
   */
  const lastProse = turn.items.map((item) => item.detail.type).lastIndexOf("assistant_message");
  const activity = lastProse === -1 ? turn.items : turn.items.slice(0, lastProse);
  const closing = lastProse === -1 ? [] : turn.items.slice(lastProse);
  const streamedAnswer = closing.some((item) => itemText(item));

  return (
    <div className="flex flex-col gap-8">
      <Message from="user">
        <MessageContent>
          <p className="whitespace-pre-wrap">{turn.prompt}</p>
        </MessageContent>
      </Message>

      <Message from="assistant">
        <MessageContent>
          {requests.map((request) => (
            <ApprovalCard key={request.id} request={request} sending={sending} onDecide={onDecide} />
          ))}
          <ActivityGroup items={activity} tasks={turn.tasks} live={live} />
          {closing.map((item) => (
            <TranscriptItem key={item.id} item={item} />
          ))}
          {!streamedAnswer && turn.resultText && <MessageResponse>{turn.resultText}</MessageResponse>}
          {turn.failure && <Marker attention>{turn.failure}</Marker>}
          {turn.state === "stopped" && <Marker>stopped — kept what arrived</Marker>}
          {turn.state === "discarded" && <Marker>{describeTurnState(turn.state).label.toLowerCase()}</Marker>}
          {live && (
            <WorkingIndicator
              label={turn.items.some((item) => item.status === "inProgress") ? "Working" : "Thinking"}
              startedAt={turn.startedAt}
              now={now}
            />
          )}
          {turn.usage && !live && (
            <p className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
              {(turn.usage.tokens.input + turn.usage.tokens.output).toLocaleString()} tokens
              {typeof turn.usage.costUsd === "number" && ` · ${formatCost(turn.usage.costUsd)}`}
            </p>
          )}
          {turn.state === "ambiguous" && (
            <RecoveryActions sending={sending} onRetry={() => onRetry(retryInputForJournalTurn(turn))} onDiscard={() => onDiscard(turn)} />
          )}
        </MessageContent>
      </Message>
    </div>
  );
}

function EmptyTranscript({ loading }: { loading: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 py-16 text-center">
      <p className="text-sm font-medium">{loading ? "Hydrating transcript…" : "Ready for its first turn"}</p>
      <p className="text-sm text-muted-foreground">
        {loading ? "Reading the durable journal from the engine." : "Ask for changes, or explore the project."}
      </p>
    </div>
  );
}

export function SessionCockpit({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [session, setSession] = useState<Session>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [requests, setRequests] = useState<EngineRequest[]>([]);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [draftRunId, setDraftRunId] = useState<string>();
  const [error, setError] = useState<VNextApiError>();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const cursor = useRef(0);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());

  const enqueueSync = useCallback((operation: () => Promise<void>) => {
    const next = syncQueue.current.then(operation, operation);
    syncQueue.current = next.catch(() => undefined);
    return next;
  }, []);
  const hydrate = useCallback(
    () =>
      enqueueSync(async () => {
        const hydrated = await hydrateVNextSession(api, sessionId);
        setSession(hydrated.session);
        setTurns(hydrated.turns);
        setItems(hydrated.items);
        setTasks(hydrated.tasks);
        setRequests(hydrated.requests);
        setEvents(hydrated.events);
        cursor.current = hydrated.cursor;
      }),
    [enqueueSync, sessionId],
  );
  const tail = useCallback(
    () =>
      enqueueSync(async () => {
        const update = await tailVNextSession(api, sessionId, cursor.current);
        if (update.events.length === 0) return;
        cursor.current = update.cursor;
        setEvents((current) => appendJournalEvents(current, update.events));
        if (update.snapshot) {
          setSession(update.snapshot.session);
          setTurns(update.snapshot.turns);
          setItems(update.snapshot.items);
          setTasks(update.snapshot.tasks);
          setRequests(update.snapshot.requests);
        }
      }),
    [enqueueSync, sessionId],
  );

  useEffect(() => {
    let cancelled = false;
    void hydrate()
      .then(
        () => !cancelled && setError(undefined),
        (cause) => !cancelled && setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not hydrate this session.")),
      )
      .finally(() => !cancelled && setLoading(false));
    const interval = window.setInterval(() => {
      void tail().catch(
        (cause) => !cancelled && setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not tail the session journal.")),
      );
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hydrate, tail]);

  const transcript = useMemo(() => projectJournal(turns, items, events, tasks), [turns, items, events, tasks]);
  /**
   * The turn actually EXECUTING, which is not simply the first active one now
   * that a backlog can exist: `queued` turns are also "active" by the contract's
   * reckoning, and treating one of those as live would put the working indicator
   * and the live step window on a turn that has not started.
   */
  const active =
    transcript.find((turn) => turn.state === "claimed" || turn.state === "running") ?? transcript.find((turn) => isActiveTurn(turn.state));
  const running = Boolean(transcript.find((turn) => turn.state === "claimed" || turn.state === "running"));
  /** Everything typed but not yet started, oldest first — the pending strip. */
  const queued = useMemo(
    () => transcript.filter((turn) => turn.state === "queued").map((turn) => ({ runId: turn.runId, text: turn.prompt })),
    [transcript],
  );

  // A clock, only while something is running. An always-on interval re-renders a
  // settled transcript once a second for nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  // Only OPEN requests are actionable; resolved ones are history and live in the
  // journal rather than as a card demanding a second answer.
  const openRequests = useMemo(() => requests.filter((request) => request.state === "open"), [requests]);

  const stop = async () => {
    if (!active) return;
    setSending(true);
    try {
      await api.stopTurn(sessionId, active.runId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not stop the turn."));
    } finally {
      setSending(false);
    }
  };
  const decideRequest = async (requestId: string, decision: "accept" | "acceptForSession" | "decline") => {
    setSending(true);
    try {
      await api.resolveRequest(sessionId, requestId, { decision });
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not answer the approval."));
    } finally {
      setSending(false);
    }
  };
  const discardAmbiguous = async (turn: Pick<Turn, "runId">) => {
    setSending(true);
    try {
      await api.discardAmbiguousTurn(sessionId, turn.runId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not discard the ambiguous turn."));
    } finally {
      setSending(false);
    }
  };
  const retryAmbiguous = async (turn: Pick<Turn, "runId" | "state" | "input">) => {
    setSending(true);
    try {
      await retryAmbiguousTurn(api, sessionId, turn);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      // Retrying durably records a discard first. If only its new submission
      // failed, refresh so the UI does not imply the prior run remains live.
      try {
        await hydrate();
      } catch {
        /* Preserve the original request error. */
      }
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not retry the ambiguous turn."));
    } finally {
      setSending(false);
    }
  };
  const submit = async () => {
    if (!draft.trim()) return;
    const runId = draftRunId ?? newVNextRunId();
    setDraftRunId(runId);
    setSending(true);
    // Cleared OPTIMISTICALLY and before the round trip: the box emptying is the
    // acknowledgement, and waiting on the network to give it back is the thing
    // that makes queueing feel like a form submission.
    const text = draft.trim();
    setDraft("");
    setDraftRunId(undefined);
    try {
      await api.submitTurn(sessionId, { runId, input: text });
      await hydrate();
      setError(undefined);
    } catch (cause) {
      // Give the words back. Losing a typed message to a failed POST is
      // unforgivable in a way that a visible error is not.
      setDraft(text);
      setDraftRunId(runId);
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not submit the turn."));
    } finally {
      setSending(false);
    }
  };
  const withdraw = async (runId: string) => {
    setSending(true);
    try {
      await api.stopTurn(sessionId, runId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not withdraw the queued message."));
    } finally {
      setSending(false);
    }
  };
  const rename = async (nextTitle: string) => {
    try {
      const next = await api.updateSession(sessionId, { title: nextTitle });
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not rename the session."));
    }
  };
  const setRuntimeMode = async (mode: RuntimeMode) => {
    // Not gated on `sending`: this is the brake, and a brake you cannot reach
    // while the thing is moving is not a brake.
    try {
      const next = await api.updateSession(sessionId, { runtimeMode: mode });
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not change the runtime mode."));
    }
  };

  const shown = transcript.filter((turn) => turn.state !== "queued");

  return (
    <main className="group/masthead flex min-h-0 flex-1 flex-col">
      <SessionMasthead
        projectId={projectId}
        session={session}
        sending={sending}
        onRename={(next) => void rename(next)}
        panel={
          <VNextRightPanel
            projectId={session?.projectId ?? projectId}
            sessionId={sessionId}
            active={active?.state}
            items={items}
            tasks={tasks}
            turns={turns}
            events={events}
          />
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConversationViewport className="min-w-0 flex-1">
          <ConversationContent>
            {projectId !== session?.projectId && session && (
              <Alert variant="destructive" className="mx-auto max-w-[50rem]">
                <TriangleAlertIcon />
                <AlertDescription>This URL’s project does not match the engine-owned session record.</AlertDescription>
              </Alert>
            )}
            {error && <SessionProblem error={error} />}
            {!error && shown.length === 0 && <EmptyTranscript loading={loading} />}
            {shown.map((turn) => (
              <SessionTurn
                key={turn.runId}
                turn={turn}
                live={turn.runId === active?.runId}
                now={now}
                requests={openRequests.filter((request) => request.runId === turn.runId)}
                sending={sending}
                onDecide={(requestId, decision) => void decideRequest(requestId, decision)}
                onRetry={(item) => void retryAmbiguous(item)}
                onDiscard={(item) => void discardAmbiguous(item)}
              />
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </ConversationViewport>
        <Composer
          draft={draft}
          ready={Boolean(session)}
          busy={Boolean(active)}
          sending={sending}
          queued={queued}
          runtimeMode={session?.runtimeMode}
          onDraftChange={(nextDraft) => {
            setDraft(nextDraft);
            setDraftRunId(undefined);
          }}
          onSubmit={() => void submit()}
          onStop={() => void stop()}
          onWithdraw={(runId) => void withdraw(runId)}
          onRuntimeMode={(mode) => void setRuntimeMode(mode)}
        />
      </div>
    </main>
  );
}
