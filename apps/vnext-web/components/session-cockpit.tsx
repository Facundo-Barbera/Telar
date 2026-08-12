"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayToolName, type EngineEvent, type EngineRequest, type Item, type Session, type Task, type Turn, type TurnState } from "@telar/engine-client";
import { createVNextApi, newVNextRunId, retryAmbiguousTurn, VNextApiError } from "@/lib/vnext/client";
import {
  appendJournalEvents,
  isActiveTurn,
  isToolItem,
  itemLabel,
  itemText,
  projectJournal,
  toolOutput,
  type JournalItem,
  type JournalTask,
  type JournalTurn,
} from "@/lib/vnext/journal";
import { hydrateVNextSession, tailVNextSession } from "@/lib/vnext/session-sync";
import { AgentMarkdown } from "./agent-markdown";
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

function StateBadge({ state }: { state: TurnState }) {
  const status = describeTurnState(state);
  return <span className="vnext-badge" data-tone={status.tone}><span aria-hidden="true" className="vnext-badge__dot" />{status.label}</span>;
}

function SessionProblem({ error }: { error: VNextApiError }) {
  const unavailable = error.code === "engine_unavailable" || error.code === "engine_locked";
  return <div role="alert" className="vnext-alert"><strong>{unavailable ? "vNext engine unavailable. " : "vNext request failed. "}</strong>{error.message}</div>;
}

function SessionMasthead({ projectId, session, sessionId, active, sending, onStop }: {
  projectId: string;
  session?: Session;
  sessionId: string;
  active?: { state: TurnState };
  sending: boolean;
  onStop: () => void;
}) {
  return <header className="vnext-session-heartbeat">
    <Link className="vnext-backlink" href="/" aria-label="Back to projects"><Icon name="folder" /></Link>
    <div className="vnext-session-heartbeat__identity"><span>{session?.projectId ?? projectId}</span><i>/</i><strong title={session?.title ?? "Session"}>{session?.title ?? "Session"}</strong></div>
    <div className="vnext-session-heartbeat__actions">{active && <StateBadge state={active.state} />}{active && <button className="vnext-button vnext-button--danger" type="button" onClick={onStop} disabled={sending}>Stop</button>}<VNextRightPanel projectId={session?.projectId ?? projectId} sessionId={sessionId} active={active?.state} /></div>
  </header>;
}

function ActiveTurnNotice({ state }: { state: TurnState }) {
  const status = describeTurnState(state);
  return <aside className="vnext-live-state" aria-live="polite">
    <StateBadge state={state} />
    <p><strong>Live work in progress.</strong> This turn is {status.label.toLowerCase()}. You can keep reading while the durable journal updates.</p>
  </aside>;
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

/** The journal separates the submitted prompt from streamed agent output. */
export function retryInputForJournalTurn(turn: Pick<JournalTurn, "runId" | "state" | "prompt">): Pick<Turn, "runId" | "state" | "input"> {
  return { runId: turn.runId, state: turn.state, input: turn.prompt };
}

const TOOL_ICON: Partial<Record<Item["detail"]["type"], string>> = {
  command_execution: "terminal",
  file_change: "file",
  file_read: "file",
  mcp_tool_call: "plug",
  dynamic_tool_call: "tool",
  web_search: "search",
  browser_action: "globe",
};

/**
 * A unified diff, coloured by line.
 *
 * PER-LINE RATHER THAN A DIFF LIBRARY: the engine already produced the diff, so
 * the only job left is to make additions and removals scannable. Splitting on
 * the first character is exactly what the format guarantees, and it cannot get
 * out of step with a parser the engine does not use.
 */
function DiffBody({ diff }: { diff: string }) {
  return <pre className="vnext-diff">
    {diff.split("\n").map((line, index) => {
      // `---`/`+++` are the file header, not a removed and an added line. Tested
      // before the single-character check or every diff opens with one of each.
      const tone = line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")
        ? "meta"
        : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : undefined;
      return <span key={index} className="vnext-diff__line" data-tone={tone}>{line || " "}</span>;
    })}
  </pre>;
}

/**
 * A tool call. Collapsed to its label by default — a turn that ran forty tools
 * is unreadable expanded, and the label is what a reader scans.
 *
 * `<details>` rather than React state on purpose: it keeps open/closed in the
 * DOM across re-renders, and a streaming turn re-renders constantly.
 */
function ToolItem({ item }: { item: JournalItem }) {
  const output = toolOutput(item);
  const change = item.detail.type === "file_change" ? item.detail.change : undefined;
  return <details className="vnext-tool-item" data-status={item.status}>
    <summary>
      <span className="vnext-tool-item__kind" aria-hidden="true">{TOOL_ICON[item.detail.type] ?? "tool"}</span>
      <code className="vnext-tool-item__label">{itemLabel(item)}</code>
      {/* The scannable part of a detached run: what this edit cost the file,
          readable without expanding the row. */}
      {change && (change.linesAdded ?? change.linesRemoved) !== undefined && <span className="vnext-diff-stat">
        {change.linesAdded ? <b data-tone="add">+{change.linesAdded}</b> : null}
        {change.linesRemoved ? <b data-tone="remove">−{change.linesRemoved}</b> : null}
      </span>}
      <span className="vnext-tool-item__status" data-status={item.status}>
        {item.status === "inProgress" ? "running" : item.status === "failed" ? "failed" : item.status === "declined" ? "declined" : "done"}
      </span>
    </summary>
    {change?.unifiedDiff
      ? <DiffBody diff={change.unifiedDiff} />
      : output
        ? <pre className="vnext-tool-item__body">{output}</pre>
        : <p className="vnext-muted vnext-small">No output recorded.</p>}
  </details>;
}

/** The agent's checklist. One row per turn, updated in place by the engine. */
function PlanItem({ item }: { item: JournalItem }) {
  if (item.detail.type !== "plan") return null;
  const steps = item.detail.plan.steps;
  const done = steps.filter((step) => step.status === "completed").length;
  return <details className="vnext-plan-item" open={item.status === "inProgress"}>
    <summary>
      <span className="vnext-tool-item__kind" aria-hidden="true">list</span>
      <span className="vnext-tool-item__label">Plan</span>
      <span className="vnext-muted vnext-small">{done}/{steps.length}</span>
    </summary>
    <ol className="vnext-plan">
      {steps.map((step, index) => <li key={index} data-status={step.status}>{step.step}</li>)}
    </ol>
  </details>;
}

/** Extended thinking, collapsed by default: it is long and rarely the point. */
function ReasoningItem({ item }: { item: JournalItem }) {
  const text = itemText(item);
  if (!text) return null;
  return <details className="vnext-reasoning-item">
    <summary>Thinking</summary>
    <AgentMarkdown text={text} streaming={item.status === "inProgress"} />
  </details>;
}

/** The state word a sub-agent row leads with. */
const TASK_STATES: Record<Task["state"], string> = {
  pending: "Queued",
  running: "Working",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/**
 * A sub-agent and everything it did, as ONE collapsible row.
 *
 * NESTED RATHER THAN INTERLEAVED. Five agents running at once put their tool
 * calls on the same stream in arrival order; rendered flat that reads as a
 * single agent doing five contradictory things. `Item.taskId` is what lets the
 * fold separate them, and this is the surface that separation exists for.
 */
function TaskGroup({ task }: { task: JournalTask }) {
  const live = task.state === "running" || task.state === "pending" || task.state === "waiting";
  return <details className="vnext-task-group" open={live}>
    <summary>
      <span className="vnext-task-group__role">{task.role ?? (task.kind === "background" ? "Background" : "Agent")}</span>
      <span className="vnext-task-group__title">{task.title ?? "Sub-agent"}</span>
      <span className="vnext-muted vnext-small">{TASK_STATES[task.state]}</span>
    </summary>
    <div className="vnext-timeline">
      {task.items.map((item) => <TimelineItem key={item.id} item={item} />)}
    </div>
    {task.resultText && <AgentMarkdown text={task.resultText} />}
    {task.failure && <p className="vnext-turn-failure" role="alert">{task.failure}</p>}
  </details>;
}

function TimelineItem({ item }: { item: JournalItem }) {
  // The handle row for a sub-agent. Its work renders under `TaskGroup`, so
  // showing it again here would print the fan-out twice.
  if (item.detail.type === "task") return null;
  if (isToolItem(item)) return <ToolItem item={item} />;
  if (item.detail.type === "plan") return <PlanItem item={item} />;
  if (item.detail.type === "reasoning") return <ReasoningItem item={item} />;
  if (item.detail.type === "error") {
    return <p className="vnext-turn-failure" role="alert">{item.detail.error.message}</p>;
  }
  if (item.detail.type === "assistant_message") {
    return <AgentMarkdown text={itemText(item)} streaming={item.status === "inProgress"} />;
  }
  // Forward compatibility: an item type this build does not render still gets
  // a row. A silently missing row is worse than an unstyled one.
  return <p className="vnext-muted vnext-small">{itemLabel(item)}</p>;
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

function SessionTurn({ turn, requests, sending, onDecide, onRetry, onDiscard }: {
  requests: EngineRequest[];
  onDecide: (requestId: string, decision: "accept" | "acceptForSession" | "decline") => void;
  turn: JournalTurn;
  sending: boolean;
  onRetry: (turn: Pick<Turn, "runId" | "state" | "input">) => void;
  onDiscard: (turn: Pick<Turn, "runId">) => void;
}) {
  // The final text is shown only when no assistant item carried it. A completed
  // turn has both — `resultText` on the turn and the streamed message items —
  // and rendering both prints the answer twice.
  const streamedAnswer = turn.items.some((item) => item.detail.type === "assistant_message" && itemText(item));
  const hasBody = turn.items.length > 0 || turn.tasks.length > 0 || turn.resultText || turn.failure;
  return <article className="vnext-conversation-turn">
    <div className="vnext-conversation-turn__prompt">
      <div className="vnext-conversation-turn__meta"><strong>You</strong><StateBadge state={turn.state} /></div>
      <p>{turn.prompt}</p>
    </div>
    {requests.map((request) => <ApprovalCard key={request.id} request={request} sending={sending} onDecide={onDecide} />)}
    {hasBody && <div className="vnext-conversation-turn__answer">
      <div className="vnext-conversation-turn__meta">
        <strong>Telar</strong>
        {turn.usage && <span className="vnext-muted vnext-small">
          {turn.usage.tokens.input + turn.usage.tokens.output} tokens
          {typeof turn.usage.costUsd === "number" && ` · $${turn.usage.costUsd.toFixed(4)}`}
        </span>}
      </div>
      <div className="vnext-timeline">
        {turn.items.map((item) => <TimelineItem key={item.id} item={item} />)}
        {turn.tasks.map((task) => <TaskGroup key={task.id} task={task} />)}
      </div>
      {!streamedAnswer && turn.resultText && <AgentMarkdown text={turn.resultText} />}
      {turn.failure && <p className="vnext-turn-failure" role="alert"><strong>Turn failed. </strong>{turn.failure}</p>}
    </div>}
    {turn.state === "ambiguous" && <RecoveryActions sending={sending} onRetry={() => onRetry(retryInputForJournalTurn(turn))} onDiscard={() => onDiscard(turn)} />}
  </article>;
}

function SessionTranscript({ loading, error, transcript, openRequests, sending, onDecide, onRetry, onDiscard }: {
  loading: boolean;
  error?: VNextApiError;
  transcript: ReturnType<typeof projectJournal>;
  openRequests: EngineRequest[];
  sending: boolean;
  onDecide: (requestId: string, decision: "accept" | "acceptForSession" | "decline") => void;
  onRetry: (turn: Pick<Turn, "runId" | "state" | "input">) => void;
  onDiscard: (turn: Pick<Turn, "runId">) => void;
}) {
  return <section className="vnext-session-transcript" aria-label="Conversation transcript">
    {loading && <p className="vnext-empty-state">Hydrating durable transcript…</p>}
    {!loading && !error && transcript.length === 0 && <p className="vnext-empty-state">This durable session is ready for its first turn.</p>}
    {transcript.map((turn) => <SessionTurn key={turn.runId} turn={turn} requests={openRequests.filter((request) => request.runId === turn.runId)} sending={sending} onDecide={onDecide} onRetry={onRetry} onDiscard={onDiscard} />)}
  </section>;
}

function SessionComposer({ draft, ready, active, sending, onDraftChange, onSubmit }: {
  draft: string;
  ready: boolean;
  active?: { state: TurnState };
  sending: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const unavailable = !ready || Boolean(active) || sending;
  const helper = !ready ? "Waiting for the engine-owned session to become available." : active ? "A turn is active. Stop it before sending another." : "Each submission receives a stable run ID before it reaches the engine.";
  return <form className="vnext-session-composer" onSubmit={onSubmit}>
    <label className="sr-only" htmlFor="vnext-turn-prompt">Message</label>
    <textarea id="vnext-turn-prompt" className="vnext-textarea" aria-describedby="vnext-composer-help" placeholder={!ready ? "Waiting for the engine session…" : active ? "A turn is active. Stop it before sending another." : "Ask for changes, explore the project, or continue this conversation…"} value={draft} onChange={(event) => onDraftChange(event.target.value)} disabled={unavailable} />
    <div className="vnext-session-composer__footer"><p id="vnext-composer-help" className="vnext-muted vnext-small">{helper}</p><button className="vnext-button" type="submit" disabled={!draft.trim() || unavailable}>{sending ? "Sending…" : "Send"}</button></div>
  </form>;
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
  const active = transcript.find((turn) => isActiveTurn(turn.state));
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
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft.trim() || active) return;
    const runId = draftRunId ?? newVNextRunId(); setDraftRunId(runId); setSending(true);
    try { await api.submitTurn(sessionId, { runId, input: draft.trim() }); setDraft(""); setDraftRunId(undefined); await hydrate(); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not submit the turn.")); }
    finally { setSending(false); }
  };

  return <main className="vnext-session-workspace">
    <SessionMasthead projectId={projectId} session={session} sessionId={sessionId} active={active} sending={sending} onStop={() => void stop()} />
    <div className="vnext-conversation-column">
      {projectId !== session?.projectId && session && <p className="vnext-alert">This URL’s project does not match the engine-owned session record.</p>}
      {error && <SessionProblem error={error} />}
      {active && <ActiveTurnNotice state={active.state} />}
      <SessionTranscript loading={loading} error={error} transcript={transcript} openRequests={openRequests} sending={sending} onDecide={(requestId, decision) => void decideRequest(requestId, decision)} onRetry={(turn) => void retryAmbiguous(turn)} onDiscard={(turn) => void discardAmbiguous(turn)} />
      <SessionComposer draft={draft} ready={Boolean(session)} active={active} sending={sending} onDraftChange={(nextDraft) => { setDraft(nextDraft); setDraftRunId(undefined); }} onSubmit={submit} />
    </div>
  </main>;
}
