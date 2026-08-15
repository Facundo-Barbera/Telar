"use client";

/**
 * THE SPOOL'S FRONT DOOR — the project-less conversation you arrive at.
 *
 * CAP-1: "ONE project-less conversation — the module's front door." Not a
 * feature of the queue; the thing the queue is the memory FOR. You ask where you
 * stopped and it answers across everything, because it is scoped to nothing.
 *
 * ── WHY THIS IS NOT `session-cockpit.tsx` WITH A FLAG ────────────────────────
 * The cockpit is deeply project-coupled and rightly so: the canvas href, the
 * draft key, session creation, the breadcrumb, the git environment strip and the
 * whole right panel (files, diff, GitHub) all assume a repository. Making it
 * project-optional would put a branch through a 1,200-line component to serve a
 * surface that wants almost none of what those branches guard.
 *
 * ── WHAT IS SHARED, AND IT IS THE PART THAT MATTERS ──────────────────────────
 * `SessionTurn` and `Composer` are imported, never re-implemented. `SessionTurn`
 * reads `projectId` zero times — the shared conversation shell turned out to
 * already exist — and `Composer` needed three renders GUARDED rather than any
 * behaviour widened: the git strip, the project greeting and `@`-completion over
 * a checkout are exactly the three things a project-less chat does not want.
 *
 * So approvals, the activity fold, sub-agent chips, the live step window and
 * ambiguous-turn recovery all behave here identically to a project session,
 * because they are the same code. The donor's rule was to stop rather than
 * hand-build a second chat window; this is that rule obeyed.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 * No right panel, no file tree, no diff, no GitHub, no worktree choice, no
 * "new conversation" button. A second front door would make the front door a
 * list of front doors, which is CAP-1's whole point. The master is ensured, not
 * created: every arrival returns the same session.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { EngineRequest, RequestDecision, Session, SpoolDeskCard, Turn } from "@telar/engine-client";
import { createEngineApi, newRunId } from "@/lib/engine/client";
import { appendJournalEvents, isActiveTurn, projectJournal, taskRoster, type JournalTurn } from "@/lib/engine/journal";
import { hydrateSession, tailSession } from "@/lib/engine/session-sync";
import { readDraft, writeDraft } from "@/lib/composer-draft";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConversationContent, ConversationScrollButton, ConversationViewport } from "@/components/ui/conversation";
import { Skeleton } from "@/components/ui/skeleton";
import { Composer } from "@/components/composer";
import { SessionTurn } from "@/components/session-cockpit";
import { SpoolHeader } from "@/components/spool/header";
import { DeskRail } from "@/components/spool/desk-rail";

const api = createEngineApi();

/** The master's draft is keyed on the session, like any other. It has no
 *  project half, which is exactly what `writeDraft`'s optional project is for. */
const DRAFT_PROJECT = undefined;

export function MasterChat() {
  const [session, setSession] = useState<Session>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [items, setItems] = useState<Parameters<typeof projectJournal>[1]>([]);
  const [tasks, setTasks] = useState<Parameters<typeof projectJournal>[3]>([]);
  const [requests, setRequests] = useState<EngineRequest[]>([]);
  const [events, setEvents] = useState<Parameters<typeof projectJournal>[2]>([]);
  const [cursor, setCursor] = useState(0);
  const [desk, setDesk] = useState<SpoolDeskCard[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /**
   * ENSURE, NEVER CREATE. The route is a singleton: it returns the existing
   * master or mints it, so this is safe on every mount and there is no way for
   * the front door to become two doors.
   */
  const open = useCallback(async () => {
    const master = (await (await fetch("/api/spool/master")).json()) as { session: Session };
    setSession(master.session);
    const hydrated = await hydrateSession(api, master.session.id);
    setTurns(hydrated.turns);
    setItems(hydrated.items);
    setTasks(hydrated.tasks);
    setRequests(hydrated.requests);
    setEvents(hydrated.events);
    setCursor(hydrated.cursor);
    setError(null);
    return master.session;
  }, []);

  useEffect(() => {
    /**
     * Deferred to a task rather than run in the effect body — a synchronous
     * fetch-and-setState on mount is a cascading render, and this app has a lint
     * rule about it.
     *
     * NO "HAVE I RUN YET" REF. There was one, and it was the bug that left this
     * screen on its skeleton forever: React's development double-invoke runs the
     * effect, runs the cleanup, then runs the effect AGAIN — so the ref was
     * already set on the second pass, the guard returned early, and the timeout
     * it would have scheduled was the one the cleanup had just cancelled. Zero
     * requests, no error, a permanent loading state.
     *
     * The timeout pairing is ALREADY double-invoke safe without it, which is why
     * `queue-view.tsx` and `packet-view.tsx` — which never had the ref — always
     * worked: pass two schedules a fresh task, and only the last one survives.
     */
    const first = window.setTimeout(() => {
      void open().catch((err) => setError(err instanceof Error ? err.message : String(err)));
      void fetch("/api/spool")
        .then((r) => (r.ok ? r.json() : { desk: [] }))
        .then((d) => setDesk(d.desk ?? []))
        .catch(() => setDesk([]));
    }, 0);
    return () => window.clearTimeout(first);
  }, [open]);

  const journal = useMemo(() => projectJournal(turns, items, events, tasks), [turns, items, events, tasks]);
  const live = useMemo(() => journal.find((turn) => isActiveTurn(turn.state)), [journal]);

  /**
   * POLLED ONLY WHILE THERE IS SOMETHING TO SEE. A settled conversation is a
   * static page — tailing it forever would be a request storm for a screen
   * nobody is watching change. The tick also drives the live step window's
   * elapsed clock, which is a duration and not a date: the module forbids a
   * clock that TELLS you the time, not one that counts how long a turn has run.
   */
  useEffect(() => {
    if (!session || (!live && !sending)) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void (async () => {
        try {
          const tail = await tailSession(api, session.id, cursor);
          if (tail.events.length > 0) {
            setEvents((previous) => appendJournalEvents(previous, tail.events));
            setCursor(tail.cursor);
          }
          if (tail.snapshot) {
            setTurns(tail.snapshot.turns);
            setItems(tail.snapshot.items);
            setTasks((previous) => taskRoster(tail.snapshot!.tasks, projectJournal(tail.snapshot!.turns, tail.snapshot!.items, [], previous as never).flatMap((t) => t.tasks) as never));
            setRequests(tail.snapshot.requests);
          }
        } catch {
          // A dropped poll is not an error worth a banner: the next tick
          // retries, and the last good transcript stays readable meanwhile.
        }
      })();
    }, 700);
    return () => window.clearInterval(timer);
  }, [session, live, sending, cursor]);

  // The draft survives a reload, like the cockpit's. Restored on a task rather
  // than in the effect body — a synchronous setState there is a cascading
  // render, and localStorage is exactly the external system effects are for.
  useEffect(() => {
    if (!session) return;
    const task = window.setTimeout(() => setDraft(readDraft(session.id, DRAFT_PROJECT) ?? ""), 0);
    return () => window.clearTimeout(task);
  }, [session]);
  useEffect(() => {
    if (!session) return;
    const task = window.setTimeout(() => writeDraft(session.id, DRAFT_PROJECT, draft), 400);
    return () => window.clearTimeout(task);
  }, [draft, session]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || !session) return;
    setSending(true);
    void (async () => {
      try {
        await api.submitTurn(session.id, { runId: newRunId(), input: text });
        setDraft("");
        writeDraft(session.id, DRAFT_PROJECT, "");
        const tail = await tailSession(api, session.id, cursor);
        setEvents((previous) => appendJournalEvents(previous, tail.events));
        setCursor(tail.cursor);
        if (tail.snapshot) {
          setTurns(tail.snapshot.turns);
          setItems(tail.snapshot.items);
          setRequests(tail.snapshot.requests);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
    })();
  }, [cursor, draft, session]);

  const decide = useCallback(
    (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) => {
      if (!session) return;
      void api
        .resolveRequest(session.id, requestId, { decision, ...(extra?.answers ? { answers: extra.answers } : {}) })
        .then(() => tailSession(api, session.id, cursor))
        .then((tail) => {
          setEvents((previous) => appendJournalEvents(previous, tail.events));
          setCursor(tail.cursor);
          if (tail.snapshot) setRequests(tail.snapshot.requests);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [cursor, session],
  );

  const stop = useCallback(() => {
    if (!session || !live) return;
    void api.stopTurn(session.id, live.runId).catch(() => undefined);
  }, [live, session]);

  if (!session && !error) {
    return (
      <div className="flex h-dvh flex-col">
        <SpoolHeader active="chat" description="Loading…" />
        <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-6 py-8">
          <Skeleton className="h-5 w-40 rounded-md" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      {/* THE SAME BAR THE QUEUE WEARS. Its description says what this
          surface IS rather than counting anything at you — the chat has
          nothing to count, and a number here would be the badge the module
          refuses everywhere else. */}
      <SpoolHeader active="chat" description="No project — so it can answer across all of them." />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {error && (
            <Alert variant="destructive" className="mx-6 mt-4 w-auto">
              <TriangleAlertIcon />
              <AlertTitle>The master chat could not load</AlertTitle>
              <AlertDescription className="font-mono text-xs break-words">{error}</AlertDescription>
              <Button variant="outline" size="sm" className="mt-2 w-fit" onClick={() => void open()}>
                <RotateCwIcon />
                Retry
              </Button>
            </Alert>
          )}

          <ConversationViewport className="min-h-0 flex-1">
            <ConversationContent className="mx-auto w-full max-w-3xl px-6 py-6">
              {journal.length === 0 && !error && (
                /* THE FRONT DOOR'S OWN GREETING. It states what this chat is
                   for and — because the module's whole posture is that nothing
                   happens to you — what it will not do. */
                <div className="py-16 text-center">
                  <p className="text-sm text-muted-foreground">Ask where you stopped.</p>
                  <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground/60">
                    This chat has no project, so it can answer across all of them. Anything you dump here it will try to
                    make sense of and file. Nothing it prepares is started until you say so.
                  </p>
                </div>
              )}
              {journal.map((turn: JournalTurn) => (
                <SessionTurn
                  key={turn.runId}
                  turn={turn}
                  requests={requests.filter((r) => r.runId === turn.runId && r.state === "open")}
                  sending={sending}
                  live={turn.runId === live?.runId}
                  now={now}
                  onDecide={decide}
                  onRetry={() => undefined}
                  onDiscard={() => undefined}
                />
              ))}
            </ConversationContent>
            <ConversationScrollButton />
          </ConversationViewport>

          <div className="mx-auto w-full max-w-3xl px-6 pb-6">
            <Composer
              draft={draft}
              ready={!!session}
              attachments={[]}
              onAttach={() => undefined}
              busy={!!live}
              sending={sending}
              queued={[]}
              backgroundTasks={0}
              onDraftChange={setDraft}
              onSubmit={submit}
              onStop={stop}
              onWithdraw={() => undefined}
              onRecall={() => undefined}
              onRuntimeMode={() => undefined}
              onModelChange={() => undefined}
              {...(session ? { session } : {})}
              {...(session?.runtimeMode ? { runtimeMode: session.runtimeMode } : {})}
            />
          </div>
        </div>

        {/* THE DESK SITS BESIDE THE CHAT, not under it: what agents have filed
            for you is context for the conversation, not a separate errand. */}
        <DeskRail cards={desk} />
      </div>
    </div>
  );
}
