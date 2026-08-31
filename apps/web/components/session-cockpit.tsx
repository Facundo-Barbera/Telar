"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EyeIcon, FolderGit2Icon, PaperclipIcon, PencilIcon, TriangleAlertIcon, WorkflowIcon } from "lucide-react";
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
import { createEngineApi, newRunId, retryAmbiguousTurn, EngineApiError } from "@/lib/engine/client";
import { appendJournalEvents, isActiveTurn, isCompacting, itemText, projectJournal, taskRoster, type JournalTurn } from "@/lib/engine/journal";
import { canvasHref } from "@/lib/session-list";
import { questionFields } from "@/lib/question-drawer";
import { cn } from "@/lib/utils";
import { readDraft, writeDraft } from "@/lib/composer-draft";
import type { ModelChoice } from "@/lib/models";
import { hydrateSession, tailSession } from "@/lib/engine/session-sync";
import { Composer } from "./composer";
import { ActivityGroup, Marker, TranscriptItem, turnActivity, WorkingIndicator } from "./transcript";
import { browserPanelTab, isPanelTab, latestBrowserState, RailToggle, RightPanel, type PanelTab, type TaskFocus } from "./right-panel";
import { WorkspaceInspector } from "./session/workspace-inspector";
import { PromptText } from "./session/prompt-text";
import {
  canvasPanelKey,
  closePanelTab,
  emptyPanelTabs,
  openPanelTab,
  readPanelTabs,
  writePanelTabs,
  type PanelTabState,
} from "@/lib/right-panel-tabs";
import { ApprovalCard } from "./approval-card";
import { MainSidebarTrigger, useMainIsLeftmost } from "./main-sidebar-trigger";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConversationContent, ConversationScrollButton, ConversationViewport } from "@/components/ui/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ui/message";
import { useSidebar } from "@/components/ui/sidebar";

const api = createEngineApi();
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
  steering: "Sending into the running turn",
  steered: "Sent into the running turn",
};

export function describeTurnState(state: TurnState): { label: string; tone: "active" | "done" | "attention" | "danger" | "muted" } {
  if (state === "queued") return { label: "Queued", tone: "active" };
  if (state === "claimed") return { label: "Claimed", tone: "active" };
  if (state === "running") return { label: "Streaming", tone: "active" };
  if (state === "completed") return { label: terminal.completed, tone: "done" };
  if (state === "failed") return { label: terminal.failed, tone: "danger" };
  if (state === "ambiguous") return { label: terminal.ambiguous, tone: "attention" };
  if (state === "stopped") return { label: terminal.stopped, tone: "muted" };
  if (state === "steering") return { label: terminal.steering, tone: "active" };
  if (state === "steered") return { label: terminal.steered, tone: "done" };
  return { label: terminal.discarded, tone: "muted" };
}

function SessionProblem({ error }: { error: EngineApiError }) {
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
  readOnly = false,
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
  /** Observe mode: the title is a fact, not a field, and there is no spin —
   *  a loom-owned session cannot be spun into another loom. */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  /**
   * "New conversation" UNTIL ONE EXISTS, rather than "Session".
   *
   * The breadcrumb states what you are looking at, and on a fresh canvas that is
   * not a session — there is no record, no id, and nothing to rename. Naming it
   * "Session" implied one had already been created, which is the exact thing
   * this screen is careful not to do: the first message creates it, and the
   * title is derived from that message.
   */
  const title = session?.title ?? "New conversation";
  // Whether this header is the window's left edge — see main-sidebar-trigger.
  const mainIsLeftmost = useMainIsLeftmost();

  const commit = () => {
    setEditing(false);
    const next = draftTitle.trim();
    // Empty or unchanged is a silent cancel, not an error and not a write.
    if (next && next !== title) onRename(next.slice(0, 120));
  };

  return (
    /* `app-drag` because this row is the top of the window on the macOS shell,
       and a titlebar you cannot grab is the one thing this must not become.
       Every control inside it opts back out — see globals.css.
       THE INSET IS CONDITIONAL because this header is only the window's LEFT
       edge while the rail is hidden; with the rail open the rail's own header
       has already left room for the traffic lights, and insetting here too
       would push the breadcrumb 76px off the wall for no reason. */
    /* NOT `flex-wrap`, AND THAT WAS A REAL BUG. A long session title plus the
       right panel open pushed the panel triggers onto a second row, where they
       floated over the transcript with nothing beside them — a control that had
       visibly come loose from its header. The title is the only thing here that
       can give ground, so it truncates (`min-w-0` below) and the row stays one
       row at every width. */
    <header
      className={cn(
        "app-drag flex min-h-[var(--titlebar-height)] shrink-0 items-center gap-2 bg-background/65 py-1.5 pr-4 backdrop-blur",
        mainIsLeftmost ? "pl-[calc(var(--titlebar-inset)+1rem)]" : "pl-4",
      )}
    >
      <div className="mr-1 flex min-w-0 flex-1 items-center gap-2 text-sm">
        {/* Only mounts while the rail is hidden, leaving the workspace at true
            full width when it is not. The folder glyph stands in for it so the
            breadcrumb does not shift sideways when the rail opens. */}
        <MainSidebarTrigger className="-mx-[7px]" fallback={<FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />} />
        {/* The breadcrumb names the PROJECT, so pressing it lands in that
            project — on its canvas, which is what "this project, right now"
            looks like. It pointed at the retired `/projects` table, which named
            every project and therefore answered a question nobody had asked. */}
        <Link
          href={canvasHref(projectId)}
          className="app-no-drag shrink-0 truncate text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {projectName ?? session?.projectId ?? projectId}
        </Link>
        <span className="text-border">/</span>
        {editing ? (
          <Input
            className="app-no-drag h-6 max-w-xs text-base font-semibold"
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
            {session && !readOnly && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Rename session"
                disabled={sending}
                className="app-no-drag shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100 focus-visible:opacity-100"
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
      {/* The whole trailing cluster is controls, so it opts out as a block
          rather than one button at a time. `shrink-0`: these are fixed-size
          glyphs, and the title beside them is what absorbs a narrow window. */}
      <div className="app-no-drag ml-auto flex shrink-0 items-center gap-2">
        {/* SPIN INTO LOOM (docs/loom-model-v1.md): when this conversation has
            produced enough shape, hand it to the weaver. The session becomes
            the loom's origin and detaches — it leaves this surface and lives
            in the loom's room from then on. */}
        {session && !readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Spin into loom"
            title="Spin into loom"
            render={<Link href={`/looms/new?spin=${encodeURIComponent(session.id)}`} />}
          >
            <WorkflowIcon />
          </Button>
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
 * `formatCost` USED TO LIVE HERE, printing a per-turn price beside the tokens.
 *
 * Money left this cockpit deliberately. `UsageSnapshot.costUsd` is still on the
 * contract because it is the provider's own figure and discarding it upstream
 * would be lossy — but a price rendered here is one only some providers report,
 * that a subscription seat does not have at all, and that reads as authoritative
 * next to a token count that always is. Tokens are the unit everywhere now.
 */

/** The journal separates the submitted prompt from streamed agent output. */
export function retryInputForJournalTurn(turn: Pick<JournalTurn, "runId" | "state" | "prompt">): Pick<Turn, "runId" | "state" | "input"> {
  return { runId: turn.runId, state: turn.state, input: turn.prompt };
}

/**
 * ONE TURN, RENDERED — your message, then everything the agent did about it.
 *
 * EXPORTED, AND IT COSTS NOTHING TO EXPORT: this component reads `projectId`
 * zero times. It was written for the project cockpit and turns out to be the
 * shared conversation shell the Spool's master chat needed — the extraction the
 * donor planned, already done by accident because nothing in a rendered turn is
 * a property of a repository.
 *
 * So the master chat consumes THIS rather than hand-rebuilding a second
 * transcript. The donor's own rule for that situation was to stop rather than
 * build the second one, and the reason is visible here: approvals, sub-agent
 * chips, the activity fold, the live step window and the ambiguous-turn recovery
 * are all decided in this function. A copy would start identical and drift.
 */
export function SessionTurn({
  turn,
  requests,
  sending,
  live,
  now,
  quiet = false,
  onDecide,
  onRetry,
  onDiscard,
  onOpenAgent,
  onOpenTab,
}: {
  /**
   * CONVERSATION FIRST, TELEMETRY BEHIND A FOLD. The Spool's chat sets this:
   * there, a settled turn's step summary and token count read as telemetry
   * presented as conversation, so both fold behind one quiet disclosure and
   * the answer leads. The cockpit leaves it unset and renders exactly as it
   * always has — a LIVE turn ignores it too, because the step window is the
   * one part of the work worth watching while it happens.
   */
  quiet?: boolean;
  requests: EngineRequest[];
  onDecide: (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) => void;
  /** Pressing a sub-agent's chip: the transcript names it, the cockpit opens
   *  the panel on it. */
  onOpenAgent?: (taskId: string) => void;
  /** Pressing an issue, pull request or file chip in the message you SENT. The
   *  reference was actionable enough for the agent; it should be actionable for
   *  the person who wrote it. */
  onOpenTab?: (tab: PanelTab) => void;
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
  /** What the line under the turn says it is doing — see `turnActivity`. */
  const doing = turnActivity(turn);
  const lastProse = turn.items.map((item) => item.detail.type).lastIndexOf("assistant_message");
  const activity = lastProse === -1 ? turn.items : turn.items.slice(0, lastProse);
  const closing = lastProse === -1 ? [] : turn.items.slice(lastProse);
  const streamedAnswer = closing.some((item) => itemText(item));
  /** The quiet fold's own toggle. Per turn, never persisted — looking at how
   *  one answer was made is a glance, not a mode. */
  const [workShown, setWorkShown] = useState(false);
  const folded = quiet && !live;

  return (
    <div className="flex flex-col gap-8">
      <Message from="user">
        <MessageContent from="user">
          {/* THE SAME CHIPS THE COMPOSER DREW. This was `{turn.prompt}` in a
              bare paragraph, so every reference a gesture had put in the box
              came back as raw text the moment it was sent — a dropped issue
              reappearing as `#409 "…" (https://github.com/…)`, URL and all.
              Nothing is stored to fix it: the draft has always been plain text
              with the chips derived from it, and this reads it the same way. */}
          <PromptText text={turn.prompt} {...(onOpenTab ? { onOpen: onOpenTab } : {})} />
          {/* WHAT WAS SENT, not what the model made of it. A transcript that
              shows the words and not the screenshot has lost half the message —
              and re-reading it later is exactly when that half matters. Named
              rather than rendered: the bytes live beside the session on the
              engine's disk, and no route serves them back to a browser. */}
          {turn.attachments?.length ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {turn.attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  title={attachment.path}
                  className="flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
                >
                  <PaperclipIcon className="size-3 shrink-0" />
                  <span className="max-w-48 truncate">{attachment.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </MessageContent>
      </Message>

      <Message from="assistant">
        <MessageContent from="assistant">
          {requests.map((request) => (
            <ApprovalCard key={request.id} request={request} sending={sending} onDecide={onDecide} />
          ))}
          {!folded && (
            <ActivityGroup items={activity} tasks={turn.tasks} live={live} {...(onOpenAgent ? { onOpenAgent } : {})} />
          )}
          {closing.map((item) => (
            <TranscriptItem key={item.id} item={item} />
          ))}
          {!streamedAnswer && turn.resultText && <MessageResponse>{turn.resultText}</MessageResponse>}
          {turn.failure && <Marker attention>{turn.failure}</Marker>}
          {turn.state === "stopped" && <Marker>stopped — kept what arrived</Marker>}
          {turn.state === "discarded" && <Marker>{describeTurnState(turn.state).label.toLowerCase()}</Marker>}
          {live && (
            <WorkingIndicator
              label={doing.label}
              delegated={doing.delegated}
              startedAt={turn.startedAt}
              {...(turn.lastActivityAt ? { lastActivityAt: turn.lastActivityAt } : {})}
              now={now}
            />
          )}
          {!folded && turn.usage && !live && (
            <p className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
              {(turn.usage.tokens.input + turn.usage.tokens.output).toLocaleString()} tokens
            </p>
          )}
          {folded && (activity.length > 0 || turn.usage) && (
            <div>
              {/* A quiet INLINE control in the message flow, not floating mono
                  micro-text — the Spool's transcript is the only caller of the
                  quiet fold, and this is its one disclosure. */}
              <button
                type="button"
                aria-expanded={workShown}
                onClick={() => setWorkShown((v) => !v)}
                className="mt-1 inline-flex items-center gap-1 rounded-md text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                {workShown ? "hide the work" : "how it did this"}
              </button>
              {workShown && (
                <div className="mt-2 space-y-2">
                  <ActivityGroup items={activity} tasks={turn.tasks} live={live} {...(onOpenAgent ? { onOpenAgent } : {})} />
                  {turn.usage && (
                    <p className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                      {(turn.usage.tokens.input + turn.usage.tokens.output).toLocaleString()} tokens
                    </p>
                  )}
                </div>
              )}
            </div>
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
export function SessionCockpit({
  projectId,
  sessionId: routeSessionId,
  projectName: serverProjectName,
  greeting,
  observe = false,
}: {
  projectId: string;
  sessionId?: string;
  /** Resolved by the page, so the breadcrumb and the greeting never paint the
   *  raw id first and correct themselves a moment later. */
  projectName?: string;
  /** Which phrase the canvas opens on. Chosen on the server for the same
   *  reason: a phrase picked after mount is a phrase the reader watches
   *  change. */
  greeting?: number;
  /**
   * WATCHING, NOT DRIVING. A loom's worker thread is driven by its loom —
   * brief, contract, conductor nudges — and a human typing into it would be
   * a second boss. Observe mode keeps everything that informs (transcript,
   * panel, diff) and removes everything that drives: the composer, rename,
   * spin. Engine requests (an agent's explicit question) stay answerable —
   * a parked question IS for a human. The conductor and origin sessions are
   * never observed: talking there is steering, which is the human's job.
   */
  observe?: boolean;
}) {
  /**
   * THE SESSION ID IS STATE, NOT JUST A PROP.
   *
   * A fresh conversation has no session until its first message creates one, and
   * at that moment the URL is rewritten with `history.replaceState` rather than
   * a router navigation — a navigation would remount this component and throw
   * away the turn that was just submitted, along with its polling loop. So the
   * id has to be able to change underneath a mounted cockpit.
   */
  const [createdSessionId, setCreatedSessionId] = useState<string>();
  /**
   * …WHICH MEANS THE ROUTE HAS TO BE ABLE TO TAKE IT BACK.
   *
   * `history.replaceState` moves the address bar and `usePathname`, but it does
   * NOT re-render the route segment: the tree still holds the `sessions/new`
   * page. So pressing "New conversation" pushed a URL the router considered a
   * navigation, rendered the same segment it was already rendering, reused this
   * very component instance — and left the conversation on screen. The button
   * did nothing, once per session, forever after the first message.
   *
   * Reading the id off the PATHNAME closes that hole without giving up the
   * in-place rewrite: on the canvas path there is no session, whatever this
   * component created a moment ago.
   */
  const onCanvas = usePathname() === canvasHref(projectId);
  const sessionId = routeSessionId ?? (onCanvas ? undefined : createdSessionId);
  /** No session yet: the composer is the whole screen and nothing is polled. */
  const fresh = !sessionId;
  /**
   * What the FIRST message will create the session with. Only meaningful while
   * fresh — once a session exists, its own record is the truth and the picker
   * patches that instead.
   */
  const [draftDriver, setDraftDriver] = useState<ProviderDriverKind>("claude");
  /** Where the first message will land. `local` matches the engine's own
   *  default, so an untouched canvas creates what it says it will. */
  const [draftEnvMode, setDraftEnvMode] = useState<"local" | "worktree">("local");
  /** The base-ref picker's create-time choice: what a worktree is cut from,
   *  and optionally the human's own name for its branch. Only meaningful with
   *  `envMode: "worktree"` — picking a base is what flips the mode there. */
  const [draftBase, setDraftBase] = useState<{ baseRef?: string; branchName?: string }>({});
  /**
   * How much rope the session will start with.
   *
   * `auto` IS THE ENGINE'S OWN DEFAULT for a detached session
   * (`DEFAULT_DETACHED_RUNTIME_MODE`), so an untouched canvas creates exactly
   * what it says it will. Without this the access control simply did not exist
   * before the first message — the composer read it off a session that did not
   * exist yet — and a narrow window's overflow menu had nothing in it but
   * Reasoning.
   */
  const [draftRuntimeMode, setDraftRuntimeMode] = useState<RuntimeMode>("auto");
  /**
   * Every provider knob the first message will create the session with. One
   * value, so no control can clear another's field — see `ModelChoice`.
   *
   * NOT SEEDED WITH A MODEL, and that is the honest shape now that the picker
   * asks the provider which model is default. An absent model means "run the
   * default", the picker SHOWS which one that is, and nothing has to be written
   * for the two to agree. Seeding an id here would have meant guessing — and
   * the guess for Codex was wrong by two generations.
   */
  const [draftModel, setDraftModel] = useState<ModelChoice>({});
  /**
   * Switching provider clears the choice, because a Claude id is not a thing
   * Codex can run — and neither are its effort levels or its Claude-only
   * switches.
   */
  const chooseDriver = useCallback((next: ProviderDriverKind) => {
    setDraftDriver(next);
    setDraftModel({});
  }, []);
  /**
   * THE RECORD, AND WHETHER IT IS THIS SCREEN'S. Held separately from the id for
   * the same reason the journal is gated above: a canvas reached by pressing
   * "New conversation" still has the last session's record in hand, and it went
   * on naming that conversation in the breadcrumb above an empty composer.
   */
  const [sessionRecord, setSession] = useState<Session>();
  const session = sessionId ? sessionRecord : undefined;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [requests, setRequests] = useState<EngineRequest[]>([]);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [draft, setDraft] = useState("");
  /** Files picked but not yet sent. Held as `File`s rather than uploaded on
   *  pick — see the upload loop in `submit` for why. */
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draftRunId, setDraftRunId] = useState<string>();
  const [error, setError] = useState<EngineApiError>();
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
  /**
   * SEEDED FROM THE SERVER when the page could resolve it, which is every case
   * that matters — the canvas. The client read below stays for the session
   * routes, which do not have it, and for a project renamed while open.
   */
  const [projectName, setProjectName] = useState<string | undefined>(serverProjectName);
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
        const hydrated = await hydrateSession(api, sessionId);
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
        const update = await tailSession(api, sessionId, cursor.current);
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
  /**
   * Where this cockpit's panel state lives.
   *
   * A CANVAS HAS ONE TOO. Before this, the arrangement only persisted once a
   * session existed, so a new-conversation canvas reset its panel on every
   * visit and again the moment the first message landed — the surfaces you had
   * open to write that message vanished as it sent.
   */
  const panelKey = sessionId ?? canvasPanelKey(projectId);

  useEffect(() => {
    // Deferred to a task rather than called in the effect body: a synchronous
    // setState there is a cascading render, and it is the same rule the git
    // readout in workspace-environment.tsx follows.
    const task = window.setTimeout(() => setPanel(readPanelTabs<PanelTab>(panelKey, isPanelTab)), 0);
    return () => window.clearTimeout(task);
  }, [panelKey]);

  const updatePanel = useCallback(
    (next: (current: PanelTabState<PanelTab>) => PanelTabState<PanelTab>) => {
      setPanel((current) => {
        const updated = next(current);
        writePanelTabs(panelKey, updated, Date.now());
        return updated;
      });
    },
    [panelKey],
  );
  /** Folded once here rather than in both the panel and the pinned summary, so
   *  the two cannot disagree about which tabs are open. */
  const browser = useMemo(() => latestBrowserState(events), [events]);

  /**
   * Whether pressing "open a browser" could work HERE, asked once per session.
   * False when the engine's worker owns the browser out-of-process — offering
   * the button there would start a second browser beside the agent's own, so
   * the affordance hides instead (see BrowserSnapshot.canStart).
   */
  const [browserCanStart, setBrowserCanStart] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Deferred to a task, same rule as the panel restore above: a synchronous
    // setState in an effect body is a cascading render.
    const task = window.setTimeout(() => {
      setBrowserCanStart(false);
      if (!sessionId) return;
      api.browserState(sessionId).then(
        (result) => {
          if (!cancelled) setBrowserCanStart(result.browser.canStart ?? false);
        },
        () => undefined,
      );
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [sessionId]);

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
   * Launch the session's browser by hand. The engine journals what it opened,
   * so the tab ALSO arrives through the ordinary event fold — the direct
   * `showPanelTab` here is only what makes the gesture feel immediate instead
   * of waiting one sync cycle.
   */
  const openBrowser = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await api.browserState(sessionId, { start: true });
      const active = result.browser.tabs.find((tab) => tab.active) ?? result.browser.tabs[0];
      if (active) showPanelTab(browserPanelTab(active.id));
    } catch {
      // The engine said no — the panel's own copy already explains when a
      // browser cannot be started here.
    }
  }, [sessionId, showPanelTab]);

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
        (cause) => !cancelled && setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not hydrate this session.")),
      )
      .finally(() => !cancelled && setLoading(false));
    const interval = window.setInterval(() => {
      void tail().catch(
        (cause) => !cancelled && setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not tail the session journal.")),
      );
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hydrate, tail, sessionId]);

  /**
   * NO SESSION, NO JOURNAL. Ordinarily a canvas has nothing to project anyway —
   * it polls nothing — but a canvas reached by pressing "New conversation" is
   * this same component holding the last conversation's records, and without
   * this it painted the whole of it under a fresh greeting.
   */
  const transcript = useMemo(
    () => (sessionId ? projectJournal(turns, items, events, tasks) : []),
    [sessionId, turns, items, events, tasks],
  );
  /**
   * THE SUB-AGENT ROSTER, FROM THE SAME FOLD THE TRANSCRIPT READS.
   *
   * The panel used to take the raw `tasks` snapshot, which only changes when a
   * tail response happens to carry a new one — so a fan-out could be running in
   * the conversation while the Agents panel said "Sub-agents appear here as they
   * work". Two projections of one thing, and the stale one was the surface built
   * to show it. See `taskRoster`.
   */
  const roster = useMemo(() => taskRoster(tasks, transcript.flatMap((turn) => turn.tasks)), [tasks, transcript]);
  /** Which sub-agent the panel should open on, set by pressing its chip in the
   *  transcript and cleared once the panel has scrolled to it. */
  const [focusedTask, setFocusedTask] = useState<TaskFocus>();
  /**
   * Pressing a sub-agent's chip in the conversation.
   *
   * OPENING THE PANEL IS THE GESTURE, and only when asked. A sub-agent starting
   * does NOT open it by itself, for the same reason a page the agent opened does
   * not: what you are reading is yours, and the tab's own running count is how a
   * fan-out announces itself without taking the screen.
   */
  const showAgent = useCallback(
    (taskId: string) => {
      // The count rises on every press, so asking for the same agent twice is
      // two requests rather than one — see `TaskFocus`.
      setFocusedTask((current) => ({ id: taskId, nonce: (current?.nonce ?? 0) + 1 }));
      showPanelTab("agents");
    },
    [showPanelTab],
  );
  /**
   * The turn actually EXECUTING, which is not simply the first active one now
   * that a backlog can exist: `queued` turns are also "active" by the contract's
   * reckoning, and treating one of those as live would put the working indicator
   * and the live step window on a turn that has not started.
   */
  const active =
    transcript.find((turn) => turn.state === "claimed" || turn.state === "running") ?? transcript.find((turn) => isActiveTurn(turn.state));
  const running = Boolean(transcript.find((turn) => turn.state === "claimed" || turn.state === "running"));
  /** The provider is squeezing its context right now — an open
   *  context_compaction row on the live turn. Gates the compact button (and,
   *  soon, send-now) so the client tells the same story the engine enforces. */
  const compacting = isCompacting(active);
  /** Everything typed but not yet started, oldest first — the pending strip.
   *  A `steering` turn stays in the strip as a spinner: it is mid-flight to
   *  the running turn and no longer withdrawable. */
  const queued = useMemo(
    () =>
      transcript
        .filter((turn) => turn.state === "queued" || turn.state === "steering")
        .map((turn) => ({ runId: turn.runId, text: turn.prompt, state: turn.state as "queued" | "steering" })),
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
  /**
   * The question the COMPOSER answers — the first open all-choice `user_input`
   * request. It leaves the turn's approval cards and meets the person at the
   * box instead (see composer-question-drawer.tsx). Only while the composer
   * exists: an observed session keeps the card, because there is no composer
   * to host the drawer and the question must still be visible.
   */
  const composerQuestion = useMemo(
    () => (observe ? undefined : openRequests.find((request) => questionFields(request).length > 0)),
    [openRequests, observe],
  );

  const stop = async () => {
    if (!active || !sessionId) return;
    setSending(true);
    try {
      await api.stopTurn(sessionId, active.runId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not stop the turn."));
    } finally {
      setSending(false);
    }
  };
  /** SEND NOW: the engine promotes; the strip's chip goes spinner via the
   *  next hydrate. Failures surface like any other action's. */
  const promote = async (runId: string) => {
    if (!sessionId) return;
    try {
      await api.promoteTurn(sessionId, runId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not send the message now."));
    }
  };
  /**
   * A `/compact` turn: the slash command rides the ordinary submit path, so it
   * queues, journals and reports compaction like any other turn — measured
   * live against CLI 2.1.246. Offered on Claude sessions only; Codex has no
   * out-of-turn compaction door (its app-server lives exactly one run).
   */
  const compact = async () => {
    if (!sessionId) return;
    setSending(true);
    try {
      await api.submitTurn(sessionId, { runId: newRunId(), input: "/compact" });
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not start the compaction."));
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
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not answer the approval."));
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
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not discard the ambiguous turn."));
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
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not retry the ambiguous turn."));
    } finally {
      setSending(false);
    }
  };
  const submit = async () => {
    if (!draft.trim()) return;
    const runId = draftRunId ?? newRunId();
    setDraftRunId(runId);
    setSending(true);
    // Cleared OPTIMISTICALLY and before the round trip: the box emptying is the
    // acknowledgement, and waiting on the network to give it back is the thing
    // that makes queueing feel like a form submission.
    const text = draft.trim();
    const files = attachments;
    setDraft("");
    setDraftRunId(undefined);
    setAttachments([]);
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
          envMode: draftEnvMode,
          ...(draftEnvMode === "worktree" && draftBase.baseRef ? { baseRef: draftBase.baseRef } : {}),
          ...(draftEnvMode === "worktree" && draftBase.branchName ? { branchName: draftBase.branchName } : {}),
        });
        target = created.session.id;
        // EITHER HALF ALONE COUNTS. A canvas left on the provider default with
        // an effort chosen must still write that effort — which is exactly the
        // case that used to fall through this `if` and vanish.
        // ONE PATCH FOR EVERY CREATE-TIME CHOICE. Two round trips to set two
        // fields on a session that was created a moment ago is two chances for
        // the second to fail after the first landed.
        const creationPatch = {
          ...(draftRuntimeMode === "auto" ? {} : { runtimeMode: draftRuntimeMode }),
          ...(draftModel.model || draftModel.effort || draftModel.fastMode !== undefined
            ? {
                model: {
                  instanceId: created.session.providerInstanceId,
                  ...(draftModel.model ? { model: draftModel.model } : {}),
                  ...(draftModel.effort ? { effort: draftModel.effort } : {}),
                  ...(draftModel.fastMode === undefined ? {} : { fastMode: draftModel.fastMode }),
                },
              }
            : {}),
        };
        if (Object.keys(creationPatch).length > 0) {
          const patched = await api.updateSession(target, creationPatch);
          setSession(patched.session);
        }
        // THE PANEL ARRANGEMENT SURVIVES THE SESSION BEING BORN. The surfaces
        // you had open while writing the first message are the surfaces you
        // want open while it runs; without this hand-off the key changes from
        // the canvas's to the session's and the panel resets exactly then.
        writePanelTabs(target, panel, Date.now());
        // A NEW SESSION STARTS EMPTY. Ordinarily this state is already empty —
        // the canvas polls nothing — but a canvas reached by pressing "New
        // conversation" inherits whatever the last conversation left here, and
        // it would paint for the frame between this and the first hydrate.
        setTurns([]);
        setItems([]);
        setTasks([]);
        setRequests([]);
        setEvents([]);
        setCreatedSessionId(target);
        // Only when the patch did not already give us a newer record.
        if (Object.keys(creationPatch).length === 0) setSession(created.session);
        window.history.replaceState(null, "", `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(target)}`);
      }
      /**
       * ATTACHMENTS UPLOAD AT SEND, NOT AT PICK.
       *
       * On a fresh canvas there is no session to upload to — the session is
       * created by this very message — so an eager upload would need either an
       * invented session or a second code path for the one case that matters
       * most. Uploading here costs a moment on send and works identically for a
       * first message and a hundredth.
       *
       * SEQUENTIAL, not `Promise.all`: the engine writes an index per upload,
       * and this is the client that decides how many files land at once.
       */
      const attachmentIds: string[] = [];
      for (const file of files) {
        const stored = await api.uploadAttachment(target, file);
        attachmentIds.push(stored.attachment.id);
      }
      /**
       * THE MODEL RIDES WITH THE MESSAGE.
       *
       * Sent per turn rather than relied on from the session record, so three
       * messages queued under three different models each run on the one they
       * were written under. It cannot name a provider — `TurnModelSelection` has
       * no field for it — so the session's provider stays fixed for its life.
       */
      const pending = session?.model ?? draftModel;
      await api.submitTurn(target, {
        runId,
        input: text,
        ...(pending?.model || pending?.effort || pending?.fastMode !== undefined
          ? {
              model: {
                ...(pending.model ? { model: pending.model } : {}),
                ...(pending.effort ? { effort: pending.effort } : {}),
                ...(pending.fastMode === undefined ? {} : { fastMode: pending.fastMode }),
              },
            }
          : {}),
        ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
      });
      // Only for a session that ALREADY existed. A just-created one is hydrated
      // by the effect that fires when `sessionId` changes, and calling it here
      // would run against the stale id captured in this closure.
      if (sessionId) await hydrate();
      setError(undefined);
    } catch (cause) {
      // Give the words back — and the files. Losing a typed message to a failed
      // POST is unforgivable in a way that a visible error is not, and a human
      // who has to re-pick four screenshots feels the same way about those.
      setDraft(text);
      setDraftRunId(runId);
      setAttachments(files);
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not submit the turn."));
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
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not withdraw the queued message."));
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
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not rename the session."));
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
  const setModel = async (next: ModelChoice) => {
    if (!session || !sessionId) return;
    try {
      const updated = await api.updateSession(sessionId, {
        /**
         * EITHER HALF ALONE IS A SELECTION. "The provider's default model at
         * maximum effort" used to be unrepresentable — the contract required a
         * model before it would carry an effort — so the reasoning pill on a
         * default-model session had nothing to write and said so. Sending
         * `undefined` only when BOTH are absent is what clears it.
         */
        model:
          next.model || next.effort || next.fastMode !== undefined
            ? {
                instanceId: session.providerInstanceId,
                ...(next.model ? { model: next.model } : {}),
                ...(next.effort ? { effort: next.effort } : {}),
                ...(next.fastMode === undefined ? {} : { fastMode: next.fastMode }),
              }
            : // `null`, not `undefined`: JSON.stringify drops an undefined key, so
              // the engine would see no patch and keep the old selection — the
              // pill would say "Provider default" and the record would disagree.
              null,
      });
      setSession(updated.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not change the model."));
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
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not change the runtime mode."));
    }
  };

  // Queued and mid-flight turns live in the composer's strip; a STEERED turn
  // is terminal but renders nowhere as a turn — its words are a user_message
  // row inside the run they joined, and a second copy here would double them.
  const shown = transcript.filter((turn) => turn.state !== "queued" && turn.state !== "steering" && turn.state !== "steered");
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
          readOnly={observe}
          onRename={(next) => void rename(next)}
          panel={
            <>
              <WorkspaceInspector
                projectId={session?.projectId ?? projectId}
                {...(projectName ? { projectName } : {})}
                {...(session ? { session } : {})}
                tasks={roster}
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
                requests={openRequests.filter((request) => request.runId === turn.runId && request.id !== composerQuestion?.id)}
                sending={sending}
                onOpenAgent={showAgent}
                onOpenTab={showPanelTab}
                onDecide={(requestId, decision, extra) => void decideRequest(requestId, decision, extra)}
                onRetry={(item) => void retryAmbiguous(item)}
                onDiscard={(item) => void discardAmbiguous(item)}
              />
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </ConversationViewport>
        {observe ? (
          <div className="mx-auto mb-4 flex w-full max-w-[50rem] items-center gap-2 rounded-xl border border-border/60 bg-muted/25 px-4 py-2.5 text-xs text-muted-foreground">
            <EyeIcon className="size-3.5 shrink-0" />
            Observing — this thread is driven by its loom. Talk to the conductor to steer it.
          </div>
        ) : (
        <Composer
          draft={draft}
          // A fresh canvas is READY: there is nothing to wait for, because the
          // message you type is the thing that creates the session.
          ready={fresh || Boolean(session)}
          attachments={attachments}
          onAttach={setAttachments}
          fresh={fresh}
          {...(fresh
            ? {
                driver: draftDriver,
                onDriverChange: chooseDriver,
                pendingModel: draftModel,
                envMode: draftEnvMode,
                onEnvMode: setDraftEnvMode,
                pendingBase: draftBase,
                // Picking a base IS choosing a worktree: a base for the
                // shared checkout would mean switching its branch, which the
                // engine's read-only git surface refuses by construction.
                onBase: (next: { baseRef?: string; branchName?: string }) => {
                  setDraftBase(next);
                  if (next.baseRef || next.branchName) setDraftEnvMode("worktree");
                },
              }
            : {})}
          busy={Boolean(active)}
          sending={sending}
          queued={queued}
          {...(session?.runtimeMode ?? (fresh ? draftRuntimeMode : undefined)
            ? { runtimeMode: session?.runtimeMode ?? draftRuntimeMode }
            : {})}
          projectId={session?.projectId ?? projectId}
          {...(projectName ? { projectName } : {})}
          {...(greeting === undefined ? {} : { greeting })}
          {...(session ? { session } : {})}
          {...(newestUsage ? { usage: newestUsage } : {})}
          backgroundTasks={backgroundTasks}
          {...(session?.driver === "claude" ? { onCompact: () => void compact() } : {})}
          compacting={compacting}
          {...(composerQuestion
            ? {
                question: composerQuestion,
                onAnswerQuestion: (requestId: string, answers: Record<string, string>) => void decideRequest(requestId, "accept", { answers }),
                onCancelQuestion: (requestId: string) => void decideRequest(requestId, "cancel"),
              }
            : {})}
          onDraftChange={(nextDraft) => {
            setDraft(nextDraft);
            setDraftRunId(undefined);
          }}
          onSubmit={() => void submit()}
          onStop={() => void stop()}
          onWithdraw={(runId) => void withdraw(runId)}
          {...(running ? { onSendNow: (runId: string) => void promote(runId) } : {})}
          sendNowDisabled={compacting || openRequests.length > 0}
          sendNowReason={
            compacting
              ? "The provider is compacting its context and cannot take a message right now."
              : openRequests.length > 0
                ? "Answer the waiting request first."
                : undefined
          }
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
          // Before a session exists there is nothing to patch, so both choices
          // are held locally and applied by the one patch that follows creation.
          onRuntimeMode={fresh ? setDraftRuntimeMode : (mode) => void setRuntimeMode(mode)}
          onModelChange={fresh ? setDraftModel : (next) => void setModel(next)}
          onOpenChanges={() => showPanelTab("diff")}
        />
        )}
      </div>
      {panel.open && (
        <RightPanel
          {...(active?.state ? { active: active.state } : {})}
          {...(sessionId ? { sessionId } : {})}
          {...(session?.title ? { sessionTitle: session.title } : {})}
          projectId={session?.projectId ?? projectId}
          {...(session?.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {})}
          items={items}
          tasks={roster}
          {...(focusedTask ? { focusedTask } : {})}
          {...(browserCanStart ? { onOpenBrowser: openBrowser } : {})}
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
