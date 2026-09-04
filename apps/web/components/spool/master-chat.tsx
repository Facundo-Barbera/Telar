"use client";

/**
 * THE SPOOL'S CONVERSATION — the project-less chat, as the stance's other half.
 *
 * CAP-1: "ONE project-less conversation — the module's front door." Since the
 * §13 redefinition the front door is the STANCE SCREEN, and this is its right
 * half: always visible, never a destination of its own. The chat is how you
 * talk to it; the stance beside it is what it holds — so this component no
 * longer owns a page, a header, a brief or a panel. It renders a transcript
 * and a composer into whatever column its parent gives it, and reports through
 * `onChanged` when a turn may have moved the store, so the stance re-reads.
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
import { Maximize2Icon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { EngineRequest, RequestDecision, Session, SpoolMcpInfo, Turn } from "@telar/engine-client";
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
import { cn } from "@/lib/utils";

const api = createEngineApi();

/** The master's draft is keyed on the session, like any other. It has no
 *  project half, which is exactly what `writeDraft`'s optional project is for. */
const DRAFT_PROJECT = undefined;

/**
 * THE MCP CONNECTIONS CARD — rehomed here from `warehouse.tsx`'s
 * `ConnectionsTab` (§13.8, 2026-08-19: the Warehouse dissolves). Same data
 * (`SpoolMcpInfo`, `/api/spool/mcp-info`), same masked-by-default
 * reveal/copy behaviour, moved rather than duplicated — its only home now is
 * the Assistant room's own foot, self-fetching the same "pull its own read"
 * discipline every other Spool face keeps. Quiet: no red, a plain card
 * beneath the composer, not a tab of its own.
 */
function McpConnectionsCard() {
  const [mcp, setMcp] = useState<SpoolMcpInfo | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const first = window.setTimeout(() => {
      void fetch("/api/spool/mcp-info")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => setMcp((data?.mcp ?? null) as SpoolMcpInfo | null))
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(first);
  }, []);

  if (!mcp) return null;

  return (
    <div className="w-full px-4 pb-4">
      <div className="rounded-lg bg-muted/40 p-2 ring-1 ring-border/60">
        <code className="block font-mono text-[0.625rem] leading-relaxed break-all text-muted-foreground">
          {revealed ? mcp.addCommand : mcp.addCommand.replaceAll(mcp.secret, "••••••••")}
        </code>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard
                .writeText(mcp.addCommand)
                .then(() => setCopied(true))
                .catch(() => {
                  // Refused: the command is on screen and selectable.
                });
            }}
            className="rounded-md border border-border px-2 py-0.5 text-[0.625rem] text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
          >
            {copied ? "copied" : "copy"}
          </button>
          <button
            type="button"
            aria-pressed={revealed}
            onClick={() => setRevealed((r) => !r)}
            className="rounded-md border border-border px-2 py-0.5 text-[0.625rem] text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
          >
            {revealed ? "hide the secret" : "reveal the secret"}
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-[0.625rem] leading-relaxed text-muted-foreground/60">
        The secret lets any agent read and file into the whole Spool — treat it like a key.
      </p>
    </div>
  );
}

/** Where the view-level cutoff lives. See `startFresh` — the SESSION is a
 *  singleton the engine will not fork, so "fresh" is a fact about the view. */
const cutoffKey = (sessionId: string) => `telar:spool-master-cutoff:${sessionId}`;

/**
 * THE MACHINE CONTEXT IS SENT, NEVER SHOWN. Every turn goes out with the
 * room's one bracketed context line prefixed into `input` (see `context`
 * below) — the model and the journal keep it, and the engine depends on it
 * arriving. What the TRANSCRIPT shows is the person's own words: this regex
 * matches exactly the shape the room composes (`[room: …]` then a newline)
 * and the renderer strips it from a displayed turn. Display only — nothing
 * stored changes, and "earlier" history strips the same way.
 */
const ROOM_PREFIX = /^\[room: [^\n]*\]\n/;
const shownPrompt = (prompt: string) => prompt.replace(ROOM_PREFIX, "");

export function MasterChat({
  onChanged,
  openers = [],
  prefill,
  context,
  onExpand,
  onClose,
  variant = "layer",
}: {
  /**
   * A TURN MAY HAVE MOVED THE STORE. Talking is how items get filed, focus
   * gets set and subjects get made, and the stance next door renders all of
   * it — so it re-reads when a turn lands rather than polling everything
   * forever. Fired when a submit completes and when a live turn settles.
   */
  onChanged?: () => void;
  /**
   * WHAT THIS CHAT CAN DO, AS THINGS TO TAP — derived by the stance from the
   * same records it draws, never generated. Each names real state ("File the
   * 5 unfiled items") and tapping one SENDS it: an opener is an invitation
   * accepted, not a draft. They render large when the visible transcript is
   * empty and as a quiet row above the composer after, so capability stays
   * discoverable past the first message.
   */
  openers?: readonly string[];
  /**
   * A STANCE LINE TEACHING ITS VERB. The text lands in the composer and stops
   * there — the human presses send, which is the whole point of the wiring:
   * capability shown, last word kept. The counter lets the same suggestion be
   * pressed twice.
   */
  prefill?: { text: string; n: number };
  /**
   * WHAT THE ROOM LOOKS LIKE RIGHT NOW — one bracketed line the room composes
   * (scope, tray face, band counts) and every turn carries, so "file this"
   * and "what's this about" resolve against what is on screen.
   *
   * PREFIXED INTO THE MESSAGE TEXT. The turn payload
   * (`{runId, input, model?, attachments?}`) has no context field, and this
   * pass may not change the engine — so the line rides inside `input`, the
   * journal keeps it, and anyone reading the raw record sees exactly what the
   * model was told. The TRANSCRIPT strips the line at render (`shownPrompt`):
   * plumbing in the payload, the person's own words on screen.
   */
  context?: string;
  /** §13.6 — set only by the summoned layer's chat slot, never by the
   *  Assistant room (which has nowhere to expand to and nothing to close).
   *  Rendered beside "Start fresh" rather than replacing it: this header's
   *  own job — naming what this half is — is unchanged by who is hosting
   *  it. */
  onExpand?: () => void;
  onClose?: () => void;
  /**
   * WHICH DOOR THIS IS — §13.6's two surfaces of the one transcript.
   * `"layer"` (the default) is the narrow, edge-docked slide-over: full
   * bleed, top-anchored, the shape it has always had. `"room"` is the
   * Assistant room itself — full-width real estate the transcript must not
   * simply fill edge to edge with prose. It gets the app's own
   * reading-width column (`max-w-3xl`, the same token `Stance`, `Lobby` and
   * `SubjectRoom` already center on) and BOTTOM-ANCHORED short-conversation
   * layout: a fresh or short exchange sits just above the composer instead
   * of pinned to the top with a void underneath — the layout parameterizes
   * the one component rather than forking a second chat surface.
   */
  variant?: "layer" | "room";
}) {
  const [session, setSession] = useState<Session>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [items, setItems] = useState<Parameters<typeof projectJournal>[1]>([]);
  const [tasks, setTasks] = useState<Parameters<typeof projectJournal>[3]>([]);
  const [requests, setRequests] = useState<EngineRequest[]>([]);
  const [events, setEvents] = useState<Parameters<typeof projectJournal>[2]>([]);
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /**
   * THE TRANSCRIPT OPENS AT THE LATEST EXCHANGE. A working chat accumulates
   * history — including the debugging the singleton session has been through —
   * and opening into all of it is telemetry presented as conversation. The
   * rest is one quiet disclosure away, never gone.
   */
  const [showEarlier, setShowEarlier] = useState(false);
  /**
   * THE VIEW'S OWN "START FRESH". The engine will not mint a second master —
   * CAP-1: a create affordance would turn the front door into a list of front
   * doors — so fresh is a fact about what this column shows, persisted per
   * session in localStorage. Everything before the cutoff stays reachable
   * through the same "earlier" disclosure, which is what keeps it honest.
   */
  const [cutoff, setCutoff] = useState<string | null>(null);

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
     * `packet-view.tsx` — which never had the ref — always worked: pass two
     * schedules a fresh task, and only the last one survives.
     */
    const first = window.setTimeout(() => {
      void open().catch((err) => setError(err instanceof Error ? err.message : String(err)));
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

  /**
   * THE STANCE LEARNS WHEN A TURN SETTLES. Keyed on whether one is live: the
   * flag falls exactly once per turn, where watching the transcript would
   * report on every streamed step. It also fires once on mount, which costs
   * one read the stance was about to do anyway.
   */
  const liveNow = !!live;
  useEffect(() => {
    if (liveNow) return;
    const task = window.setTimeout(() => onChanged?.(), 0);
    return () => window.clearTimeout(task);
  }, [liveNow, onChanged]);

  // The draft survives a reload, like the cockpit's. Restored on a task rather
  // than in the effect body — a synchronous setState there is a cascading
  // render, and localStorage is exactly the external system effects are for.
  // The view cutoff rides the same restore: both are per-session view state.
  useEffect(() => {
    if (!session) return;
    const task = window.setTimeout(() => {
      setDraft(readDraft(session.id, DRAFT_PROJECT) ?? "");
      setCutoff(window.localStorage.getItem(cutoffKey(session.id)));
    }, 0);
    return () => window.clearTimeout(task);
  }, [session]);

  /** A stance line's verb arriving. Replaces the draft rather than appending —
   *  the suggestion IS the message, and the human edits or sends it. The prop
   *  is a state object next door, so its identity only changes on a press;
   *  the counter is what lets the same text be pressed twice. */
  useEffect(() => {
    if (!prefill || prefill.n === 0 || !prefill.text) return;
    const task = window.setTimeout(() => setDraft(prefill.text), 0);
    return () => window.clearTimeout(task);
  }, [prefill]);
  useEffect(() => {
    if (!session) return;
    const task = window.setTimeout(() => writeDraft(session.id, DRAFT_PROJECT, draft), 400);
    return () => window.clearTimeout(task);
  }, [draft, session]);

  /**
   * ONE SEND PATH FOR BOTH MOUTHS. The composer submits the draft; an opener
   * submits its own words. Only the draft path clears the box — an opener
   * pressed mid-thought must not eat what was being typed.
   */
  const send = useCallback(
    (text: string, fromDraft: boolean) => {
      if (!text || !session) return;
      setSending(true);
      void (async () => {
        try {
          await api.submitTurn(session.id, { runId: newRunId(), input: context ? `${context}\n${text}` : text });
          if (fromDraft) {
            setDraft("");
            writeDraft(session.id, DRAFT_PROJECT, "");
          }
          const tail = await tailSession(api, session.id, cursor);
          setEvents((previous) => appendJournalEvents(previous, tail.events));
          setCursor(tail.cursor);
          if (tail.snapshot) {
            setTurns(tail.snapshot.turns);
            setItems(tail.snapshot.items);
            setRequests(tail.snapshot.requests);
          }
          // THE STANCE REACTS TO WHAT YOU SAID — talking is one of the ways
          // the store moves, and the screen next door renders the store.
          onChanged?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSending(false);
        }
      })();
    },
    [context, cursor, onChanged, session],
  );

  const submit = useCallback(() => send(draft.trim(), true), [draft, send]);

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

  /** See `cutoff` above. Nothing is ended and nothing is discarded — the same
   *  argument the old "back to the brief" recorded: a fresh view reached by
   *  destroying history is one nobody would click twice. */
  const startFresh = useCallback(() => {
    const last = journal.at(-1);
    if (!session || !last) return;
    setCutoff(last.runId);
    window.localStorage.setItem(cutoffKey(session.id), last.runId);
    setShowEarlier(false);
  }, [journal, session]);

  /**
   * A QUEUED MESSAGE IS WAITING, AND THE COMPOSER SAYS SO. This surface passed
   * `queued: []` while the send path had the state all along — the engine
   * queues a turn submitted behind a live one — so a second dump sat in the
   * box LOOKING sent for minutes. The cockpit's own derivation, borrowed
   * whole: queued turns come out of the transcript and into the composer's
   * waiting strip, where they can be withdrawn or recalled.
   */
  const queued = journal
    .filter((turn) => turn.state === "queued")
    // Stripped for DISPLAY like the transcript — and recalling a queued turn
    // into the box must recall the words, not the machine line the next send
    // would prefix again.
    .map((turn) => ({ runId: turn.runId, text: shownPrompt(turn.prompt) }));

  const withdraw = useCallback(
    (runId: string) => {
      if (!session) return;
      void api
        .stopTurn(session.id, runId)
        .then(() => open())
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [open, session],
  );

  /**
   * THE DEFAULT VIEW IS THE LATEST EXCHANGE after the cutoff. "Earlier" shows
   * the WHOLE journal — including what a Start fresh folded away — because a
   * disclosure that revealed only part of the history would be a second,
   * quieter deletion path, and this module has none. Queued turns are not
   * exchanges yet; they render in the composer's strip instead.
   */
  const settledJournal = journal.filter((turn) => turn.state !== "queued");
  const cutIndex = cutoff ? settledJournal.findIndex((t) => t.runId === cutoff) : -1;
  const afterCutoff = cutIndex >= 0 ? settledJournal.slice(cutIndex + 1) : settledJournal;
  const latest = afterCutoff.slice(-1);
  const shownTurns = showEarlier ? settledJournal : latest;
  const earlierCount = settledJournal.length - latest.length;

  if (!session && !error) {
    return (
      <div className="flex h-full flex-col">
        <div className="w-full flex-1 space-y-4 px-4 py-6">
          <Skeleton className="h-5 w-40 rounded-md" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <Alert variant="destructive" className="mx-4 mt-4 w-auto">
          <TriangleAlertIcon />
          <AlertTitle>The master chat could not load</AlertTitle>
          <AlertDescription className="font-mono text-xs break-words">{error}</AlertDescription>
          <Button variant="outline" size="sm" className="mt-2 w-fit" onClick={() => void open()}>
            <RotateCwIcon />
            Retry
          </Button>
        </Alert>
      )}

      {/* THE READING COLUMN — §13.6's second door needs one. `"layer"` fills
          its narrow edge-docked strip as it always has (no wrapper needed:
          the column IS the strip); `"room"` gets the app's own max-w-3xl
          token, centered, so a full-width room does not set the transcript
          in a line as wide as the screen. Everything below — the header
          strip, the scrolling transcript, the openers row, the composer —
          rides inside it as one column, composer pinned to its bottom. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", variant === "room" && "mx-auto w-full max-w-3xl")}>
        {/* WHAT THIS HALF IS, in one line where a header would go. It counts
            nothing at the user — the chat has nothing to count, and a number
            here would be the badge the module refuses everywhere else. */}
        <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <p className="min-w-0 flex-1 truncate text-xs leading-relaxed text-muted-foreground">
            No project — so it can answer across all of them.
          </p>
          {shownTurns.length > 0 && (
            <button
              type="button"
              onClick={startFresh}
              disabled={!!live || sending}
              className="shrink-0 text-[0.6875rem] text-muted-foreground/70 transition-colors hover:text-foreground disabled:hover:text-muted-foreground/70"
            >
              Start fresh
            </button>
          )}
          {onExpand && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Expand to the Assistant room"
              title="Expand to the Assistant room"
              onClick={onExpand}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Maximize2Icon className="size-4" />
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close the assistant"
              title="Close the assistant"
              onClick={onClose}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-4" />
            </Button>
          )}
        </div>

        <ConversationViewport className="min-h-0 flex-1">
          {/* The default gap-8 between turns stands — the transcript's rhythm
              needs the air; only the horizontal padding is narrowed. ROOM
              ADDS `min-h-full justify-end`: the content div sits inside the
              scroll area at its natural (shrink-wrapped) height, so without
              this a short exchange paints at the TOP of a tall viewport with
              a void below it. `min-h-full` floors it to the viewport's
              height and `justify-end` packs its children — the turns — to
              the bottom of that floor, so the newest message ends just above
              the composer; once the transcript outgrows the floor the min
              stops mattering and it scrolls exactly as the layer does. */}
          <ConversationContent className={cn("w-full px-4 py-5", variant === "room" && "min-h-full justify-end")}>
            {/* THE WAY BACK. One control, both directions, and it is how the
                cutoff stays honest: everything "Start fresh" folded away is one
                press from here, never gone. */}
            {earlierCount > 0 && (
              <button
                type="button"
                onClick={() => setShowEarlier((v) => !v)}
                className="mb-2 self-start text-[0.6875rem] text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                {showEarlier ? "just the latest" : `earlier (${earlierCount})`}
              </button>
            )}

            {shownTurns.length === 0 && (
              <div className="flex flex-col gap-2 py-8">
                {/* ORIENTATION, once and in one sentence: what this chat can
                    reach. Below it, the openers say the same thing as things to
                    do — each drawn from the stance's own state, never generated. */}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  It reads and files your spool, remembers where you left off, and answers across every subject.
                </p>
                {/* The app's chip idiom — rounded-full, hairline, quiet fill —
                    so an opener reads as the same kind of object as every other
                    tappable chip in Telar. */}
                <div className="mt-1 flex flex-col items-start gap-1.5">
                  {openers.map((opener) => (
                    <button
                      key={opener}
                      type="button"
                      disabled={!session || sending}
                      onClick={() => send(opener, false)}
                      className="rounded-full border border-border bg-card px-3 py-1.5 text-left text-xs text-foreground shadow-sm transition-colors hover:border-spool/40 hover:bg-muted/40"
                    >
                      {opener}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {shownTurns.map((turn: JournalTurn) => (
              <SessionTurn
                key={turn.runId}
                /* The journal's turn, with the machine-context line stripped
                   from what the transcript SHOWS — the payload keeps it. */
                turn={{ ...turn, prompt: turn.prompt.replace(ROOM_PREFIX, "") }}
                requests={requests.filter((r) => r.runId === turn.runId && r.state === "open")}
                sending={sending}
                live={turn.runId === live?.runId}
                now={now}
                quiet
                onDecide={decide}
                onRetry={() => undefined}
                onDiscard={() => undefined}
              />
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </ConversationViewport>

        {/* CAPABILITY STAYS DISCOVERABLE past the first message: the same
            openers, one quiet row, still tappable. */}
        {shownTurns.length > 0 && openers.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-2">
            {openers.map((opener) => (
              <button
                key={opener}
                type="button"
                disabled={!session || sending}
                onClick={() => send(opener, false)}
                className="max-w-full truncate rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
              >
                {opener}
              </button>
            ))}
          </div>
        )}

        <div className="w-full px-4 pb-4">
          <Composer
            draft={draft}
            ready={!!session}
            attachments={[]}
            onAttach={() => undefined}
            busy={!!live}
            sending={sending}
            queued={queued}
            backgroundTasks={0}
            onDraftChange={setDraft}
            placeholder="Say what you're working on, or dump something and it'll get filed…"
            onSubmit={submit}
            onStop={stop}
            // The master chat runs no background tasks (backgroundTasks={0}), so
            // the chip never renders and this never fires.
            onStopBackground={() => undefined}
            onWithdraw={withdraw}
            onRecall={(item) => {
              withdraw(item.runId);
              setDraft(item.text);
            }}
            onRuntimeMode={() => undefined}
            onModelChange={() => undefined}
            {...(session ? { session } : {})}
            {...(session?.runtimeMode ? { runtimeMode: session.runtimeMode } : {})}
          />
        </div>

        {/* THE MCP CARD — the room's own foot, "room" variant only; the
            summoned layer's narrow strip has no room for it and never
            carried it before this pass either. */}
        {variant === "room" && <McpConnectionsCard />}
      </div>
    </div>
  );
}
