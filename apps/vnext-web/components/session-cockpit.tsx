"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineEvent, EngineSession, EngineTurn, TurnState } from "@telar/engine-client";
import { createVNextApi, newVNextRunId, retryAmbiguousTurn, VNextApiError } from "@/lib/vnext/client";
import { appendJournalEvents, isActiveTurn, projectJournal, type JournalTurn } from "@/lib/vnext/journal";
import { hydrateVNextSession, tailVNextSession } from "@/lib/vnext/session-sync";
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
  session?: EngineSession;
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
export function retryInputForJournalTurn(turn: Pick<JournalTurn, "runId" | "state" | "prompt">): Pick<EngineTurn, "runId" | "state" | "text"> {
  return { runId: turn.runId, state: turn.state, text: turn.prompt };
}

function SessionTurn({ turn, sending, onRetry, onDiscard }: {
  turn: JournalTurn;
  sending: boolean;
  onRetry: (turn: Pick<EngineTurn, "runId" | "state" | "text">) => void;
  onDiscard: (turn: Pick<EngineTurn, "runId">) => void;
}) {
  return <article className="vnext-conversation-turn">
    <div className="vnext-conversation-turn__prompt">
      <div className="vnext-conversation-turn__meta"><strong>You</strong><StateBadge state={turn.state} /></div>
      <p>{turn.prompt}</p>
    </div>
    {(turn.text || turn.failure) && <div className="vnext-conversation-turn__answer">
      <div className="vnext-conversation-turn__meta"><strong>Telar</strong><span className="vnext-muted vnext-small">Engine response</span></div>
      {turn.text && <p>{turn.text}</p>}
      {turn.failure && <p className="vnext-turn-failure" role="alert"><strong>Turn failed. </strong>{turn.failure}</p>}
    </div>}
    {turn.state === "ambiguous" && <RecoveryActions sending={sending} onRetry={() => onRetry(retryInputForJournalTurn(turn))} onDiscard={() => onDiscard(turn)} />}
  </article>;
}

function SessionTranscript({ loading, error, transcript, sending, onRetry, onDiscard }: {
  loading: boolean;
  error?: VNextApiError;
  transcript: ReturnType<typeof projectJournal>;
  sending: boolean;
  onRetry: (turn: Pick<EngineTurn, "runId" | "state" | "text">) => void;
  onDiscard: (turn: Pick<EngineTurn, "runId">) => void;
}) {
  return <section className="vnext-session-transcript" aria-label="Conversation transcript">
    {loading && <p className="vnext-empty-state">Hydrating durable transcript…</p>}
    {!loading && !error && transcript.length === 0 && <p className="vnext-empty-state">This durable session is ready for its first turn.</p>}
    {transcript.map((turn) => <SessionTurn key={turn.runId} turn={turn} sending={sending} onRetry={onRetry} onDiscard={onDiscard} />)}
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
  const [session, setSession] = useState<EngineSession>();
  const [turns, setTurns] = useState<EngineTurn[]>([]);
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
    setSession(hydrated.session); setTurns(hydrated.turns); setEvents(hydrated.events); cursor.current = hydrated.cursor;
  }), [enqueueSync, sessionId]);
  const tail = useCallback(() => enqueueSync(async () => {
    const update = await tailVNextSession(api, sessionId, cursor.current);
    if (update.events.length === 0) return;
    cursor.current = update.cursor;
    setEvents((current) => appendJournalEvents(current, update.events));
    if (update.snapshot) { setSession(update.snapshot.session); setTurns(update.snapshot.turns); }
  }), [enqueueSync, sessionId]);

  useEffect(() => {
    let cancelled = false;
    void hydrate().then(() => !cancelled && setError(undefined), (cause) => !cancelled && setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not hydrate this session."))).finally(() => !cancelled && setLoading(false));
    const interval = window.setInterval(() => { void tail().catch((cause) => !cancelled && setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not tail the session journal."))); }, 1_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [hydrate, tail]);

  const transcript = useMemo(() => projectJournal(turns, events), [turns, events]);
  const active = transcript.find((turn) => isActiveTurn(turn.state));
  const stop = async () => {
    if (!active) return;
    setSending(true);
    try { await api.stopTurn(sessionId, active.runId); await hydrate(); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not stop the turn.")); }
    finally { setSending(false); }
  };
  const discardAmbiguous = async (turn: Pick<EngineTurn, "runId">) => {
    setSending(true);
    try { await api.discardAmbiguousTurn(sessionId, turn.runId); await hydrate(); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not discard the ambiguous turn.")); }
    finally { setSending(false); }
  };
  const retryAmbiguous = async (turn: Pick<EngineTurn, "runId" | "state" | "text">) => {
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
    try { await api.submitTurn(sessionId, { runId, text: draft.trim() }); setDraft(""); setDraftRunId(undefined); await hydrate(); setError(undefined); }
    catch (cause) { setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not submit the turn.")); }
    finally { setSending(false); }
  };

  return <main className="vnext-session-workspace">
    <SessionMasthead projectId={projectId} session={session} sessionId={sessionId} active={active} sending={sending} onStop={() => void stop()} />
    <div className="vnext-conversation-column">
      {projectId !== session?.projectId && session && <p className="vnext-alert">This URL’s project does not match the engine-owned session record.</p>}
      {error && <SessionProblem error={error} />}
      {active && <ActiveTurnNotice state={active.state} />}
      <SessionTranscript loading={loading} error={error} transcript={transcript} sending={sending} onRetry={(turn) => void retryAmbiguous(turn)} onDiscard={(turn) => void discardAmbiguous(turn)} />
      <SessionComposer draft={draft} ready={Boolean(session)} active={active} sending={sending} onDraftChange={(nextDraft) => { setDraft(nextDraft); setDraftRunId(undefined); }} onSubmit={submit} />
    </div>
  </main>;
}
