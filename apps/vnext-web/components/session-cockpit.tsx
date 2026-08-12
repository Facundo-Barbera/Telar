"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2Icon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import {
  type EngineEvent,
  type EngineRequest,
  type RequestDecision,
  type Item,
  type ProviderDriverKind,
  type RuntimeMode,
  type Session,
  type Task,
  type Turn,
  type TurnState,
} from "@telar/engine-client";
import { createVNextApi, newVNextRunId, retryAmbiguousTurn, VNextApiError } from "@/lib/vnext/client";
import { appendJournalEvents, isActiveTurn, itemText, projectJournal, type JournalTurn } from "@/lib/vnext/journal";
import { readDraft, writeDraft } from "@/lib/composer-draft";
import { hydrateVNextSession, tailVNextSession } from "@/lib/vnext/session-sync";
import { Composer } from "./composer";
import { ActivityGroup, Marker, TranscriptItem, WorkingIndicator } from "./transcript";
import { browserPanelTab, isPanelTab, latestBrowserState, RailToggle, VNextRightPanel, type PanelTab } from "./right-panel";
import { WorkspaceInspector } from "./session/workspace-inspector";
import {
  closePanelTab,
  emptyPanelTabs,
  openPanelTab,
  readPanelTabs,
  writePanelTabs,
  type PanelTabState,
} from "@/lib/right-panel-tabs";
import { ApprovalCard } from "./approval-card";
import { MainSidebarTrigger } from "./main-sidebar-trigger";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConversationContent, ConversationScrollButton, ConversationViewport } from "@/components/ui/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ui/message";
import { useSidebar } from "@/components/ui/sidebar";

const api = createVNextApi();
/** Below this the session rail, the conversation and the panel cannot all
 *  hold their minimum widths at once. Chosen as rail (16rem) + conversation
 *  floor (24rem) + panel floor (20rem), rounded up. */
const NARROW_WINDOW = 1280;
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
 * The masthead is a BREADCRUMB, not a title bar. Ported from the frozen app's
 * session-view header (apps/web_old/components/session/session-view.tsx).
 *
 * It carries identity and nothing else: no model, no cost, no working indicator.
 * Account/model/context/spend belong to the composer, and a running turn is
 * announced at the TAIL of the transcript where the work is, so the eye has one
 * place to look rather than two that can disagree.
 *
 * NO BOTTOM BORDER, and a translucent blurred ground instead. The transcript
 * scrolls UNDER this bar; a hard rule would cut the column, where
 * `bg-background/65 backdrop-blur` lets the text approach and dissolve.
 */
function SessionMasthead({
  projectId,
  projectName,
  session,
  sending,
  onRename,
  panel,
}: {
  projectId: string;
  /** Resolved from the project record. Absent until it loads — the breadcrumb
   *  falls back to the id rather than showing a gap, but an opaque
   *  `project_1a1649…` is addressing, not a name a person navigates by. */
  projectName?: string;
  session?: Session;
  sending: boolean;
  onRename: (title: string) => void;
  /** The session panel's triggers. Passed in rather than constructed here so the
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
    <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 bg-background/65 px-4 py-1.5 backdrop-blur">
      <div className="mr-1 flex min-w-0 items-center gap-2 text-sm">
        {/* Only mounts while the rail is hidden, leaving the workspace at true
            full width when it is not. The folder glyph stands in for it so the
            breadcrumb does not shift sideways when the rail opens. */}
        <MainSidebarTrigger className="-mx-[7px]" fallback={<FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />} />
        <Link href="/" className="shrink-0 truncate text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {projectName ?? session?.projectId ?? projectId}
        </Link>
        <span className="text-border">/</span>
        {editing ? (
          <Input
            className="h-6 max-w-xs text-base font-semibold"
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
          <span className="group/title inline-flex min-w-0 items-center gap-1 font-semibold">
            <span className="truncate" title={title}>
              {title}
            </span>
            {session && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Rename session"
                disabled={sending}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100 focus-visible:opacity-100"
                onClick={() => {
                  setDraftTitle(title);
                  setEditing(true);
                }}
              >
                <PencilIcon />
              </Button>
            )}
          </span>
        )}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">{panel}</div>
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
  onDecide: (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) => void;
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
        <MessageContent from="user">
          <p className="whitespace-pre-wrap">{turn.prompt}</p>
        </MessageContent>
      </Message>

      <Message from="assistant">
        <MessageContent from="assistant">
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

/**
 * @param routeSessionId Absent on the NEW-CONVERSATION front door
 *   (`/projects/:id/sessions/new`), where nothing is persisted until the first
 *   message is sent.
 */
export function SessionCockpit({ projectId, sessionId: routeSessionId }: { projectId: string; sessionId?: string }) {
  /**
   * THE SESSION ID IS STATE, NOT JUST A PROP.
   *
   * A fresh conversation has no session until its first message creates one, and
   * at that moment the URL is rewritten with `history.replaceState` rather than
   * a router navigation — a navigation would remount this component and throw
   * away the turn that was just submitted, along with its polling loop. So the
   * id has to be able to change underneath a mounted cockpit.
   */
  const [sessionId, setSessionId] = useState(routeSessionId);
  /** No session yet: the composer is the whole screen and nothing is polled. */
  const fresh = !sessionId;
  /**
   * What the FIRST message will create the session with. Only meaningful while
   * fresh — once a session exists, its own record is the truth and the picker
   * patches that instead.
   */
  const [draftDriver, setDraftDriver] = useState<ProviderDriverKind>("claude");
  const [draftModel, setDraftModel] = useState<{ model?: string; effort?: string }>({});
  const [session, setSession] = useState<Session>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [requests, setRequests] = useState<EngineRequest[]>([]);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [draftRunId, setDraftRunId] = useState<string>();
  const [error, setError] = useState<VNextApiError>();
  /** Seeded from whether there is anything to load at all — a fresh canvas has
   *  no transcript to hydrate, so it must never paint a loading state. */
  const [loading, setLoading] = useState(Boolean(routeSessionId));
  const [sending, setSending] = useState(false);
  /**
   * The panel's open tabs, and whether the panel itself is showing.
   *
   * CLOSED, WITH NO TABS, UNTIL ASKED. This used to open on mount with all four
   * surfaces mounted and "Agents" selected, which decides for you what you were
   * about to look at and takes a third of the window to do it. Lifted out of the
   * panel because the pinned summary and the composer's foot both need to say
   * "go there", which means opening a tab that may not exist yet.
   */
  const [panel, setPanel] = useState<PanelTabState<PanelTab>>(() => emptyPanelTabs<PanelTab>());
  const [projectName, setProjectName] = useState<string>();
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
        // Nothing to read before the first message creates the session.
        if (!sessionId) return;
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
        if (!sessionId) return;
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

  /**
   * Restore this session's panel AFTER mount, never during render.
   *
   * `localStorage` does not exist on the server, so seeding `useState` from it
   * would make the first client render disagree with the server's and throw the
   * whole tree away. Reading it in an effect costs one extra paint and is the
   * only shape that is correct in both places.
   */
  useEffect(() => {
    if (!sessionId) return;
    // Deferred to a task rather than called in the effect body: a synchronous
    // setState there is a cascading render, and it is the same rule the git
    // readout in workspace-environment.tsx follows.
    const task = window.setTimeout(() => setPanel(readPanelTabs<PanelTab>(sessionId, isPanelTab)), 0);
    return () => window.clearTimeout(task);
  }, [sessionId]);

  const updatePanel = useCallback(
    (next: (current: PanelTabState<PanelTab>) => PanelTabState<PanelTab>) => {
      setPanel((current) => {
        const updated = next(current);
        if (sessionId) writePanelTabs(sessionId, updated, Date.now());
        return updated;
      });
    },
    [sessionId],
  );
  /** Folded once here rather than in both the panel and the pinned summary, so
   *  the two cannot disagree about which tabs are open. */
  const browser = useMemo(() => latestBrowserState(events), [events]);

  /**
   * THREE COLUMNS DO NOT FIT A LAPTOP. Opening the panel on a narrow window
   * collapses the session rail.
   *
   * The rail, the conversation and the panel each have a width below which they
   * stop working, and on a ~1200px window their three floors do not fit. Left
   * alone, CSS resolves that by squeezing whichever is most compressible — which
   * was the panel, down to a column of ellipses. The rail is the right thing to
   * give up: it is navigation you have already used to get here, one click
   * restores it, and its collapsed state is remembered.
   *
   * ONLY ON THE OPENING TRANSITION, and only when it is actually tight — so a
   * rail you deliberately reopened alongside the panel stays open, and a wide
   * window never loses it at all. Called from event handlers rather than an
   * effect on `panel.open`, which is what keeps this a consequence of your click
   * instead of a render-phase surprise.
   */
  const { open: railOpen, setOpen: setRailOpen } = useSidebar();
  const makeRoomForPanel = useCallback(() => {
    if (!railOpen) return;
    if (window.innerWidth >= NARROW_WINDOW) return;
    setRailOpen(false);
  }, [railOpen, setRailOpen]);

  /** Open the panel on a named surface — what every "go there" gesture calls. */
  const showPanelTab = useCallback(
    (tab: PanelTab) => {
      makeRoomForPanel();
      updatePanel((current) => openPanelTab(current, tab));
    },
    [makeRoomForPanel, updatePanel],
  );

  /**
   * A PAGE THE ENGINE JUST OPENED GETS A TAB, the way it would in a browser.
   *
   * Only while the panel is ALREADY open, though. Opening a page is the agent's
   * decision, not yours, so it may not interrupt what you are reading — but if
   * you are watching the panel, a new page appearing as a new tab is the least
   * surprising thing that can happen. `seenPages` is a ref rather than derived
   * state so that closing a tab does not immediately reopen it on the next poll.
   */
  const seenPages = useRef<Set<string>>(new Set());
  useEffect(() => {
    const pages = browser?.tabs ?? [];
    const fresh = pages.filter((page) => !seenPages.current.has(page.id));
    for (const page of pages) seenPages.current.add(page.id);
    if (fresh.length === 0) return;
    updatePanel((current) => {
      if (!current.open) return current;
      return fresh.reduce((state, page) => openPanelTab(state, browserPanelTab(page.id)), current);
    });
  }, [browser, updatePanel]);

  /**
   * Restore an unsent draft, and keep it saved as it is typed.
   *
   * Read in an effect for the same reason the panel state is: `localStorage`
   * does not exist during the server render, so seeding `useState` from it would
   * make the two disagree. The write is debounced because it runs on every
   * keystroke and a synchronous `setItem` per character is a jank source on a
   * long message.
   */
  useEffect(() => {
    const task = window.setTimeout(() => {
      const stored = readDraft(sessionId, projectId);
      // Never clobber something already typed — the restore is a fallback for an
      // empty box, not an authority over it.
      if (stored) setDraft((current) => current || stored);
    }, 0);
    return () => window.clearTimeout(task);
  }, [sessionId, projectId]);

  useEffect(() => {
    const task = window.setTimeout(() => writeDraft(sessionId, projectId, draft), 400);
    return () => window.clearTimeout(task);
  }, [draft, sessionId, projectId]);

  // The session record carries a project ID, not its name. One list call
  // resolves it; a failure leaves the breadcrumb on the id, which is worse to
  // read but never wrong.
  useEffect(() => {
    let cancelled = false;
    void api.projects().then(
      (result) => !cancelled && setProjectName(result.projects.find((project) => project.id === projectId)?.name),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    // A fresh canvas has nothing to hydrate and nothing to poll — and polling a
    // session that does not exist yet is how a new-conversation screen ends up
    // making one request a second to a 404. `loading` is seeded false for that
    // case rather than cleared here: clearing it would be a setState in an
    // effect body, and the answer is known before the first render anyway.
    if (!sessionId) return;
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
  }, [hydrate, tail, sessionId]);

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
    if (!active || !sessionId) return;
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
  const decideRequest = async (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) => {
    // Every one of these acts on a session that must already exist; the fresh
    // canvas offers none of them.
    if (!sessionId) return;
    setSending(true);
    try {
      await api.resolveRequest(sessionId, requestId, { decision, ...(extra?.answers ? { answers: extra.answers } : {}) });
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not answer the approval."));
    } finally {
      setSending(false);
    }
  };
  const discardAmbiguous = async (turn: Pick<Turn, "runId">) => {
    if (!sessionId) return;
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
    if (!sessionId) return;
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
      /**
       * THE FIRST MESSAGE IS WHAT CREATES THE SESSION.
       *
       * A new conversation is a composer and nothing else until you send — no
       * empty session in the rail, no record for a thought you abandoned. The
       * title comes from the message because the alternative is a list full of
       * "Untitled session", and the URL is rewritten with `replaceState` rather
       * than a router push: a navigation here would remount this component and
       * discard the turn we are in the middle of submitting.
       */
      let target = sessionId;
      if (!target) {
        const created = await api.createSession(projectId, {
          title: text.replace(/\s+/g, " ").slice(0, 80),
          driver: draftDriver,
        });
        target = created.session.id;
        if (draftModel.model) {
          await api.updateSession(target, {
            model: {
              instanceId: created.session.providerInstanceId,
              model: draftModel.model,
              ...(draftModel.effort ? { effort: draftModel.effort } : {}),
            },
          });
        }
        setSessionId(target);
        setSession(created.session);
        window.history.replaceState(null, "", `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(target)}`);
      }
      await api.submitTurn(target, { runId, input: text });
      // Only for a session that ALREADY existed. A just-created one is hydrated
      // by the effect that fires when `sessionId` changes, and calling it here
      // would run against the stale id captured in this closure.
      if (sessionId) await hydrate();
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
    if (!sessionId) return;
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
    if (!sessionId) return;
    try {
      const next = await api.updateSession(sessionId, { title: nextTitle });
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not rename the session."));
    }
  };
  /**
   * Change the model the NEXT turn runs on.
   *
   * Not gated on `sending`, and deliberately usable mid-turn: the engine
   * resolves the model when a worker CLAIMS a turn, so this can never disturb
   * work already in flight — it only decides what the next one runs on. The
   * instance id comes from the session because the engine rejects a model that
   * does not belong to it.
   */
  const setModel = async (next: { model?: string; effort?: string }) => {
    if (!session || !sessionId) return;
    try {
      const updated = await api.updateSession(sessionId, {
        model: next.model
          ? { instanceId: session.providerInstanceId, model: next.model, ...(next.effort ? { effort: next.effort } : {}) }
          : undefined,
      });
      setSession(updated.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof VNextApiError ? cause : new VNextApiError("internal_error", "Could not change the model."));
    }
  };
  const setRuntimeMode = async (mode: RuntimeMode) => {
    if (!sessionId) return;
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
  /**
   * The NEWEST reported usage, not the active turn's: a running turn has no
   * figures yet, and blanking the context readout the moment work starts is
   * exactly when a person most wants to know how much room is left.
   */
  const newestUsage = [...transcript].reverse().find((turn) => turn.usage)?.usage;
  /** Background work outlives the turn that started it, so it is counted over
   *  every task rather than over the active turn's. */
  const backgroundTasks = tasks.filter((task) => task.kind === "background" && (task.state === "running" || task.state === "pending")).length;

  return (
    /**
     * THE PANEL IS A COLUMN OF THE ROOM, NOT A SHEET OVER IT.
     *
     * The row is the top-level element and the panel is its second child, so
     * opening the panel NARROWS the conversation — transcript, composer and
     * masthead all reflow — instead of covering it. That is the whole point:
     * you open this to watch the agent while you keep working, and a surface
     * that hides the thing it reports on cannot do that.
     *
     * It also means the panel runs the FULL HEIGHT of the window. The masthead
     * lives inside the conversation column (below), so the panel's top edge is
     * the window's top edge rather than a step down from a bar that spans the
     * app. `min-w-0` on the column is what keeps a long unbroken line from
     * widening the row instead of scrolling inside its own box.
     */
    <main className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <SessionMasthead
          projectId={projectId}
          projectName={projectName}
          session={session}
          sending={sending}
          onRename={(next) => void rename(next)}
          panel={
            <>
              <WorkspaceInspector
                projectId={session?.projectId ?? projectId}
                {...(projectName ? { projectName } : {})}
                {...(session ? { session } : {})}
                tasks={tasks}
                {...(browser ? { browser } : {})}
                onOpenPanel={showPanelTab}
              />
              <RailToggle
                open={panel.open}
                onToggle={() => {
                  makeRoomForPanel();
                  updatePanel((current) => ({ ...current, open: true }));
                }}
              />
            </>
          }
        />
        <ConversationViewport className="min-w-0 flex-1">
          <ConversationContent>
            {projectId !== session?.projectId && session && (
              <Alert variant="destructive" className="mx-auto max-w-[50rem]">
                <TriangleAlertIcon />
                <AlertDescription>This URL’s project does not match the engine-owned session record.</AlertDescription>
              </Alert>
            )}
            {error && <SessionProblem error={error} />}
            {/* A fresh canvas shows NOTHING here. The composer is lifted to the
                middle of the screen and is the whole interface; an empty-state
                card above it would be a second thing competing to be read. */}
            {!error && !fresh && shown.length === 0 && <EmptyTranscript loading={loading} />}
            {shown.map((turn) => (
              <SessionTurn
                key={turn.runId}
                turn={turn}
                live={turn.runId === active?.runId}
                now={now}
                requests={openRequests.filter((request) => request.runId === turn.runId)}
                sending={sending}
                onDecide={(requestId, decision, extra) => void decideRequest(requestId, decision, extra)}
                onRetry={(item) => void retryAmbiguous(item)}
                onDiscard={(item) => void discardAmbiguous(item)}
              />
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </ConversationViewport>
        <Composer
          draft={draft}
          // A fresh canvas is READY: there is nothing to wait for, because the
          // message you type is the thing that creates the session.
          ready={fresh || Boolean(session)}
          fresh={fresh}
          {...(fresh ? { driver: draftDriver, onDriverChange: setDraftDriver, pendingModel: draftModel } : {})}
          busy={Boolean(active)}
          sending={sending}
          queued={queued}
          runtimeMode={session?.runtimeMode}
          projectId={session?.projectId ?? projectId}
          {...(projectName ? { projectName } : {})}
          {...(session ? { session } : {})}
          {...(newestUsage ? { usage: newestUsage } : {})}
          backgroundTasks={backgroundTasks}
          onDraftChange={(nextDraft) => {
            setDraft(nextDraft);
            setDraftRunId(undefined);
          }}
          onSubmit={() => void submit()}
          onStop={() => void stop()}
          onWithdraw={(runId) => void withdraw(runId)}
          /**
           * Recall WITHDRAWS the queued turn and puts its words back in the box.
           *
           * The text is restored optimistically, before the withdraw round trip,
           * so the box fills the instant you click; if the withdraw fails the
           * error surfaces and the line is still queued, which is recoverable.
           * Losing the words to a failed request would not be.
           */
          onRecall={(item) => {
            setDraft((current) => (current ? `${current}\n${item.text}` : item.text));
            void withdraw(item.runId);
          }}
          onRuntimeMode={(mode) => void setRuntimeMode(mode)}
          // Before a session exists there is nothing to patch — the choice is
          // held locally and applied when the first message creates it.
          onModelChange={fresh ? setDraftModel : (next) => void setModel(next)}
          onOpenChanges={() => showPanelTab("changes")}
        />
      </div>
      {panel.open && (
        <VNextRightPanel
          {...(active?.state ? { active: active.state } : {})}
          items={items}
          tasks={tasks}
          turns={turns}
          events={events}
          tabs={panel.tabs}
          {...(panel.activeTab ? { tab: panel.activeTab } : {})}
          onTabChange={(tab) => updatePanel((current) => ({ ...current, activeTab: tab }))}
          onOpenTab={showPanelTab}
          onCloseTab={(tab) => updatePanel((current) => closePanelTab(current, tab))}
          onClose={() => updatePanel((current) => ({ ...current, open: false }))}
        />
      )}
    </main>
  );
}
