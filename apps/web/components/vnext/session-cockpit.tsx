"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineEvent, EngineSession, EngineTurn, TurnState } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { createVNextApi, newVNextRunId, retryAmbiguousTurn, VNextApiError } from "@/lib/vnext/client";
import { appendJournalEvents, isActiveTurn, projectJournal } from "@/lib/vnext/journal";
import { hydrateVNextSession, tailVNextSession } from "@/lib/vnext/session-sync";

const api = createVNextApi();
const terminal: Record<Exclude<TurnState, "queued" | "claimed" | "running">, string> = {
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  ambiguous: "Needs recovery decision",
  discarded: "Discarded after recovery decision",
};

function StateBadge({ state }: { state: TurnState }) {
  const label = terminal[state as keyof typeof terminal] ?? (state === "running" ? "Streaming" : "Queued");
  const tone = state === "completed" ? "text-success bg-success/10" : state === "failed" ? "text-destructive bg-destructive/10" : state === "stopped" || state === "ambiguous" || state === "discarded" ? "text-warning bg-warning/10" : "text-info bg-info/10";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

function SessionProblem({ error }: { error: VNextApiError }) {
  const unavailable = error.code === "engine_unavailable" || error.code === "engine_locked";
  return <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><strong>{unavailable ? "vNext engine unavailable. " : "vNext request failed. "}</strong>{error.message}</div>;
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
  // Snapshot and cursor reads must be serialized.  Otherwise a slow refresh
  // can overwrite events just appended by the poller, permanently advancing
  // the cursor past a transition the UI no longer holds.
  const syncQueue = useRef<Promise<void>>(Promise.resolve());

  const enqueueSync = useCallback((operation: () => Promise<void>) => {
    const next = syncQueue.current.then(operation, operation);
    syncQueue.current = next.catch(() => undefined);
    return next;
  }, []);

  const hydrate = useCallback(() => enqueueSync(async () => {
    const hydrated = await hydrateVNextSession(api, sessionId);
    setSession(hydrated.session);
    setTurns(hydrated.turns);
    setEvents(hydrated.events);
    cursor.current = hydrated.cursor;
  }), [enqueueSync, sessionId]);

  const tail = useCallback(() => enqueueSync(async () => {
    const update = await tailVNextSession(api, sessionId, cursor.current);
    if (update.events.length === 0) return;
    cursor.current = update.cursor;
    setEvents((current) => appendJournalEvents(current, update.events));
    if (update.snapshot) {
      setSession(update.snapshot.session);
      setTurns(update.snapshot.turns);
    }
  }), [enqueueSync, sessionId]);

  useEffect(() => {
    let cancelled = false;
    const initial = async () => {
      try {
        await hydrate();
        if (!cancelled) setError(undefined);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not hydrate this session."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void initial();
    const interval = window.setInterval(() => {
      void tail().catch((cause) => !cancelled && setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not tail the session journal.")));
    }, 1_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [hydrate, tail]);

  const transcript = useMemo(() => projectJournal(turns, events), [turns, events]);
  const active = transcript.find((turn) => isActiveTurn(turn.state));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || active) return;
    const runId = draftRunId ?? newVNextRunId();
    setDraftRunId(runId);
    setSending(true);
    try {
      await api.submitTurn(sessionId, { runId, text: draft.trim() });
      setDraft("");
      setDraftRunId(undefined);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not submit the turn."));
    } finally {
      setSending(false);
    }
  };

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

  const discardAmbiguous = async (turn: Pick<EngineTurn, "runId">) => {
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

  const retryAmbiguous = async (turn: Pick<EngineTurn, "runId" | "state" | "text">) => {
    setSending(true);
    try {
      await retryAmbiguousTurn(api, sessionId, turn);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      // A successful discard followed by a failed new submission is still a
      // durable state change; refresh it before showing the request error.
      try { await hydrate(); } catch { /* Preserve the original request error. */ }
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not retry the ambiguous turn."));
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 p-6 md:p-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/vnext" className="text-sm text-primary hover:underline">← Projects</Link>
          <h1 className="mt-2 font-heading text-2xl font-semibold tracking-tight">{session?.title ?? "Session"}</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{sessionId}</p>
        </div>
        {active && <Button variant="destructive" onClick={() => void stop()} disabled={sending}>Stop turn</Button>}
      </header>
      {projectId !== session?.projectId && session && <p className="rounded-lg bg-warning/10 p-3 text-sm text-warning">This URL’s project does not match the engine-owned session record.</p>}
      {error && <SessionProblem error={error} />}

      <Card className="min-h-80 flex-1">
        <CardHeader><CardTitle>Transcript</CardTitle><CardDescription>Hydrated from the durable engine journal and tailed by cursor.</CardDescription></CardHeader>
        <CardContent className="space-y-5">
          {loading && <p className="text-sm text-muted-foreground">Hydrating durable transcript…</p>}
          {!loading && transcript.length === 0 && <p className="text-sm text-muted-foreground">Send the first turn when a worker is available.</p>}
          {transcript.map((turn) => (
            <article key={turn.runId} className="space-y-2 border-b border-border pb-5 last:border-0">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">You</span><StateBadge state={turn.state} /></div>
              <p className="whitespace-pre-wrap text-sm">{turn.prompt}</p>
              {(turn.text || turn.failure) && <div className="rounded-lg bg-muted p-3"><p className="mb-1 text-xs font-medium text-muted-foreground">Agent</p>{turn.text && <p className="whitespace-pre-wrap text-sm">{turn.text}</p>}{turn.failure && <p className="mt-2 text-sm text-destructive">{turn.failure}</p>}</div>}
              {turn.state === "ambiguous" && (
                <div className="flex flex-wrap items-center gap-2 pt-1"><Button type="button" variant="outline" size="sm" disabled={sending} onClick={() => void retryAmbiguous(turn)}>Retry as new run</Button><Button type="button" variant="outline" size="sm" disabled={sending} onClick={() => void discardAmbiguous(turn)}>Discard</Button><span className="text-xs text-muted-foreground">Retry records a discard decision first, then creates a fresh run. It never replays uncertain work.</span></div>
              )}
            </article>
          ))}
        </CardContent>
      </Card>

      <form onSubmit={submit} className="space-y-2">
        <Textarea aria-label="Turn prompt" placeholder={active ? "A turn is active. Stop it before sending another." : "Message the engine-backed agent…"} value={draft} onChange={(event) => { setDraft(event.target.value); setDraftRunId(undefined); }} disabled={Boolean(active) || sending} />
        <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{active ? "One active turn per session." : "A new stable run id is generated for this submission."}</p><Button type="submit" disabled={!draft.trim() || Boolean(active) || sending}>{sending ? "Sending…" : "Send turn"}</Button></div>
      </form>
    </main>
  );
}
