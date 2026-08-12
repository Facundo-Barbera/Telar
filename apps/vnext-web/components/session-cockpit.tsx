"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayToolName, type EngineEvent, type EngineRequest, type Item, type RuntimeMode, type Session, type Task, type Turn, type TurnState } from "@telar/engine-client";
import { createVNextApi, newVNextRunId, retryAmbiguousTurn, VNextApiError } from "@/lib/vnext/client";
import {
  appendJournalEvents,
  isActiveTurn,
  itemText,
  projectJournal,
  type JournalTurn,
} from "@/lib/vnext/journal";
import { hydrateVNextSession, tailVNextSession } from "@/lib/vnext/session-sync";
import { AgentMarkdown } from "./agent-markdown";
import { Composer } from "./composer";
import { ActivityGroup, Marker, TranscriptItem, WorkingIndicator } from "./transcript";
import { VNextRightPanel } from "./right-panel";
import { Icon } from "./vnext-icons";

const api = createVNextApi();
const terminal: Record<Exclude<TurnState, "queued" | "claimed" | "running">, string> = {
  completed: "Completed", failed: "Failed", stopped: "Stopped", ambiguous: "Needs recovery decision", discarded: "Discarded after recovery decision",
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
  return <div role="alert" className="vnext-alert"><strong>{unavailable ? "vNext engine unavailable. " : "vNext request failed. "}</strong>{error.message}</div>;
}

/**
 * The masthead is a BREADCRUMB, not a title bar.
 *
 * It carries identity and nothing else: no model, no cost, no working
 * indicator. The frozen app is emphatic about this and it is right — a running
 * turn is announced at the tail of the transcript where the work is, so the eye
 * has one place to look rather than two that can disagree.
 */
function SessionMasthead({ projectId, session, sessionId, sending, onRename }: {
  projectId: string;
  session?: Session;
  sessionId: string;
  sending: boolean;
  onRename: (title: string) => void;
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

  return <header className="vnext-session-heartbeat">
    <Link className="vnext-backlink" href="/" aria-label="Back to projects"><Icon name="folder" /></Link>
    <div className="vnext-session-heartbeat__identity">
      <span>{session?.projectId ?? projectId}</span><i>/</i>
      {editing
        ? <input
            className="vnext-title-input"
            aria-label="Session title"
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commit(); }
              if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
            }}
          />
        : <>
            <strong title={title}>{title}</strong>
            <button
              type="button"
              className="vnext-title-edit"
              aria-label="Rename session"
              disabled={!session || sending}
              onClick={() => { setDraftTitle(title); setEditing(true); }}
            ><Icon name="pencil" /></button>
          </>}
    </div>
    <div className="vnext-session-heartbeat__actions">
      {/* What this session IS, at a glance: which provider runs it, and whether
          it has a checkout of its own or shares the project's. */}
      {session && <span className="vnext-chip" title={session.workspace.mode === "worktree" ? `Worktree on ${session.workspace.branch}` : "Working in the project checkout"}>
        {session.driver === "codex" ? "Codex" : "Claude"}
        {session.workspace.mode === "worktree" && <i>worktree</i>}
      </span>}
      <VNextRightPanel projectId={session?.projectId ?? projectId} sessionId={sessionId} />
    </div>
  </header>;
}

function RecoveryActions({ sending, onRetry, onDiscard }: {
  sending: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return <section className="vnext-recovery" aria-label="Recovered turn decision">
    <div>
      <strong>Recovered work needs your decision</strong>
      <p>This run may have reached the provider before recovery. Retrying first records a discard and creates a new run.</p>
    </div>
    <div className="vnext-row">
      <button className="vnext-button vnext-button--secondary" type="button" disabled={sending} onClick={onRetry}>Retry as new run</button>
      <button className="vnext-button vnext-button--secondary" type="button" disabled={sending} onClick={onDiscard}>Discard recovered run</button>
    </div>
  </section>;
}

/**
 * A price, at a precision that matches its size.
 *
 * A flat four decimals prints `$0.4210` — a trailing zero that reads as
 * spurious accuracy on a figure whose last digit does not matter. Sub-cent runs
 * still need the digits, so the precision scales instead of being fixed.
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
      // `wants to use browser_click`, not `wants to use
      // mcp__telar__browser_click`. The qualified name is addressing; a human
      // being asked to permit something should read the verb.
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
 */
function ApprovalCard({ request, sending, onDecide }: {
  request: EngineRequest;
  sending: boolean;
  onDecide: (requestId: string, decision: "accept" | "acceptForSession" | "decline") => void;
}) {
  const summary = requestSummary(request.detail);
  return <section className="vnext-recovery" aria-label="Approval required">
    <div>
      <strong>Telar {summary.label}</strong>
      {summary.body && <pre className="vnext-tool-item__body">{summary.body}</pre>}
      {request.notified === false && (
        <p className="vnext-muted vnext-small">
          This parked while nothing was watching, and no notification was sent.
        </p>
      )}
    </div>
    <div className="vnext-row">
      <button className="vnext-button" type="button" disabled={sending} onClick={() => onDecide(request.id, "accept")}>Allow once</button>
      <button className="vnext-button vnext-button--secondary" type="button" disabled={sending} onClick={() => onDecide(request.id, "acceptForSession")}>Allow for session</button>
      <button className="vnext-button vnext-button--secondary" type="button" disabled={sending} onClick={() => onDecide(request.id, "decline")}>Decline</button>
    </div>
  </section>;
}

function SessionTurn({ turn, requests, sending, live, now, onDecide, onRetry, onDiscard }: {
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

  return <article className="vnext-turn">
    <p className="vnext-prompt">{turn.prompt}</p>
    {requests.map((request) => <ApprovalCard key={request.id} request={request} sending={sending} onDecide={onDecide} />)}
    <div className="vnext-answer">
      <ActivityGroup items={activity} tasks={turn.tasks} live={live} />
      {closing.map((item) => <TranscriptItem key={item.id} item={item} />)}
      {!streamedAnswer && turn.resultText && <AgentMarkdown text={turn.resultText} />}
      {turn.failure && <Marker text={turn.failure} tone="attention" />}
      {turn.state === "stopped" && <Marker text="Stopped — kept what arrived." />}
      {turn.state === "discarded" && <Marker text={describeTurnState(turn.state).label.toLowerCase()} />}
      {live && <WorkingIndicator label={turn.items.some((i) => i.status === "inProgress") ? "Working" : "Thinking"} startedAt={turn.startedAt} now={now} />}
      {turn.usage && !live && <p className="vnext-turn-usage">
        {(turn.usage.tokens.input + turn.usage.tokens.output).toLocaleString()} tokens
        {typeof turn.usage.costUsd === "number" && ` · ${formatCost(turn.usage.costUsd)}`}
      </p>}
    </div>
    {turn.state === "ambiguous" && <RecoveryActions sending={sending} onRetry={() => onRetry(retryInputForJournalTurn(turn))} onDiscard={() => onDiscard(turn)} />}
  </article>;
}

/**
 * Stick to the bottom while the reader is already there, and stop the moment
 * they scroll up. Yanking a reader back to the tail mid-stream is the fastest
 * way to make a long turn unreadable.
 */
function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stuck = useRef(true);

  const onScroll = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    // 40px of slack: a reader one line off the bottom still means "following".
    const bottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 40;
    stuck.current = bottom;
    setAtBottom(bottom);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [dependency]);

  const toBottom = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    stuck.current = true;
    setAtBottom(true);
  }, []);

  return { ref, atBottom, onScroll, toBottom };
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
  const hydrate = useCallback(() => enqueueSync(async () => {
    const hydrated = await hydrateVNextSession(api, sessionId);
    setSession(hydrated.session); setTurns(hydrated.turns); setItems(hydrated.items); setTasks(hydrated.tasks); setRequests(hydrated.requests); setEvents(hydrated.events); cursor.current = hydrated.cursor;
  }), [enqueueSync, sessionId]);
  const tail = useCallback(() => enqueueSync(async () => {
    const update = await tailVNextSession(api, sessionId, cursor.current);
    if (update.events.length === 0) return;
    cursor.current = update.cursor;
    setEvents((current) => appendJournalEvents(current, update.events));
    if (update.snapshot) { setSession(update.snapshot.session); setTurns(update.snapshot.turns); setItems(update.snapshot.items); setTasks(update.snapshot.tasks); setRequests(update.snapshot.requests); }
  }), [enqueueSync, sessionId]);

  useEffect(() => {
    let cancelled = false;
    void hydrate().then(() => !cancelled && setError(undefined), (cause) => !cancelled && setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not hydrate this session."))).finally(() => !cancelled && setLoading(false));
    const interval = window.setInterval(() => { void tail().catch((cause) => !cancelled && setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not tail the session journal."))); }, 1_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [hydrate, tail]);

  const transcript = useMemo(() => projectJournal(turns, items, events, tasks), [turns, items, events, tasks]);
  /**
   * The turn actually EXECUTING, which is not simply the first active one now
   * that a backlog can exist: `queued` turns are also "active" by the contract's
   * reckoning, and treating one of those as live would put the working
   * indicator and the live step window on a turn that has not started.
   */
  const active = transcript.find((turn) => turn.state === "claimed" || turn.state === "running")
    ?? transcript.find((turn) => isActiveTurn(turn.state));
  const running = Boolean(transcript.find((turn) => turn.state === "claimed" || turn.state === "running"));
  /** Everything typed but not yet started, oldest first — the pending strip. */
  const queued = useMemo(
    () => transcript.filter((turn) => turn.state === "queued").map((turn) => ({ runId: turn.runId, text: turn.prompt })),
    [transcript],
  );
  const { ref: scrollRef, atBottom, onScroll, toBottom } = useStickToBottom(transcript);

  // A clock, only while something is running. An always-on interval re-renders
  // a settled transcript once a second for nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    // The interval alone drives it. Seeding synchronously here is a cascading
    // render for at most one second of staleness in a seconds-resolution clock.
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  // Only OPEN requests are actionable; resolved ones are history and live in
  // the journal rather than as a card demanding a second answer.
  const openRequests = useMemo(() => requests.filter((request) => request.state === "open"), [requests]);
  const stop = async () => {
    if (!active) return;
    setSending(true);
    try { await api.stopTurn(sessionId, active.runId); await hydrate(); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not stop the turn.")); }
    finally { setSending(false); }
  };
  const decideRequest = async (requestId: string, decision: "accept" | "acceptForSession" | "decline") => {
    setSending(true);
    try { await api.resolveRequest(sessionId, requestId, { decision }); await hydrate(); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not answer the approval.")); }
    finally { setSending(false); }
  };
  const discardAmbiguous = async (turn: Pick<Turn, "runId">) => {
    setSending(true);
    try { await api.discardAmbiguousTurn(sessionId, turn.runId); await hydrate(); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not discard the ambiguous turn.")); }
    finally { setSending(false); }
  };
  const retryAmbiguous = async (turn: Pick<Turn, "runId" | "state" | "input">) => {
    setSending(true);
    try { await retryAmbiguousTurn(api, sessionId, turn); await hydrate(); setError(undefined); }
    catch (cause) {
      // Retrying durably records a discard first. If only its new submission
      // failed, refresh so the UI does not imply the prior run remains live.
      try { await hydrate(); } catch { /* Preserve the original request error. */ }
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not retry the ambiguous turn."));
    } finally { setSending(false); }
  };
  const submit = async () => {
    if (!draft.trim()) return;
    const runId = draftRunId ?? newVNextRunId(); setDraftRunId(runId); setSending(true);
    // Cleared OPTIMISTICALLY and before the round trip: the box emptying is the
    // acknowledgement, and waiting on the network to give it back is the thing
    // that makes queueing feel like a form submission.
    const text = draft.trim();
    setDraft(""); setDraftRunId(undefined);
    try { await api.submitTurn(sessionId, { runId, input: text }); await hydrate(); setError(undefined); }
    catch (cause) {
      // Give the words back. Losing a typed message to a failed POST is
      // unforgivable in a way that a visible error is not.
      setDraft(text); setDraftRunId(runId);
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not submit the turn."));
    }
    finally { setSending(false); }
  };
  const withdraw = async (runId: string) => {
    setSending(true);
    try { await api.stopTurn(sessionId, runId); await hydrate(); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not withdraw the queued message.")); }
    finally { setSending(false); }
  };
  const rename = async (nextTitle: string) => {
    try { const next = await api.updateSession(sessionId, { title: nextTitle }); setSession(next.session); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not rename the session.")); }
  };
  const setRuntimeMode = async (mode: RuntimeMode) => {
    // Not gated on `sending`: this is the brake, and a brake you cannot reach
    // while the thing is moving is not a brake.
    try { const next = await api.updateSession(sessionId, { runtimeMode: mode }); setSession(next.session); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not change the runtime mode.")); }
  };

  return <main className="vnext-session-workspace">
    <SessionMasthead projectId={projectId} session={session} sessionId={sessionId} sending={sending} onRename={(next) => void rename(next)} />
    <div className="vnext-conversation-column">
      <div className="vnext-transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="vnext-transcript__inner">
          {projectId !== session?.projectId && session && <p className="vnext-alert">This URL’s project does not match the engine-owned session record.</p>}
          {error && <SessionProblem error={error} />}
          {loading && <p className="vnext-empty-state">Hydrating durable transcript…</p>}
          {!loading && !error && transcript.length === 0 && <p className="vnext-empty-state">This durable session is ready for its first turn.</p>}
          {transcript.filter((turn) => turn.state !== "queued").map((turn) => <SessionTurn
            key={turn.runId}
            turn={turn}
            live={turn.runId === active?.runId}
            now={now}
            requests={openRequests.filter((request) => request.runId === turn.runId)}
            sending={sending}
            onDecide={(requestId, decision) => void decideRequest(requestId, decision)}
            onRetry={(item) => void retryAmbiguous(item)}
            onDiscard={(item) => void discardAmbiguous(item)}
          />)}
        </div>
        {!atBottom && <button type="button" className="vnext-scroll-latest" aria-label="Scroll to latest" onClick={toBottom}><Icon name="arrowDown" /></button>}
      </div>
      <Composer
        draft={draft}
        ready={Boolean(session)}
        busy={Boolean(active)}
        sending={sending}
        queued={queued}
        runtimeMode={session?.runtimeMode}
        onDraftChange={(nextDraft) => { setDraft(nextDraft); setDraftRunId(undefined); }}
        onSubmit={() => void submit()}
        onStop={() => void stop()}
        onWithdraw={(runId) => void withdraw(runId)}
        onRuntimeMode={(mode) => void setRuntimeMode(mode)}
      />
    </div>
  </main>;
}
