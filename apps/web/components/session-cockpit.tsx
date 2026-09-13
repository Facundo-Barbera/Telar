"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, EyeIcon, FolderGit2Icon, Minimize2Icon, TerminalIcon, TriangleAlertIcon, WorkflowIcon } from "lucide-react";
import {
  isBackgroundWork,
  type EngineEvent,
  type EngineRequest,
  type RequestDecision,
  type Item,
  pluginEnabled,
  readProjectPlugins,
  type Project,
  type ProviderDriverKind,
  type RuntimeMode,
  type Session,
  type SessionSnapshot,
  type SnapshotPage,
  type Task,
  type Turn,
  type TurnAttachment,
  type TurnState,
} from "@telar/engine-client";
import { createEngineApi, newRunId, retryAmbiguousTurn, EngineApiError } from "@/lib/engine/client";
import { isActiveTurn, isCompacting, itemText, projectJournal, taskRoster, type JournalTask, type JournalTurn } from "@/lib/engine/journal";
import { projectSettingsHref } from "@/lib/project-settings-link";
import { actionableRequests } from "@/lib/failed-turn-recovery";
import { canvasHref, sessionHref } from "@/lib/session-list";
import { sessionLink } from "@/lib/session-link";
import { desktopApp } from "@/lib/desktop-app";
import { hostFromPathname, hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { isSettled } from "@/lib/session-settling";
import { newestResultTurn, type ReceiptAnswer, type ReceiptIdentity } from "@/lib/session-read-receipt";
import { ReadReceiptMarker, useReadReceipt } from "./session/read-receipt";
import { useInboxPolicy } from "@/lib/inbox-policy";
import { useSessionDefaults } from "@/lib/session-defaults";
import { questionFields } from "@/lib/question-drawer";
import { cn } from "@/lib/utils";
import { isCompactDraft } from "@/lib/composer-completions";
import { readDraft, writeDraft } from "@/lib/composer-draft";
import { insertReference } from "@/lib/drag-reference";
import { sessionModelSelection, type ModelChoice } from "@/lib/models";
import { sessionConnection } from "@/lib/engine/session-connection";
import { INITIAL_TURNS, loadOlderTurns, mergeRows } from "@/lib/engine/session-sync";
import { LOCAL_HOST, saveSnapshot, snapshotKey, snapshotStore } from "@/lib/snapshot-cache";
import { decideStale } from "@/lib/stale-state";
import { Composer } from "./composer";
// `sessionWakeLabel` lives in ./transcript because BOTH surfaces name a wake
// and the import only runs one way (cockpit → transcript). A wake that landed
// mid-turn is a transcript row; the same wake landing on an idle session is a
// turn header here. One vocabulary, or the two spellings drift apart.
import { ActivityGroup, LiveActivity, Marker, sessionWakeLabel, splitAtMessageBoundaries, TranscriptItem, TranscriptWorkspace, turnActivity, TurnFailureRow, WorkingIndicator } from "./transcript";
import { browserPanelTab, browserTabId, describeBrowserStart, editorInstanceKey, filePanelTabPath, isPanelTab, issuePanelTab, latestBrowserState, LIVE_BROWSER_TAB, migratePanelTab, panelTabForPath, pullPanelTab, RailToggle, RightPanel, type BrowserStartState, type PanelTab, type TaskFocus } from "./right-panel";
import { desktopBrowserBridge } from "./browser-live";
import { openLinksInSessionBrowser } from "@/lib/link-policy";
import { openUrlInSessionBrowser, parseForgeLink, sameRepository } from "@/lib/session-links";
import { WorkspaceInspector } from "./session/workspace-inspector";
import { RunHeaderControl } from "./run/run-header-control";
import { OpenWorkspaceButton } from "./session/open-workspace-button";
import { PromptText } from "./session/prompt-text";
import { agentSenderLabel, AgentMessageBubble, ConversationMessage } from "./session/conversation-message";
import {
  activePanelTab,
  addPanelTab,
  canvasPanelKey,
  closePanelTab,
  collapseBrowserTabs,
  emptyPanelTabs,
  movePanelTab,
  nextPanelTabId,
  openNewPanelTab,
  openPanelTab,
  readPanelTabIds,
  readPanelTabs,
  setPanelTabParams,
  writePanelTabs,
  clearPanelTabs,
  type PanelTabParams,
  type PanelTabState,
} from "@/lib/right-panel-tabs";
import {
  editorFileForPath,
  editorFromLegacyTabs,
  emptyEditor,
  openInEditor,
  readEditor,
  writeEditor,
  clearEditor,
  type EditorState,
  type OpenIntent,
} from "@/lib/editor-workspace";
import {
  buildSessionActionMenuItems,
  type SessionActionHandlers,
  type SessionActionMenuState,
} from "@/lib/session-action-menu";
import { dropdownSessionMenuParts, SessionActionContextMenu, SessionActionMenuItems } from "./session/session-action-menu";
import { ApprovalCard } from "./approval-card";
import { MainSidebarTrigger, useMainIsLeftmost } from "./main-sidebar-trigger";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ConversationContent, ConversationScrollButton, ConversationViewport, type ConversationFollowHandle } from "@/components/ui/conversation";
import { Message, MessageContent, MessageMenu, MessageResponse } from "@/components/ui/message";
import { CodeSurface } from "@/components/ui/code-surface";
import { useSidebar } from "@/components/ui/sidebar";
import { useCommandHandlers } from "@/lib/use-command-keys";

/**
 * How long a mouse-opened title menu waits for a `dblclick` to cancel it.
 *
 * t3 waits 500 ms for its native menu; this is a web popup with nothing to
 * marshal, and 500 ms of nothing after a click reads as a broken control. 250 ms
 * is inside the platform double-click interval on both macOS and Windows
 * defaults, so a real double-click still lands first.
 */
const TITLE_MENU_CLICK_DELAY_MS = 250;

const api = createEngineApi();
/** Below this the session rail, the conversation and the panel cannot all
 *  hold their minimum widths at once. Chosen as rail (16rem) + conversation
 *  floor (24rem) + panel floor (20rem), rounded up. */
const NARROW_WINDOW = 1280;
/** The masthead's "Spin into loom" entrance — off until the flow is ready to
 *  live in every session's header. See the render site for why off means
 *  absent rather than greyed. */
const SPIN_ENTRANCE_ENABLED = false;
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

/**
 * WHICH PLUGIN SURFACES THIS PROJECT OFFERS — the Data tab, the LaTeX tab, and
 * whether an `.ipynb` opens as a notebook rather than as text.
 *
 * READ FROM THE MAP, NEVER FROM THE LEGACY MIRROR (#269). `Project.dataScience`
 * and `Project.latex` are written beside the map for one reader only — an older
 * engine binary, so a rollback keeps your settings — and a project that
 * disabled Data Science through the map keeps a mirror still saying `true`.
 * Reading that mirror is the resurrection bug `readProjectPlugins` exists to
 * prevent: the cockpit offered the Data tab and routed notebooks to a surface
 * whose plugin route was disabled. `readProjectPlugins` migrates an unmigrated
 * project from the mirror, so this is also correct for a project that predates
 * the map — see `PROJECT_PLUGINS_VERSION`.
 */
export function cockpitPlugins(project: Pick<Project, "plugins" | "latex" | "dataScience"> | undefined): {
  dataScience: boolean;
  latex: boolean;
} {
  if (!project) return { dataScience: false, latex: false };
  const { plugins } = readProjectPlugins(project);
  return { dataScience: pluginEnabled(plugins, "data-science"), latex: pluginEnabled(plugins, "latex") };
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
 * Mount presence for the right panel's open/close animation. On open it mounts
 * immediately and flips `shown` next frame so the width transitions IN; on
 * close it drops `shown` (width transitions OUT) and unmounts after the same
 * ~200ms, so the shell can animate out before it leaves the DOM. Reopening
 * before the timer fires cancels the unmount and re-shows. Reduced motion still
 * lands in the correct state — only the transition itself is dropped (CSS).
 */
function usePanelPresence(open: boolean, durationMs = 200): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    // All state updates are deferred into a frame/timeout, never synchronous in
    // the effect body (which would cascade renders — the lint rule this obeys).
    if (open) {
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        setMounted(true);
        // A second frame so the width starts at 0 and transitions to full.
        inner = requestAnimationFrame(() => setShown(true));
      });
      // BOTH frames are cancelled: the inner one, left running, would flip
      // `shown` true again and reopen a panel that is closing.
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    const frame = requestAnimationFrame(() => setShown(false));
    const timer = window.setTimeout(() => setMounted(false), durationMs);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open, durationMs]);
  return { mounted, shown };
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
  hostId,
  projectName,
  session,
  onRename,
  panel,
  readOnly = false,
  onWatchRun,
  menu,
}: {
  projectId: string;
  /** Which Mac the project is on — the breadcrumb's link must stay there. */
  hostId: string;
  /** Resolved from the project record. Absent until it loads — the breadcrumb
   *  falls back to the id rather than showing a gap, but an opaque
   *  `project_1a1649…` is addressing, not a name a person navigates by. */
  projectName?: string;
  session?: Session;
  /** `sending` is gone from here: it gated the rename pencil, and renaming a
   *  session is a PATCH on its title that has nothing to do with whether a turn
   *  is being submitted. The verb lives in the menu now, gated on what actually
   *  refuses it. */
  onRename: (title: string) => void;
  /** The session panel's triggers. Passed in rather than constructed here so the
   *  masthead stays identity-only and does not acquire the session record's
   *  items, tasks, turns and events just to hand them straight through. */
  panel: React.ReactNode;
  /** Observe mode: the title is a fact, not a field, and there is no spin —
   *  a loom-owned session cannot be spun into another loom. */
  readOnly?: boolean;
  /** Opens the right panel's Run tab. Monitoring lives there; the masthead's
   *  Run control only configures, starts and stops. */
  onWatchRun?: () => void;
  /**
   * EVERYTHING THE TITLE MENU NEEDS EXCEPT THE RENAME, which is this
   * component's own inline editor and cannot be handed in from outside. The
   * rest is passed rather than assembled here for the same reason `panel` is:
   * the masthead stays identity-only instead of acquiring an engine client, a
   * router and a settling policy to build a list with.
   *
   * Absent on a fresh canvas. There is no session to act on, so there is no
   * menu, no chevron and no right-click.
   */
  menu?: Omit<SessionActionMenuState, "actions"> & { actions: Omit<SessionActionHandlers, "rename"> };
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

  const beginRename = () => {
    setDraftTitle(title);
    setEditing(true);
  };

  /**
   * THE TITLE IS THE MENU, which is what buys it: a header that spends no
   * permanent space on a `⋯` and still reaches every verb. Same list the rail
   * row draws — see `lib/session-action-menu.ts`, which exists so these two
   * cannot disagree.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuItems = menu ? buildSessionActionMenuItems({ ...menu, actions: { ...menu.actions, rename: beginRename } }) : undefined;

  /**
   * CLICK OPENS THE MENU, DOUBLE-CLICK RENAMES, AND THE RACE IS HANDLED RATHER
   * THAN AVOIDED.
   *
   * A `dblclick` always arrives after a `click`, so an immediate menu would pop
   * open under every rename the moment someone reached for the second press.
   * The mouse-opened menu therefore waits out the double-click window; a second
   * press inside it cancels the timer and edits instead.
   *
   * THE DELAY IS FOR THE MOUSE ONLY. A keyboard activation has no second press
   * to wait for — `detail === 0` is how the DOM says a click came from Enter or
   * Space rather than a pointer — and the chevron is an explicit "open the
   * menu", so both skip the wait. Nobody who asked unambiguously is made to
   * wait a quarter second to be believed.
   */
  const pendingOpen = useRef(0);
  const cancelPendingOpen = () => window.clearTimeout(pendingOpen.current);
  useEffect(() => cancelPendingOpen, []);

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
        // `app-ground`: the masthead is the top of the canvas, and it used to
        // go see-through only because the wash rules happened to match the
        // string `bg-background/65`. The opt-in is a class now, not a class
        // name — see the translucency note in globals.css.
        // The same shortened band as the rail's (see TelarSidebarHeader): both
        // islands start --app-island-inset down, and the lights do not move.
        "app-ground app-drag flex min-h-[var(--titlebar-height)] shrink-0 items-center gap-2 bg-background/65 py-1.5 pr-4 backdrop-blur md:h-[var(--titlebar-band-height)] md:min-h-[var(--titlebar-band-height)] md:py-0",
        // The content island sits --app-island-inset in from the window edge
        // (app-shell.tsx), so the traffic-light inset is measured from the
        // island.
        mainIsLeftmost ? "pl-[max(16px,calc(var(--titlebar-inset)+var(--app-island-inset)))]" : "pl-4",
      )}
    >
      {/* RIGHT-CLICK ANYWHERE IN THE BREADCRUMB, not only on the title: the
          whole crumb is "this session", and a context menu that works on half
          of a phrase is a context menu people stop trying. */}
      <SessionActionContextMenu items={menuItems}>
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
            href={canvasHref(projectId, hostId)}
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
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <span className="group/title inline-flex min-w-0 items-center gap-1 font-semibold">
                {menuItems ? (
                  <button
                    type="button"
                    className="app-no-drag min-w-0 truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={title}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={(event) => {
                      cancelPendingOpen();
                      // A CLICK WHILE IT IS OPEN IS A DISMISSAL. The popup's own
                      // outside-press has already closed it by now; scheduling
                      // another open here would reopen it a quarter second later,
                      // which reads as a flicker rather than as a toggle.
                      if (menuOpen) return;
                      // `detail === 0`: Enter or Space, where no second press is
                      // coming and waiting for one would just feel broken.
                      if (event.detail === 0) {
                        setMenuOpen(true);
                        return;
                      }
                      pendingOpen.current = window.setTimeout(() => setMenuOpen(true), TITLE_MENU_CLICK_DELAY_MS);
                    }}
                    onDoubleClick={() => {
                      cancelPendingOpen();
                      if (!readOnly) beginRename();
                    }}
                  >
                    {title}
                  </button>
                ) : (
                  // A fresh canvas: "New conversation" is a statement about what
                  // you are looking at, and there is nothing yet to act on.
                  <span className="truncate" title={title}>
                    {title}
                  </span>
                )}
                {/* THE CHEVRON IS THE ADVERTISEMENT, not the control — it fades in
                    on hover to say the title is pressable, and costs no permanent
                    header space the way a `⋯` would. It is still a real button,
                    so the keyboard reaches the menu without knowing the title is
                    one, and it opens at once because pressing it is unambiguous. */}
                {menuItems && (
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Session actions"
                        className="app-no-drag shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                        onClick={cancelPendingOpen}
                      />
                    }
                  >
                    <ChevronDownIcon />
                  </DropdownMenuTrigger>
                )}
              </span>
              {menuItems && (
                <DropdownMenuContent align="start" className="min-w-56">
                  <SessionActionMenuItems items={menuItems} parts={dropdownSessionMenuParts} />
                </DropdownMenuContent>
              )}
            </DropdownMenu>
          )}
        </div>
      </SessionActionContextMenu>
      {/* The whole trailing cluster is controls, so it opts out as a block
          rather than one button at a time. `shrink-0`: these are fixed-size
          glyphs, and the title beside them is what absorbs a narrow window. */}
      <div className="app-no-drag ml-auto flex shrink-0 items-center gap-2">
        {/* SETTING A RUN UP IS A THING YOU DO ONCE, ABOUT THE WHOLE
            CONVERSATION — so it sits here with the other facts about this
            session, not behind a panel you must open first. Watching it run
            stays in the right panel; "Watch output" is the door between them.
            Only for a session that exists: there is nothing to run on a canvas
            with no workspace yet. */}
        {/* KEYED BY HOST AND SESSION: a different machine is a different
            mount, so no answer, latch or poll from the previous one can reach
            this one. Two hosts can hold the same session id. */}
        {session && !readOnly && (
          <RunHeaderControl
            key={`${hostId}:${session.id}`}
            sessionId={session.id}
            hostId={hostId}
            {...(onWatchRun ? { onWatchOutput: onWatchRun } : {})}
          />
        )}
        {/* The folder itself, in the machine's own tools. Renders only on the
            desktop shell, and states its own limits (remote sessions). */}
        {/* No `hostLabel`: this masthead knows the host's ID, not its name, and
            "another machine" is true where a guessed name would not be. */}
        {session && <OpenWorkspaceButton path={session.workspace.path} hostId={hostId} />}
        {/* SPIN INTO LOOM (docs/loom-model-v1.md): when this conversation has
            produced enough shape, hand it to the weaver. The session becomes
            the loom's origin and detaches — it leaves this surface and lives
            in the loom's room from then on.

            PARKED, NOT SHIPPED. The flow behind this glyph needs more work
            before it earns a place in every session's header, and a disabled
            button would be chrome apologising for itself — so nothing renders
            until the flag flips. The Looms place stays reachable through the
            place switcher; only this entrance is closed. */}
        {SPIN_ENTRANCE_ENABLED && session && !readOnly && (
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

/**
 * NO RECOVERY CARD, AND NO HELD-MESSAGE CARD.
 *
 * Both used to live here. A turn the app lost became `ambiguous` and asked the
 * person to choose between Continue, Re-run and Discard; a message written
 * before that turn was lost sat behind its own Send-it / Drop-it card, because
 * it had been written against a state of the world the interrupted turn took
 * with it.
 *
 * They are gone because the question is gone. A restart is a stop: the turn is
 * terminal, what was waiting behind it is terminal, and the honest half of the
 * old card — "we cannot tell how far this got" — is a sentence on the stopped
 * turn rather than a gate in front of the conversation. Saying something is
 * how you carry on, and it continues the same provider thread.
 */

/**
 * AN ORDINARY FAILURE, NOT AN AMBIGUOUS ONE. The provider process died or the
 * driver threw; the engine knows the turn ended and kept everything that
 * streamed. Nothing is resubmitted from here: the button only PREPARES a
 * continuation in the composer, and the person sends it — or edits it first.
 */

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
/**
 * THE WAKE-UP, AS A ROW. The task that fired lives on the turn that STARTED
 * it, not on this one, so it is looked up in the session roster — the same
 * list the Agents panel reads — and the row names it by title. Expanding
 * shows the provider's own notification text (the turn's `prompt`), which is
 * what the model was actually woken with.
 */
/**
 * A WAKE-UP SAYS WHAT HAPPENED, not that the model woke. "Woke up · Explore"
 * told the reader nothing they could act on; "Explore agent finished" does —
 * it is the event the model is about to react to, phrased like the tool rows
 * around it (verb first, then the title in mono). The verb comes from the
 * task's kind and state: an agent finishes or fails, a background command
 * exits, a still-running one (a monitor's tick) reported.
 */
function wakeUpLabel(task: JournalTask | undefined): { verb: string; Icon: typeof ClockIcon } {
  if (!task) return { verb: "Woke up on a background task", Icon: ClockIcon };
  const subject = task.kind === "agent" ? (task.role ? `${task.role} agent` : "Sub-agent") : "Background command";
  const Icon = task.kind === "agent" ? BotIcon : TerminalIcon;
  switch (task.state) {
    case "completed":
      return { verb: `${subject} ${task.kind === "agent" ? "finished" : "exited"}`, Icon };
    case "failed":
      return { verb: `${subject} failed`, Icon };
    case "stopped":
      return { verb: `${subject} was stopped`, Icon };
    default:
      return { verb: `${subject} reported`, Icon };
  }
}

// A peer agent's message and the person's own now live in one place, beside
// each other, so neither can drift from how the other is drawn. Re-exported
// because this module was their home and callers still import them from here.
export { agentSenderLabel, AgentMessageBubble };

function WakeUpRow({ turn, roster, onOpen }: { turn: JournalTurn; roster: readonly JournalTask[]; onOpen?: (taskId: string) => void }) {
  const [open, setOpen] = useState(false);
  const task = turn.wokenBy ? roster.find((candidate) => candidate.id === turn.wokenBy) : undefined;
  const { verb, Icon } = turn.wakeReason ? sessionWakeLabel(turn.wakeReason) : wakeUpLabel(task);
  const label = turn.wakeReason
    ? `session …${turn.wakeReason.sessionId.slice(-6)}`
    : (task?.title ?? (task ? undefined : turn.wokenBy ? `task ${turn.wokenBy.slice(-6)}` : undefined));
  const body = turn.prompt.trim();
  return (
    <div className="rounded-md">
      <div className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          disabled={!body}
          aria-expanded={body ? open : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0">{verb}</span>
          {label && <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">{label}</span>}
          {body && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
        </button>
        {onOpen && task && (
          <button
            type="button"
            onClick={() => onOpen(task.id)}
            title={task.kind === "background" ? "Open in the Processes panel" : "Open in the Agents panel"}
            className="shrink-0 rounded px-1 text-[0.625rem] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Open ▸
          </button>
        )}
      </div>
      {open && body && (
        <div className="ml-3 border-l border-border/70 py-1 pr-1.5 pl-3">
          <CodeSurface text={body} wrap />
        </div>
      )}
    </div>
  );
}

/** Passive deliveries have no model response. Actual work and its completion
 * stay visible, regardless of who initiated it. */
export function SessionTurn(props: Parameters<typeof SessionTurnBody>[0]) {
  const [open, setOpen] = useState(false);
  const { turn } = props;
  const hasHumanMessage = turn.items.some((item) => item.detail.type === "user_message" && !item.detail.sender && !item.detail.wakeReason);
  if (turn.origin !== "session" || turn.agentDelivery !== "passive" || hasHumanMessage || props.requests.length > 0) return <SessionTurnBody {...props} />;
  const source = turn.sender?.sessionId ?? turn.wakeReason?.sessionId;
  return (
    <div className="mx-auto w-full min-w-0 max-w-[50rem]" aria-label="Session coordination">
      <button type="button" className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">Session activity</span>
        {source && <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">{`session …${source.slice(-6)}`}</span>}
        <span className="text-muted-foreground">{turn.agentDelivery === "passive" ? "report received" : props.live ? "working" : describeTurnState(turn.state).label.toLowerCase()}</span>
        <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="pt-2"><SessionTurnBody {...props} /></div>}
    </div>
  );
}

function SessionTurnBody({
  turn,
  requests,
  sending,
  live,
  now,
  quiet = false,
  onDecide,
  onRetry,
  onOpenAgent,
  onOpenTab,
  onResumeNow,
  onInsert,
  onOpenFile,
  onOpenFileInNewTab,
  roster = [],
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
  /**
   * THE TWO GESTURES A TRANSCRIPT ROW CAN OFFER AND NOT PERFORM — both the
   * cockpit's, both threaded exactly as `onOpenAgent` and `onOpenTab` above
   * already are. `onInsert` puts a quote or a file reference into the draft
   * this component does not own; `onOpenFile` routes a path through
   * `showPanelTab`, which is the ONE door into the Editor.
   */
  onInsert?: (text: string) => void;
  onOpenFile?: (path: string) => void;
  /** …and into an Editor of its OWN, so a file the agent touched can be read
   *  beside whatever the Editor already holds (#322). */
  onOpenFileInNewTab?: (path: string) => void;
  turn: JournalTurn;
  /** The session's whole task roster, for a wake-up row: the task that woke
   *  a provider turn belongs to the turn that started it, not to this one. */
  roster?: readonly JournalTask[];
  sending: boolean;
  /** This turn is the one currently executing. Drives the live step window. */
  live: boolean;
  now: number;
  onRetry: (turn: Pick<Turn, "runId" | "state" | "input">) => void;
  /** Abandon an ambiguous run's execution and keep talking — the recovery
   *  card's primary verb. Distinct from `onContinue`, which prepares a draft on
   *  an ordinary FAILED turn and submits nothing. */
  /** A held message the person re-read and still means — it runs in its
   *  original place in the queue. */
  /** ...or no longer wants. An ordinary stop; it is still a queued turn. */
  /** How many messages are queued behind an undecided ambiguous turn. The
   *  engine holds them; the card says so rather than letting the session look
   *  stuck. */
  /** Offered on the ONE failed turn the session can continue from (see
   *  `recoverableFailedTurn`). Absent everywhere else — the cockpit decides,
   *  the turn only renders. */
  onContinue?: () => void;
  /** Don't wait for the usage limit to lift. Offered only on a `rate_limited`
   *  failure; the cockpit decides, the turn only renders. */
  onResumeNow?: () => void;
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
  /** The gestures a transcript row can OFFER and not perform, spread onto
   *  every row this turn renders so no branch of the layout quietly drops
   *  one — a menu that exists on a settled turn and not on a live one would
   *  be the bug this single object prevents. */
  const rowGestures = {
    ...(onOpenAgent ? { onOpenAgent } : {}),
    ...(onInsert ? { onInsert } : {}),
    ...(onOpenFile ? { onOpenFile } : {}),
    ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}),
  };
  /**
   * THE TURN'S RESPONSES. A message sent into a running turn is a boundary in
   * the conversation, so the work after it belongs to it and is drawn under
   * it — outside the assistant's lane, where the person's own words belong.
   * `responses.length === 1` is every turn nobody steered, and it renders
   * exactly as it did before. See `splitAtMessageBoundaries`.
   */
  const responses = splitAtMessageBoundaries(turn.items);
  const answering = responses.at(-1)!;
  const earlier = responses.slice(0, -1);
  // The closing-prose split applies to the LAST response only: that is the one
  // whose final assistant message is the answer to the turn.
  const lastProse = answering.items.map((item) => item.detail.type).lastIndexOf("assistant_message");
  const activity = lastProse === -1 ? answering.items : answering.items.slice(0, lastProse);
  const closing = lastProse === -1 ? [] : answering.items.slice(lastProse);
  const streamedAnswer = closing.some((item) => itemText(item));
  /** The quiet fold's own toggle. Per turn, never persisted — looking at how
   *  one answer was made is a glance, not a mode. */
  const [workShown, setWorkShown] = useState(false);
  const folded = quiet && !live;

  /**
   * THE COMPACTION GESTURE IS NOT A MESSAGE. A press of the Compact button
   * used to render as the human typing "/compact" in a bubble, and the CLI's
   * reply to it (a status pair) drew a second, empty assistant message. One
   * quiet system line says what happened; its `context_compaction` row
   * carries the numbers.
   */
  if (turn.kind === "compact") {
    return (
      <div className="flex flex-col gap-2">
        {turn.items.filter((item) => item.detail.type === "context_compaction").map((item) => (
          <TranscriptItem key={item.id} item={item} {...rowGestures} />
        ))}
        {turn.items.every((item) => item.detail.type !== "context_compaction") && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Minimize2Icon className="size-3.5 shrink-0" />
            <span>
              {isActiveTurn(turn.state)
                  ? "Compacting context…"
                  : turn.state === "failed"
                    ? "Compaction failed"
                    : "Context compaction requested"}
            </span>
          </p>
        )}
        {turn.state === "failed" && turn.failure && <p className="text-xs text-destructive">{turn.failure}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* THE ORDINARY MESSAGE, from the one component that defines what that
          looks like — the same one a message steered into a running turn now
          uses, so the two cannot drift apart. See `conversation-message.tsx`. */}
      {turn.origin !== "provider" && turn.origin !== "session" && (
        // `markdown={false}`: this is the draft the person typed, chips and
        // all — "Copy as Markdown" would offer the same string again under a
        // name that claims something about it which is not true.
        <div className="mb-6">
          <MessageMenu text={turn.prompt} markdown={false} {...(onInsert ? { onQuote: onInsert } : {})}>
            <ConversationMessage text={turn.prompt} {...(turn.attachments ? { attachments: turn.attachments } : {})} {...(onOpenTab ? { onOpenTab } : {})} />
          </MessageMenu>
        </div>
      )}

      {/* The initiating machine message precedes every response and steer. */}
      {(turn.origin === "provider" || turn.origin === "session") && (
        <Message from="assistant"><MessageContent from="assistant">
          {/* A TURN THE PROVIDER STARTED — a background task's ending woke the
              model. No human typed anything, so no bubble: the wake-up is a
              row IN THE ASSISTANT'S LANE, shaped like a tool call, and the
              turn's work follows it exactly as after any other row. */}
          {turn.origin === "session" && turn.sender ? (
            <AgentMessageBubble text={turn.prompt} sender={turn.sender} {...(turn.agentNotice ? { notice: turn.agentNotice } : {})} {...(turn.agentIntent ? { intent: turn.agentIntent } : {})} {...(turn.assignmentScope ? { scope: turn.assignmentScope } : {})} {...(turn.attachments ? { attachments: turn.attachments } : {})} {...(onOpenTab ? { onOpenTab } : {})} />
          ) : (turn.origin === "provider" || turn.origin === "session") && (
            <WakeUpRow turn={turn} roster={roster} {...(onOpenAgent ? { onOpen: onOpenAgent } : {})} />
          )}
        </MessageContent></Message>
      )}

      {/* A BOUNDARY INTRODUCES THE WORK UNDER IT — message first, then what the
          agent did about it. Drawn at the top level, not inside the assistant's
          lane, so a reply is never painted over the message it answers. */}
      {earlier.map((response) => (
        <Fragment key={response.boundary?.id ?? "opening"}>
          {response.boundary && (
            <div className={cn("mx-auto w-full min-w-0 max-w-[50rem]", response.boundary.detail.type === "user_message" && !response.boundary.detail.sender && !response.boundary.detail.wakeReason && "my-6")}>
              <TranscriptItem item={response.boundary} tasks={turn.tasks} {...rowGestures} {...(onOpenTab ? { onOpenTab } : {})} />
            </div>
          )}
          {response.items.length > 0 && (
            <Message from="assistant">
              <MessageContent from="assistant">
                {/* CUT AT ITS SEAMS, like every other response. Folding these
                    items into one group hid the assistant's prose — including
                    prose still streaming when the steer landed — inside a
                    collapsed step. See `LiveActivity`. */}
                <LiveActivity items={response.items} tasks={turn.tasks} liveTail={false} {...rowGestures} />
              </MessageContent>
            </Message>
          )}
        </Fragment>
      ))}
      {answering.boundary && (
        <div className={cn("mx-auto w-full min-w-0 max-w-[50rem]", answering.boundary.detail.type === "user_message" && !answering.boundary.detail.sender && !answering.boundary.detail.wakeReason && "my-6")}>
          <TranscriptItem item={answering.boundary} tasks={turn.tasks} {...rowGestures} {...(onOpenTab ? { onOpenTab } : {})} />
        </div>
      )}

      <Message from="assistant">
        <MessageContent from="assistant">
          {requests.map((request) => (
            <ApprovalCard key={request.id} request={request} sending={sending} onDecide={onDecide} />
          ))}
          {/* LIVE, THE WHOLE TIMELINE IS CUT AT ITS SEAMS — each run of work
              folds to its tally as the agent moves past it (see `LiveActivity`).
              The prose/closing split below is for a turn that has FINISHED:
              only then is "the last message" known to be the answer. */}
          {live ? (
            // The ANSWERING response's items only — the boundaries and the work
            // before them were drawn above, so live and settled cut the turn in
            // the same place and a reload cannot move a message.
            <LiveActivity items={answering.items} tasks={turn.tasks} {...rowGestures} />
          ) : (
            <>
              {!folded && (
                <ActivityGroup items={activity} tasks={turn.tasks} live={false} {...rowGestures} />
              )}
              {closing.map((item) => (
                <TranscriptItem key={item.id} item={item} tasks={turn.tasks} {...rowGestures} />
              ))}
            </>
          )}
          {!streamedAnswer && turn.resultText && <MessageResponse>{turn.resultText}</MessageResponse>}
          {turn.failure && (
            <TurnFailureRow
              failure={turn.failure}
              {...(turn.failureCode ? { code: turn.failureCode } : {})}
              {...(turn.resumeAt === undefined ? {} : { resumeAt: turn.resumeAt })}
              {...(turn.limitType ? { limitType: turn.limitType } : {})}
              {...(onResumeNow ? { onResume: onResumeNow, resuming: sending } : {})}
            />
          )}
          {/* THE SESSION SAT ONE OUT AND CAME BACK. The turn is `queued` again
              by now, so its failure no longer renders — without this line the
              wait would read as an unexplained gap in the conversation. */}
          {turn.resumedAfterRateLimit !== undefined && <Marker>resumed after the usage limit reset</Marker>}
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
            <p className="font-mono text-[0.625rem] text-muted-foreground/70 tabular-nums">
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
                className="mt-1 inline-flex items-center gap-1 rounded-md text-[0.6875rem] text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                {workShown ? "hide the work" : "how it did this"}
              </button>
              {workShown && (
                <div className="mt-2 space-y-2">
                  <ActivityGroup items={activity} tasks={turn.tasks} live={live} {...rowGestures} />
                  {turn.usage && (
                    <p className="font-mono text-[0.625rem] text-muted-foreground/70 tabular-nums">
                      {(turn.usage.tokens.input + turn.usage.tokens.output).toLocaleString()} tokens
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {/* NO RECOVERY CHOICE AND NO HELD MESSAGE. A turn the app lost is
              stopped, not ambiguous, and nothing waits behind it — so there is
              no card here asking which of three things to do, and no message
              wearing a Release button. Saying something is how you carry on. */}
          {turn.state === "failed" && <p className="mt-2 text-sm text-muted-foreground">This turn ended early. Your history is saved; send a new message to continue.</p>}
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
  observe = false,
}: {
  projectId: string;
  sessionId?: string;
  /** Resolved by the page, so the breadcrumb and the greeting never paint the
   *  raw id first and correct themselves a moment later. */
  projectName?: string;
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
  const pathname = usePathname();
  // WHICH MAC THIS SCREEN IS ABOUT — the address bar says (lib/hosts/client.ts).
  // Every link this component builds carries it, so a remote session's
  // breadcrumb and its post-creation rewrite stay on the remote.
  const hostId = hostFromPathname(pathname);
  const onCanvas = pathname === canvasHref(projectId, hostId);
  const sessionId = routeSessionId ?? (onCanvas ? undefined : createdSessionId);
  /** No session yet: the composer is the whole screen and nothing is polled. */
  const fresh = !sessionId;
  /**
   * What the FIRST message will create the session with. Only meaningful while
   * fresh — once a session exists, its own record is the truth and the picker
   * patches that instead.
   */
  const [draftDriver, setDraftDriver] = useState<ProviderDriverKind>("claude");
  /**
   * Where the first message will land.
   *
   * SEEDED FROM THE STANDING PREFERENCE (Settings → General → Workspace), which
   * is the same document the engine reads on the create path — so an untouched
   * canvas creates what it says it will, whatever that preference says. The
   * initial `local` is only what shows for the tick before the engine answers;
   * `touched` is what stops a late answer from overwriting a human's pick.
   */
  const [draftEnvMode, setDraftEnvMode] = useState<"local" | "worktree">("local");
  const [envModeTouched, setEnvModeTouched] = useState(false);
  const { defaults: sessionDefaults, loading: sessionDefaultsLoading } = useSessionDefaults();
  const [seededEnvMode, setSeededEnvMode] = useState<"local" | "worktree">();
  // A render-phase adjustment, not an effect — this app's lint enforces that
  // for "adjust state when a value changes", and the value here is the
  // engine's answer arriving.
  if (!sessionDefaultsLoading && !envModeTouched && seededEnvMode !== sessionDefaults.envMode) {
    setSeededEnvMode(sessionDefaults.envMode);
    setDraftEnvMode(sessionDefaults.envMode);
  }
  /** EVERY human pick goes through here, so the seed above can never overwrite
   *  one — including the implicit pick of choosing a base ref. */
  const chooseEnvMode = useCallback((next: "local" | "worktree") => {
    setEnvModeTouched(true);
    setDraftEnvMode(next);
  }, []);
  /** The base-ref picker's create-time choice: what a worktree is cut from,
   *  and optionally the human's own name for its branch. Only meaningful with
   *  `envMode: "worktree"` — picking a base is what flips the mode there. */
  const [draftBase, setDraftBase] = useState<{ baseRef?: string; branchName?: string }>({});
  /**
   * A BASE REF THE CANVAS WAS OPENED WITH — `?base=<ref>`, which is what the
   * session menu's "New session on <branch>" carries (see `canvasHref`).
   *
   * THE ITEM NAMES A BRANCH, SO THE CANVAS HAS TO HONOUR ONE. Without this the
   * label would promise the new session is cut from where the old one works and
   * the composer would then create it from the standing default — a menu item
   * that lies about the only fact it states.
   *
   * SEEDED ONCE, AND ONLY WHILE FRESH. It is a create-time choice, so it has no
   * meaning on a session that already exists; and `chooseEnvMode` marks the
   * mode touched, which is what stops the standing preference arriving a moment
   * later and putting it back to `local`. A render-phase adjustment rather than
   * an effect, for the same reason the preference above is one — this app's lint
   * enforces that shape for "adjust state when a value changes".
   */
  const searchParams = useSearchParams();
  const requestedBase = fresh ? (searchParams.get("base") ?? undefined) : undefined;
  const [seededBase, setSeededBase] = useState<string>();
  if (requestedBase !== undefined && seededBase !== requestedBase) {
    setSeededBase(requestedBase);
    setDraftBase({ baseRef: requestedBase });
    chooseEnvMode("worktree");
  }
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
  }, [setDraftModel]);
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
  /**
   * The paging cursor of the WINDOWED transcript — where "Load earlier turns"
   * continues from. Owned by hydrate and by that button alone: a companion
   * snapshot (windowed to the same size) must not touch it, because its page
   * describes the sliding newest window, not how far the reader has paged.
   */
  const [page, setPage] = useState<SnapshotPage>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [requests, setRequests] = useState<EngineRequest[]>([]);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [draft, setDraft] = useState("");
  /** Files picked but not yet sent. Held as `File`s rather than uploaded on
   *  pick — see the upload loop in `submit` for why. */
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draftRunId, setDraftRunId] = useState<string>();
  const [error, setError] = useState<EngineApiError>();
  /**
   * WHEN WHAT IS ON SCREEN WAS LAST TRUE — set only while the engine is not
   * answering and the transcript being shown came out of the browser's own
   * recording (or was live until a moment ago). `undefined` is the ordinary
   * case: this is live. See lib/snapshot-cache.ts and lib/stale-state.ts.
   */
  const [stale, setStale] = useState<number>();
  /** The same value, readable from callbacks that must not re-subscribe the
   *  polling effect every time it changes. */
  const staleAt = useRef<number | undefined>(undefined);
  /** When the last successful read landed — the date a live transcript wears
   *  once the engine goes away under it. */
  const lastLiveAt = useRef<number | undefined>(undefined);
  /** Seeded from whether there is anything to load at all — a fresh canvas has
   *  no transcript to hydrate, so it must never paint a loading state. */
  const [loading, setLoading] = useState(Boolean(routeSessionId));
  /**
   * WHICH CONVERSATION'S OWN TRANSCRIPT IS ON SCREEN — the sync key the first
   * read after a switch answered for, whether it answered with a transcript or
   * with a failure.
   *
   * `turns` is not emptied when the route moves to another session (there would
   * be nothing to put in its place), so for a moment this component is still
   * holding the PREVIOUS session's rows; then the cached photograph replaces
   * them; then the live read. All three are the same conversation OPENING, and
   * the viewport has to place itself at the end of each without animating. This
   * is how it tells them apart from a turn streaming into a transcript the
   * reader is already sitting in. See components/ui/conversation.tsx.
   */
  const [readKey, setReadKey] = useState<string>();
  /** The transcript's scroll layer, reachable from `submit`. */
  const follow = useRef<ConversationFollowHandle>(null);
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
   * THE PANEL AS LAST COMMITTED, readable from a callback that must not take
   * `panel` as a dependency.
   *
   * A gesture that opens a file has to know WHICH Editor instance it is opening
   * it in before it touches either state (#322), and `showPanelTab` is handed
   * to every row in the transcript — depending on `panel` there would re-render
   * the whole conversation on each tab change.
   */
  const panelNow = useRef(panel);
  /**
   * EACH EDITOR INSTANCE'S OPEN FILES, beside the panel's open tabs and for the
   * same reasons: restored from localStorage after mount, written on every
   * change, and carried through the session being BORN (a canvas's files are
   * handed to the session the first message creates). Kept here rather than
   * inside the Editor because "open this file" is a gesture the conversation
   * makes — a chip, the agent's display tool, a compiled PDF — and those are
   * all up here.
   *
   * KEYED BY PANEL-TAB ID because there can be two Editors. The first one's id
   * IS `"editor"`, which is what lets its files keep the storage key they have
   * always had (`editorInstanceKey`).
   */
  const [editors, setEditors] = useState<Record<string, EditorState>>(() => ({}));
  // Keep the panel MOUNTED through its close animation so the shell can animate
  // out (see RightPanel `open`). `shown` drives the width; `mounted` the DOM.
  const panelPresence = usePanelPresence(panel.open);
  /**
   * SEEDED FROM THE SERVER when the page could resolve it, which is every case
   * that matters — the canvas. The client read below stays for the session
   * routes, which do not have it, and for a project renamed while open.
   */
  const [projectName, setProjectName] = useState<string | undefined>(serverProjectName);
  /** The project's data-science opt-in, read with its name. Off until known. */
  const [dataScience, setDataScience] = useState(false);
  /** The project's LaTeX opt-in — same lifecycle. */
  const [latex, setLatex] = useState(false);
  const cursor = useRef(0);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const syncKey = JSON.stringify([hostId ?? LOCAL_HOST, sessionId]);
  const syncSession = useRef(syncKey);
  const syncGeneration = useRef(0);
  const tailInFlight = useRef(false);

  useEffect(() => {
    if (syncSession.current === syncKey) return;
    syncSession.current = syncKey;
    syncGeneration.current += 1;
    syncQueue.current = Promise.resolve();
    tailInFlight.current = false;
    cursor.current = 0;
  }, [syncKey]);

  const enqueueSync = useCallback((operation: () => Promise<void>) => {
    const next = syncQueue.current.then(operation, operation);
    syncQueue.current = next.catch(() => undefined);
    return next;
  }, []);
  /** The engine answered — whatever it said. Drops the banner and dates the
   *  content, which is why an empty tail counts: it is proof of reachability,
   *  and without it a recovery with no new events never cleared the banner. */
  const live = useCallback(() => {
    lastLiveAt.current = Date.now();
    if (staleAt.current === undefined) return;
    staleAt.current = undefined;
    setStale(undefined);
  }, [setStale]);
  /** …and the snapshot the NEXT outage will show. Written from the freshly
   *  fetched values rather than from state, which has not committed yet. */
  const remember = useCallback((id: string, snapshot: SessionSnapshot & { events?: EngineEvent[] }) => {
    live();
    const store = snapshotStore();
    if (!store) return;
    // KEYED BY THE MAC THIS SCREEN IS ABOUT — two hosts can mint the same
    // session id, and one Mac's recording must never answer for another's.
    // `page` rides along so a cached open can still offer "Load earlier
    // turns" from where the recorded window ended; the journal (`events`,
    // `cursor`) is deliberately not photographed — the fold works from turns
    // and items alone, and hydrate replaces all of it.
    const foldedItems = snapshot.events ? projectJournal(snapshot.turns, snapshot.items, snapshot.events, snapshot.tasks)
      .flatMap((turn) => [...turn.items, ...turn.tasks.flatMap((task) => task.items)])
      .map((item) => ({ ...item, streamed: item.streamedText, streamedThrough: snapshot.cursor ?? item.streamedThrough })) : snapshot.items;
    void saveSnapshot(store, hostId ?? LOCAL_HOST, id, {
      session: snapshot.session,
      turns: snapshot.turns,
      items: foldedItems,
      tasks: snapshot.tasks,
      requests: snapshot.requests,
      ...(snapshot.page ? { page: snapshot.page } : {}),
    }).catch(() => undefined);
  }, [live, hostId]);
  /**
   * A read failed. An unreachable engine under a transcript is a BANNER — the
   * conversation stays, wearing the time it was last true — and everything
   * else is the error card it always was. The rule itself is in
   * lib/stale-state.ts; refs rather than state so this callback is stable and
   * the polling effect below does not re-subscribe on every render.
   */
  const fail = useCallback((cause: unknown, fallback: string) => {
    const failure = cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", fallback);
    const at = decideStale({
      code: failure.code,
      hasContent: staleAt.current !== undefined || lastLiveAt.current !== undefined,
      ...(staleAt.current === undefined ? {} : { cachedAt: staleAt.current }),
      ...(lastLiveAt.current === undefined ? {} : { lastLiveAt: lastLiveAt.current }),
    });
    if (at === undefined) {
      setError(failure);
      return;
    }
    // The banner replaces the card rather than sitting under it — including
    // the one a first read may have set before the recording finished loading.
    setError(undefined);
    staleAt.current = at;
    setStale(at);
  }, [setError, setStale]);
  const hydrate = useCallback(
    () =>
      enqueueSync(async () => {
        // Nothing to read before the first message creates the session.
        if (!sessionId) return;
        const generation = syncGeneration.current;
        // WINDOWED: the last ten user turns, not the whole history. Opening a
        // 76-turn session used to fetch 4.5 MB of settled transcript; the rest
        // stays on the engine behind "Load earlier turns".
        const hydrated = await sessionConnection(hostId ?? LOCAL_HOST, createEngineApi(hostFetcher(hostId)), sessionId, { turns: INITIAL_TURNS }).read();
        if (generation !== syncGeneration.current || syncSession.current !== syncKey) return;
        setSession(hydrated.session);
        setTurns(hydrated.turns);
        setItems(hydrated.items);
        setTasks(hydrated.tasks);
        setRequests(hydrated.requests);
        setEvents(hydrated.events);
        setPage(hydrated.page);
        // IN THE SAME COMMIT as the rows it is about. Told a render later, the
        // viewport would already have treated this transcript's arrival as
        // ordinary growth and animated it.
        setReadKey(syncKey);
        cursor.current = hydrated.cursor;
        remember(sessionId, hydrated);
      }),
    [enqueueSync, sessionId, remember, hostId, syncKey, setEvents, setItems, setPage, setReadKey, setRequests, setSession, setTasks, setTurns],
  );
  const tail = useCallback(
    () => {
      if (tailInFlight.current) return Promise.resolve();
      tailInFlight.current = true;
      const flightGeneration = syncGeneration.current;
      return enqueueSync(async () => {
        if (!sessionId) return;
        const generation = syncGeneration.current;
        const snapshot = await sessionConnection(hostId ?? LOCAL_HOST, createEngineApi(hostFetcher(hostId)), sessionId, { turns: INITIAL_TURNS }).read();
        if (generation !== syncGeneration.current || syncSession.current !== syncKey) return;
        cursor.current = snapshot.cursor;
        setSession(snapshot.session);
        setEvents(snapshot.events);
        setTurns((current) => mergeRows(current, snapshot.turns, (turn) => turn.runId));
        setItems((current) => mergeRows(current, snapshot.items, (item) => item.id));
        setTasks((current) => mergeRows(current, snapshot.tasks, (task) => task.id));
        setRequests(snapshot.requests);
        remember(sessionId, snapshot);
      }).finally(() => {
        if (flightGeneration === syncGeneration.current) tailInFlight.current = false;
      });
    },
    [enqueueSync, sessionId, remember, hostId, syncKey, setEvents, setItems, setRequests, setSession, setTasks, setTurns],
  );
  /** One page of settled turns above the transcript, on an explicit click —
   *  never on scroll, so reading the top of the window stays free. */
  const loadOlder = useCallback(() => {
    const before = page?.before;
    if (!sessionId || !before || loadingOlder) return;
    setLoadingOlder(true);
    void enqueueSync(async () => {
      const generation = syncGeneration.current;
      const older = await loadOlderTurns(createEngineApi(hostFetcher(hostId)), sessionId, before);
      if (generation !== syncGeneration.current || syncSession.current !== syncKey) return;
      setTurns((current) => mergeRows(older.turns, current, (turn) => turn.runId));
      setItems((current) => mergeRows(older.items, current, (item) => item.id));
      setTasks((current) => mergeRows(older.tasks, current, (task) => task.id));
      setPage(older.page);
    })
      .catch((cause) => setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not load earlier turns.")))
      .finally(() => setLoadingOlder(false));
  }, [enqueueSync, sessionId, page, loadingOlder, syncKey, hostId, setError, setItems, setLoadingOlder, setPage, setTasks, setTurns]);

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
    const task = window.setTimeout(() => {
      /**
       * THE FILES SOMEBODY LEFT OPEN SURVIVE THE UPGRADE. Before the Editor,
       * each was its own panel tab; `migratePanelTab` collapses those ids into
       * the single Editor tab, so they have to be read for their PATHS first or
       * the change would silently close every file anybody had open. Only when
       * this Editor has nothing stored of its own — a session migrated once
       * stays migrated, and re-seeding would resurrect files closed since.
       */
      const stored = readEditor(panelKey);
      const ids = readPanelTabIds(panelKey);
      const legacy = stored.files.length === 0 ? editorFromLegacyTabs(ids.tabs, ids.activeTab) : undefined;
      if (legacy) writeEditor(panelKey, legacy, Date.now());
      const restored = readPanelTabs<PanelTab>(panelKey, isPanelTab, migratePanelTab);
      // On desktop the native strip owns the pages: collapse any per-page
      // browser tabs persisted before this change into one "Browser" tab, so
      // an upgraded session does not still show the old per-page outer tabs.
      const next = desktopBrowserBridge() ? collapseBrowserTabs(restored, (tab) => browserTabId(tab) !== undefined, LIVE_BROWSER_TAB) : restored;
      /**
       * THE FIRST EDITOR IS LOADED WHETHER OR NOT ITS TAB IS OPEN — closing the
       * Editor has never thrown away the files in it, and reopening must still
       * find them. Any FURTHER Editor instance is loaded only because its tab
       * came back, since nothing else could name it.
       */
      const loaded: Record<string, EditorState> = { editor: legacy ?? stored };
      for (const entry of next.tabs) {
        if (entry.kind === "editor" && !(entry.id in loaded)) loaded[entry.id] = readEditor(editorInstanceKey(panelKey, entry.id));
      }
      setEditors(loaded);
      panelNow.current = next;
      setPanel(next);
    }, 0);
    return () => window.clearTimeout(task);
  }, [panelKey]);

  const updatePanel = useCallback(
    (next: (current: PanelTabState<PanelTab>) => PanelTabState<PanelTab>) => {
      setPanel((current) => {
        const updated = next(current);
        // A reducer that decided nothing changed is not a write: the params
        // sync below runs on every Editor keystroke-ish change and most of
        // them leave the strip exactly as it was.
        if (updated === current) return current;
        panelNow.current = updated;
        writePanelTabs(panelKey, updated, Date.now());
        return updated;
      });
    },
    [panelKey, setPanel],
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
      if (!sessionId) {
        /**
         * A FRESH CANVAS ON ANOTHER MAC CAN OPEN A BROWSER TOO — that Mac's,
         * through its engine, watched from here as screenshots. The gate used
         * to require this window's native bridge, which a remote screen never
         * has, so a remote canvas had no browser button at all; the button's
         * own path (`openBrowser`) already speaks to the right engine via
         * `hostFetcher(hostId)`. Locally the bridge is still the tell: without
         * it the local engine's worker owns the browser out of process.
         */
        setBrowserCanStart(Boolean(projectId && (hostId !== LOCAL_HOST_ID || desktopBrowserBridge())));
        return;
      }
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
  }, [sessionId, projectId, hostId]);

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

  /** One Editor instance's files, persisted on every change exactly as the
   *  panel's tabs are — same key, so a session's arrangement is one thing. */
  const updateEditor = useCallback(
    (id: string, next: (current: EditorState) => EditorState) => {
      setEditors((current) => {
        const updated = next(current[id] ?? emptyEditor());
        writeEditor(editorInstanceKey(panelKey, id), updated, Date.now());
        return { ...current, [id]: updated };
      });
    },
    [panelKey, setEditors],
  );

  /**
   * WHICH EDITOR A FILE OPENS IN, when the gesture did not say.
   *
   * THE ONE YOU ARE LOOKING AT. With two Editors open, clicking a file in the
   * second one's tree and having it appear in the first — and the strip jump
   * back to it — would make the second Editor unusable. Failing that, the
   * leftmost; failing that, the id a first Editor would take, so the caller can
   * seed its files before the tab exists.
   */
  const editorTargetId = useCallback((state: PanelTabState<PanelTab>) => {
    const active = activePanelTab(state);
    if (active?.kind === "editor") return active.id;
    return state.tabs.find((entry) => entry.kind === "editor")?.id ?? nextPanelTabId(state, "editor");
  }, []);

  /**
   * THE STRIP'S LABELS FOLLOW THE FILES. An Editor instance's params ARE its
   * open file (#322), which is what "Editor · README.md" is read out of, so
   * they are kept true here rather than at each of the dozen call sites that
   * can open a file.
   *
   * ONLY FOR INSTANCES THIS COCKPIT HAS LOADED. A restored tab whose files have
   * not arrived yet keeps the params it was persisted with; clearing them for a
   * frame would blank the label and write the blank to disk.
   */
  useEffect(() => {
    updatePanel((current) => {
      let next = current;
      for (const entry of current.tabs) {
        if (entry.kind !== "editor" || !(entry.id in editors)) continue;
        const path = editors[entry.id]?.activePath;
        next = setPanelTabParams(next, entry.id, path ? { path } : {});
      }
      return next;
    });
  }, [editors, updatePanel]);

  /**
   * Open the panel on a named surface — what every "go there" gesture calls.
   *
   * A FILE IS NOT A SURFACE ANY MORE, and this is where that is decided. Every
   * caller still names a file the way it always did (`file:src/a.ts`, `pdf:…`),
   * because those call sites are spread across the conversation, the agent's
   * display tool, the LaTeX surface and the tree — rewriting all of them would
   * have been the change, rather than a consequence of it. So a file-shaped id
   * opens the file in the EDITOR and brings the Editor forward; anything else
   * is a tab, as before.
   *
   * PINNED BY DEFAULT, because everything that reaches this function is a
   * DELIBERATE open: a chip somebody pressed, a file the agent put in front of
   * them, a document a compile produced. Only the tree's single click asks for
   * a preview, and it says so.
   */
  const showPanelTab = useCallback(
    (tab: PanelTab, intent: OpenIntent = "pin") => {
      makeRoomForPanel();
      const path = filePanelTabPath(tab);
      if (path !== undefined) {
        // Resolved from the committed strip, and handed to BOTH updates, so the
        // file and the tab that comes forward cannot name different Editors.
        const target = editorTargetId(panelNow.current);
        updateEditor(target, (current) => openInEditor(current, editorFileForPath(path, dataScience), intent));
        updatePanel((current) => openPanelTab(current, "editor"));
        return;
      }
      updatePanel((current) => openPanelTab(current, tab));
    },
    [makeRoomForPanel, updatePanel, updateEditor, editorTargetId, dataScience],
  );

  /**
   * OPEN A FILE IN A SECOND EDITOR — the gesture #322 is for, offered by the
   * file tree, a file's own body and the transcript's file chips.
   *
   * A NEW INSTANCE EVERY TIME, deliberately: "open in a new panel tab" that
   * sometimes reused a tab would be a worse version of the ordinary open, which
   * is one menu row above it and already focuses what is open.
   */
  const openFileInNewPanelTab = useCallback(
    (path: string) => {
      makeRoomForPanel();
      // Minted from the committed strip so the files can be seeded under the
      // same id the tab is about to take.
      const id = nextPanelTabId(panelNow.current, "editor");
      updateEditor(id, (current) => openInEditor(current, editorFileForPath(path, dataScience), "pin"));
      updatePanel((current) => addPanelTab(current, { id, kind: "editor", params: { path } }));
    },
    [makeRoomForPanel, updatePanel, updateEditor, dataScience],
  );

  /**
   * Another instance of a surface you can have two of — the "+" chooser's verb
   * once one is already open, and the Diff row's "Open in a new panel tab".
   *
   * `params` IS WHAT MAKES IT A DIFFERENT ONE (#335): a second Diff opened from
   * a row arrives already filtered to that row's path, which is also what names
   * it in the strip. Absent is the chooser's own press — a blank instance.
   */
  const showNewPanelTab = useCallback(
    (tab: PanelTab, params?: PanelTabParams) => {
      makeRoomForPanel();
      updatePanel((current) => openNewPanelTab(current, tab, params));
    },
    [makeRoomForPanel, updatePanel],
  );

  /**
   * THE PANEL'S COMMANDS (#367), bound while this cockpit is mounted.
   *
   * WHY HERE AND NOT IN THE PANEL: the strip is the cockpit's state — the panel
   * is handed its tabs and reports gestures back — so "open the Diff" and "next
   * tab" can only be answered from up here. `panel-fullscreen` is the one that
   * genuinely belongs to the panel, and the panel binds that one itself.
   *
   * OPENING A SURFACE OPENS THE PANEL, because a chord that quietly added a tab
   * behind a closed panel would look like a chord that did nothing. Closing is
   * the toggle's job alone.
   *
   * NEXT/PREVIOUS WRAP, and read the COMMITTED strip (`panelNow`) rather than
   * `panel`, so this registration does not have to be rebuilt on every tab
   * change. They no-op on a strip of nothing rather than opening an empty panel.
   */
  const stepPanelTab = useCallback(
    (delta: number) => {
      const current = panelNow.current;
      if (current.tabs.length === 0) return;
      const count = current.tabs.length;
      const at = Math.max(current.tabs.findIndex((entry) => entry.id === current.activeTab), 0);
      const next = current.tabs[(at + delta + count) % count];
      if (next) updatePanel((state) => ({ ...state, activeTab: next.id, open: true }));
    },
    [updatePanel],
  );

  useCommandHandlers(
    {
      "toggle-panel": () => {
        if (panelNow.current.open) {
          updatePanel((current) => ({ ...current, open: false }));
          return;
        }
        makeRoomForPanel();
        updatePanel((current) => ({ ...current, open: true }));
      },
      "panel-next-tab": () => stepPanelTab(1),
      "panel-previous-tab": () => stepPanelTab(-1),
      "open-diff": () => showPanelTab("diff"),
      "open-editor": () => showPanelTab("editor"),
      // The two surfaces a project opts into. Bound only while the plugin is on,
      // so ⇧⌘B on a project with no notebooks does nothing rather than opening a
      // tab whose surface is not there — hence the dependency array.
      ...(dataScience ? { "open-data": () => showPanelTab("data") } : {}),
      ...(latex ? { "open-latex": () => showPanelTab("latex") } : {}),
    },
    [dataScience, latex, stepPanelTab, showPanelTab, updatePanel, makeRoomForPanel],
  );

  /**
   * THE BROWSER THE ENGINE DRIVES, which is a specific one.
   *
   * A session can hold two Browser tabs now, each on its own native scope
   * (`browserScopeKey`), and only the FIRST is the session's own — the one the
   * agent navigates and the one `openBrowser` starts. So a page the engine just
   * opened, or a link routed into the session browser, must bring THAT tab
   * forward: `showPanelTab` would focus whichever Browser you happened to be
   * reading, which for a second browser means arriving at a page that is not
   * the one anything just opened.
   */
  const showSessionBrowser = useCallback(() => {
    makeRoomForPanel();
    updatePanel((current) => addPanelTab(current, { id: LIVE_BROWSER_TAB, kind: LIVE_BROWSER_TAB, params: {} }));
  }, [makeRoomForPanel, updatePanel]);

  /**
   * PUT TEXT INTO THE MESSAGE BEING WRITTEN — the keyboard-and-menu twin of the
   * drag every panel row already offers (`lib/drag-reference.ts`).
   *
   * WHAT IT INSERTS IS TEXT, AND THAT IS THE WHOLE DESIGN, for the reason that
   * module's header gives at length: nothing is resolved behind the scenes, so
   * `turn.input` says exactly what the model was sent. A quote is the words you
   * are looking at; a reference is a path in backticks. Both are what you would
   * have typed.
   *
   * APPENDED, NOT SPLICED AT THE CARET. The caret lives inside `ComposerEditor`
   * and this component cannot see it — a drop knows where it landed and this
   * gesture does not, so it goes where a person's next sentence goes. The
   * spacing is `insertReference`'s own, which is what stops "fix " becoming
   * "fix  `a.ts`"; a MULTI-LINE insert (a quoted message) is a paragraph of its
   * own instead, because a block quote welded onto the end of a sentence is not
   * a quote of anything.
   *
   * The debounced `writeDraft` below persists it like any keystroke.
   */
  const insertIntoComposer = useCallback((text: string) => {
    if (!text) return;
    setDraft((current) => {
      if (!current.trim()) return text;
      return text.includes("\n") ? `${current.replace(/\s+$/, "")}\n\n${text}` : insertReference(current, text, current.length).draft;
    });
    // A draft that came back from a turn stops being that turn's recall the
    // moment anything is added to it — the same rule `onDraftChange` follows.
    setDraftRunId(undefined);
  }, [setDraft, setDraftRunId]);

  /**
   * LINK CLICKS IN THE CONVERSATION, when the Links setting says "keep them
   * here" (`lib/link-policy.ts`): an issue or pull request OF THIS PROJECT
   * opens as its right-panel tab, anything else as a tab in the session's
   * integrated browser, and only when neither is possible does the click fall
   * through to the system browser.
   *
   * A CAPTURE HANDLER OVER THE VIEWPORT, not a component per anchor: the
   * anchors are Streamdown's, deep inside markdown this component does not
   * render. Modified clicks (cmd, middle) keep the browser's own meaning.
   *
   * The repository is fetched ONCE, lazily, on the first GitHub-shaped click —
   * the engine caches the snapshot, and routing `other-org/other-repo#12` into
   * a surface that queries THIS project's issue 12 would show the wrong thing.
   */
  const projectRepo = useRef<Promise<string | undefined> | undefined>(undefined);
  const onConversationClick = useCallback(
    (event: React.MouseEvent) => {
      if (!openLinksInSessionBrowser()) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement).closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      const forge = parseForgeLink(href);
      void (async () => {
        if (forge && projectId) {
          projectRepo.current ??= createEngineApi(hostFetcher(hostId))
            .projectGitHub(projectId)
            .then((answer) => answer.github.repository, () => undefined);
          if (sameRepository(await projectRepo.current, forge.repository)) {
            showPanelTab(forge.kind === "issue" ? issuePanelTab(forge.number) : pullPanelTab(forge.number));
            return;
          }
        }
        const landed = await openUrlInSessionBrowser(sessionId, projectId, href, hostId);
        if (landed === "native") {
          showSessionBrowser();
          return;
        }
        if (landed === "engine") {
          // The screenshot surface's tab arrives through the journal fold
          // (`browser.state.changed`) on the next sync; the panel opens the
          // page as its own tab then — see the `seenPages` effect.
          updatePanel((current) => ({ ...current, open: true }));
          return;
        }
        window.open(href, "_blank", "noopener,noreferrer");
      })();
    },
    [hostId, projectId, sessionId, showPanelTab, showSessionBrowser, updatePanel],
  );

  /**
   * Launch the session's browser by hand. The engine journals what it opened,
   * so the tab ALSO arrives through the ordinary event fold — the direct
   * `showPanelTab` here is only what makes the gesture feel immediate instead
   * of waiting one sync cycle.
   */

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
      // Desktop: one stable browser tab (the native strip lists the pages);
      // other clients: one panel tab per page (their only way to switch).
      // The engine's pages belong to the SESSION's own scope, which is the
      // first Browser tab — see `showSessionBrowser`.
      if (desktopBrowserBridge()) return addPanelTab(current, { id: LIVE_BROWSER_TAB, kind: LIVE_BROWSER_TAB, params: {} });
      return fresh.reduce((state, page) => openPanelTab(state, browserPanelTab(page.id)), current);
    });
  }, [browser, updatePanel]);

  /**
   * A FILE THE AGENT ASKED TO SHOW OPENS THE PANEL — the deliberate exception
   * to `seenPages`' "may not interrupt what you are reading" rule, because
   * `display_open`'s entire contract is putting a finished thing in front of
   * you; arriving quietly would be the failure.
   *
   * ONLY EVENTS FROM AFTER THIS MOUNT ACT. The journal replays from zero on
   * every load, so without the timestamp guard, every reload would re-open
   * whatever the agent displayed last week. `seenDisplays` then keeps one
   * event from acting twice as the array grows behind it, and — same reason
   * `seenPages` is a ref — closing the tab must not reopen it on the next poll.
   */
  const seenDisplays = useRef<Set<number>>(new Set());
  // Stamped in the effect, not at render: reading the clock during render is
  // impure (react-hooks/purity). The first run of this effect precedes any
  // display event being acted on, so the guard holds identically.
  const mountedAt = useRef(0);
  useEffect(() => {
    if (mountedAt.current === 0) mountedAt.current = Date.now();
    const fresh = events.filter(
      (event) => event.type === "display.opened" && event.at >= mountedAt.current && !seenDisplays.current.has(event.id),
    );
    if (fresh.length === 0) return;
    for (const event of fresh) seenDisplays.current.add(event.id);
    const last = fresh.at(-1)!;
    if (last.type !== "display.opened") return;
    showPanelTab(panelTabForPath(last.path, dataScience));
  }, [events, dataScience, showPanelTab]);

  /**
   * Restore an unsent draft, and keep it saved as it is typed.
   *
   * Read in an effect for the same reason the panel state is: `localStorage`
   * does not exist during the server render, so seeding `useState` from it would
   * make the two disagree. The write is debounced because it runs on every
   * keystroke and a synchronous `setItem` per character is a jank source on a
   * long message.
   */

  /**
   * WHICH COMPOSER THE TEXT IN `draft` WAS TYPED INTO.
   *
   * NEEDED BECAUSE THIS COMPONENT OUTLIVES THE CONVERSATION IT SHOWS. The route
   * segment is the same for every session, so moving between two of them — or
   * clicking a draft row while a session is open — re-renders this instance
   * rather than remounting it, and `draft` is ordinary state that survives. The
   * restore below could only ever FILL an empty box, never replace a full one,
   * so whatever you had half-written in the last conversation simply stayed on
   * screen in the next one, and a draft you clicked could not load over it.
   *
   * Comparing against this ref is what tells a re-render from a change of
   * hands. `submit` reassigns it directly when the first message creates a
   * session: the box did not change hands there, it is the same box that just
   * learned its id, and treating that as a switch would empty it under anyone
   * who started typing a follow-up during the round trip.
   */
  const owner = useRef<{ sessionId: string | undefined; projectId: string }>({ sessionId, projectId });
  /** The live text, readable from an effect that must not re-run per keystroke. */
  const draftText = useRef(draft);
  const [browserStart, setBrowserStart] = useState<BrowserStartState>({ status: "idle" });
  const browserOpening = useRef(false);
  const browserDraftIdentity = useRef<{ path: string; id: string } | null>(null);
  const browserDraftFlight = useRef<Promise<string> | null>(null);
  const browserDraftSendPending = useRef(false);

  async function ensureBrowserDraft(): Promise<string> {
    if (sessionId) return sessionId;
    if (browserDraftFlight.current) return browserDraftFlight.current;
    const origin = window.location.pathname;
    if (browserDraftIdentity.current?.path !== origin) {
      browserDraftIdentity.current = { path: origin, id: `session_${crypto.randomUUID().replaceAll("-", "")}` };
    }
    const id = browserDraftIdentity.current.id;
    // Keep both requests on the originating host if navigation changes mid-flight.
    const draftApi = createEngineApi(hostFetcher(hostId));
    const flight = (async () => {
      const created = await draftApi.createSession(projectId, {
        id, draft: true, title: "Browser draft", driver: draftDriver, envMode: draftEnvMode,
        ...(draftEnvMode === "worktree" ? draftBase : {}),
      });
      const model = sessionModelSelection(created.session.providerInstanceId, draftModel);
      const patched = await draftApi.updateSession(id, {
        runtimeMode: draftRuntimeMode,
        ...(model ? { model } : {}),
      });
      // Keep the durable draft, but never navigate over a different conversation.
      if (window.location.pathname !== origin) return id;
      writeDraft(id, projectId, draftText.current);
      writeDraft(undefined, projectId, "");
      writePanelTabs(id, panel, Date.now());
      // …and the files open in EACH Editor with them: the arrangement a person
      // built while writing the first message is the arrangement they want
      // while it runs.
      for (const [instance, state] of Object.entries(editors)) writeEditor(editorInstanceKey(id, instance), state, Date.now());
      /**
       * AND THE CANVAS FORGETS IT, which is the difference between a hand-off
       * and a default. `new:<projectId>` is ONE key shared by every new
       * conversation in the project, so an arrangement left there was
       * inherited by all of them — the reported "every conversation opens with
       * Run showing". Cleared here, this conversation keeps what was arranged
       * for it and the next one starts closed.
       */
      clearPanelTabs(canvasPanelKey(projectId));
      for (const instance of Object.keys(editors)) clearEditor(editorInstanceKey(canvasPanelKey(projectId), instance));
      clearEditor(canvasPanelKey(projectId));
      owner.current = { sessionId: id, projectId };
      setSession(patched.session);
      setCreatedSessionId(id);
      const destination = sessionHref({ id, projectId, hostId });
      browserDraftIdentity.current = { path: destination, id };
      window.history.replaceState(null, "", destination);
      return id;
    })();
    browserDraftFlight.current = flight;
    try { return await flight; } finally { browserDraftFlight.current = null; }
  }

  async function openBrowser() {
    if (browserOpening.current) return;
    browserOpening.current = true;
    const origin = window.location.pathname;
    setBrowserStart({ status: "pending" });
    let destination = origin;
    const browserApi = createEngineApi(hostFetcher(hostId));
    try {
      const target = await ensureBrowserDraft();
      destination = sessionHref({ id: target, projectId, hostId });
      if (window.location.pathname !== origin && window.location.pathname !== destination) return;
      // Bind the native host before the engine asks it to create the first tab.
      // This also covers a renderer updated while its engine is still running.
      await desktopBrowserBridge()?.bindProfile?.(target, projectId ?? "none");
      if (window.location.pathname !== origin && window.location.pathname !== destination) return;
      const result = await browserApi.browserState(target, { start: true });
      if (window.location.pathname !== destination) return;
      setBrowserStart(describeBrowserStart(result.browser));
      const active = result.browser.tabs.find((tab) => tab.active) ?? result.browser.tabs[0];
      // On desktop the native strip owns the pages — one stable "Browser" tab.
      if (active) {
        if (desktopBrowserBridge()) showSessionBrowser();
        else showPanelTab(browserPanelTab(active.id));
      }
    } catch (error) {
      // NEVER SILENT: a press that ends in nothing is the one outcome a person
      // cannot tell apart from "still starting".
      if (window.location.pathname === origin || window.location.pathname === destination) {
        setBrowserStart({ status: "error", message: error instanceof Error ? error.message : "The engine could not start a browser." });
      }
    } finally {
      browserOpening.current = false;
    }
  }

  useEffect(() => {
    draftText.current = draft;
  }, [draft]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      if (owner.current.sessionId !== sessionId || owner.current.projectId !== projectId) {
        const leaving = owner.current;
        owner.current = { sessionId, projectId };
        // SAVED ON THE WAY OUT, because the debounced write below is CANCELLED
        // by this very change rather than flushed — so without this, switching
        // conversations within 400ms of a keystroke silently ate the tail of
        // what you had written.
        writeDraft(leaving.sessionId, leaving.projectId, draftText.current);
        // AUTHORITATIVE, unlike the fallback below: a different composer's text
        // is not a draft for this one.
        setDraft(readDraft(sessionId, projectId));
        return;
      }
      const stored = readDraft(sessionId, projectId);
      // The first paint, where this reads back what a reload dropped. Never
      // clobbers something already typed — here the restore is a fallback for
      // an empty box, not an authority over it.
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
      (result) => {
        if (cancelled) return;
        const found = result.projects.find((project) => project.id === projectId);
        setProjectName(found?.name);
        const plugins = cockpitPlugins(found);
        setDataScience(plugins.dataScience);
        setLatex(plugins.latex);
      },
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
    // Another session's liveness says nothing about this one.
    lastLiveAt.current = undefined;
    staleAt.current = undefined;
    /**
     * THE LAST THING RECORDED, painted while the real read is in flight — so a
     * cockpit opened against a dead engine shows the conversation with a
     * banner instead of an error card. Only until something live arrives:
     * `hydrate` below overwrites all of it and drops the banner.
     *
     * `events([])` because the journal is not photographed — the transcript
     * folds fine from turns and items alone, and the fold is what is on screen.
     */
    void snapshotStore()
      ?.read(snapshotKey(hostId ?? LOCAL_HOST, sessionId))
      .then((cached) => {
        if (!cached || cancelled || lastLiveAt.current !== undefined) return;
        setSession(cached.session);
        setTurns(cached.turns);
        setItems(cached.items);
        setTasks(cached.tasks);
        setRequests(cached.requests);
        // The recorded window's own paging cursor, so "Load earlier turns"
        // works from a cached open once the engine answers again.
        setPage(cached.page);
        setEvents([]);
        staleAt.current = cached.savedAt;
        setStale(cached.savedAt);
        setLoading(false);
      }, () => undefined);
    void hydrate()
      .then(
        () => !cancelled && setError(undefined),
        (cause) => {
          if (cancelled) return;
          fail(cause, "Could not hydrate this session.");
          // A READ THAT FAILED STILL ENDS THE OPENING. Whatever is on screen —
          // the recording, or nothing — is what this session has, and a viewport
          // still waiting to be placed pins itself to the bottom on every
          // commit, so a reader under a dead engine could never scroll up.
          setReadKey(syncKey);
        },
      )
      .finally(() => !cancelled && setLoading(false));
    const interval = window.setInterval(() => {
      void tail().catch((cause) => !cancelled && fail(cause, "Could not tail the session journal."));
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hydrate, tail, sessionId, hostId, fail, syncKey]);

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
  // A HELD turn is not about to run — a pause or a restart is holding it —
  // so it is not "busy" either: the composer must not promise to steer into
  // it, and the send button must not read as a Stop.
  const active =
    transcript.find((turn) => turn.state === "claimed" || turn.state === "running") ?? transcript.find((turn) => isActiveTurn(turn.state) && !turn.held);
  const running = Boolean(transcript.find((turn) => turn.state === "claimed" || turn.state === "running"));
  /** The provider is squeezing its context right now — an open
   *  context_compaction row on the live turn. Gates the compact button so the
   *  client tells the same story the engine enforces. */
  const compacting = isCompacting(active);
  /**
   * The one ordinary failure the session can continue from — the latest human
   * turn, failed, with nothing running or queued behind it. `undefined` hides
   * the affordance. A turn Telar interrupted by quitting lands here too, which
   * is the whole point of recording it as a failure rather than as ambiguity.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  // Only OPEN requests on a turn that can still take the answer are actionable;
  // resolved ones are history, and one left on an ended turn has no worker
  // waiting for it (see `actionableRequests`).
  const openRequests = useMemo(() => actionableRequests(requests, transcript), [requests, transcript]);
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

  /**
   * THE STOP BUTTON STOPS. What is running ends, what was queued behind it is
   * settled rather than started, and the session is idle — the next message
   * runs, with nothing to resume.
   *
   * IT USED TO PAUSE, and that was wrong twice over. Stopping one turn let the
   * worker claim the next queued message within a heartbeat — the measured "I
   * pressed stop and it started again" — and a pause was reached for because
   * it suppressed that. But the leftovers were the problem, not the session's
   * willingness to work: the latch made a person who pressed Stop press Resume
   * before they could say anything, which is not what Stop means.
   *
   * `stopSession` settles the leftovers instead, so no latch is needed. The
   * pause is still its own thing, with its own affordance — a session already
   * paused keeps its banner and its Resume.
   */
  const stop = async () => {
    if (!sessionId) return;
    setSending(true);
    try {
      await api.stopSession(sessionId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not stop the session."));
    } finally {
      setSending(false);
    }
  };
  /**
   * Stop the lingering background tasks — the "N tasks still working" chip.
   * DELIBERATELY NOT `stop()`: that one bails when no turn is running, which is
   * exactly when background work is what is left to stop, and a background task
   * is not stopped by stopping a turn (the turn may have finished long ago).
   */
  const stopBackground = async () => {
    if (!sessionId) return;
    setSending(true);
    try {
      await api.stopBackgroundTasks(sessionId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not stop the background tasks."));
    } finally {
      setSending(false);
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
      // `kind: "compact"` is what makes it a gesture rather than a sentence:
      // the transcript draws a system row, and the engine refuses a second
      // one while this one is in flight.
      await api.submitTurn(sessionId, { runId: newRunId(), input: "/compact", kind: "compact" });
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
    /**
   * CONTINUE, from an uncertain run. Releases the engine's held dispatch and
   * puts a continuation in the composer — it SENDS NOTHING. The original prompt
   * is never resubmitted: the transcript above already holds whatever the lost
   * run managed, and the person writes the next message themselves.
   *
   * The draft's wording depends on whether the conversation can actually be
   * resumed; with no provider cursor the agent will not remember any of this,
   * and saying "continue from the work above" would point at something only the
   * human can see.
   */
    /** The person re-read a held message and still means it: it runs, in its
   *  original place in the queue. */
    /** ...or no longer wants it. An ordinary stop — a held message is still just
   *  a queued turn, and `stopTurn` already ends one. */
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
  /** Sit out a usage limit and carry on, or stay stopped. Explicit either way:
   *  the engine stores only a deliberate choice, so the driver's default keeps
   *  applying to every session that never touched this. */
  const setResumeAfterRateLimit = async (next: boolean) => {
    if (!sessionId) return;
    try {
      const updated = await api.updateSession(sessionId, { resumeAfterRateLimit: next });
      setSession(updated.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not change that setting."));
    }
  };
  /** Don't wait for the limit to lift. The engine re-queues the same turn, so
   *  the provider session — and its context — carries on where it stopped. */
  const resumeNow = async (runId: string) => {
    if (!sessionId) return;
    setSending(true);
    try {
      await api.resumeRateLimitedTurn(sessionId, runId);
      await hydrate();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not resume that turn."));
    } finally {
      setSending(false);
    }
  };
  const submit = async () => {
    if (!draft.trim() || browserDraftSendPending.current) return;
    /**
     * `/compact` TYPED OUT IS THE SAME PRESS AS THE WHEEL'S BUTTON.
     *
     * Picking the row in the slash menu already routes here through `onCompact`;
     * this catches the other way in — typed in full, menu dismissed, Enter —
     * so the two gestures cannot disagree about what `/compact` does.
     *
     * ONLY WHEN THE DOOR IS ACTUALLY OPEN. On Codex, on a canvas, or while a
     * compaction is already in flight, the words stay an ordinary message
     * rather than becoming a press that would be refused.
     */
    if (isCompactDraft(draft) && sessionId && session?.driver === "claude" && !active && !compacting) {
      setDraft("");
      writeDraft(sessionId, projectId, "");
      await compact();
      return;
    }
    // A send racing the first browser open joins its stable session identity.
    let browserTarget: string | undefined;
    if (browserDraftFlight.current) {
      browserDraftSendPending.current = true;
      const origin = window.location.pathname;
      try {
        browserTarget = await browserDraftFlight.current;
      } catch (cause) {
        setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not save the browser draft. Your message is still here."));
        return;
      } finally {
        browserDraftSendPending.current = false;
      }
      const destination = sessionHref({ id: browserTarget, projectId, hostId });
      if (window.location.pathname !== origin && window.location.pathname !== destination) return;
    }
    const runId = draftRunId ?? newRunId();
    setDraftRunId(runId);
    setSending(true);
    /**
     * SENDING ALWAYS GOES TO THE END, whatever the scroll layer believed.
     *
     * Before the bubble exists, not after: the reply arrives by hydrate or by
     * poll, and this only has to re-arm following so that the growth carrying
     * it is followed. Unconditional on purpose — you wrote the message, so it
     * is the thing you want to be looking at, and a reader who had scrolled up
     * to quote something would otherwise send into a transcript that never
     * moves. See lib/scroll-follow.ts for why the lock can be dropped without
     * anyone asking.
     */
    follow.current?.toBottom();
    // Cleared OPTIMISTICALLY and before the round trip: the box emptying is the
    // acknowledgement, and waiting on the network to give it back is the thing
    // that makes queueing feel like a form submission.
    const text = draft.trim();
    const files = attachments;
    setDraft("");
    /**
     * AND CLEARED IN STORAGE HERE, not by the debounced save below.
     *
     * A fresh canvas keys its draft `new:<project>` — one slot shared by every
     * new conversation in the project — and sending is the single moment that
     * key changes identity underneath the save. `setDraft("")` only SCHEDULES
     * the removal, 400ms out; `setCreatedSessionId` lands well inside that
     * window, and the save effect's cleanup CANCELS the pending write rather
     * than flushing it, because the id it was keyed on is now a dependency that
     * changed. What survived was the message you had just sent, still sitting
     * in the canvas slot, restored into the next conversation you started —
     * only ever the first message of a session, because only the first is typed
     * before the session has an id of its own.
     *
     * Removing it now, against the id it was actually typed under, puts the
     * clear before anything can cancel it. The master chat has always done this
     * on send, for this reason.
     */
    writeDraft(sessionId ?? browserTarget, projectId, "");
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
      let target = sessionId ?? browserTarget;
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
        const model = sessionModelSelection(created.session.providerInstanceId, draftModel);
        const creationPatch = {
          ...(draftRuntimeMode === "auto" ? {} : { runtimeMode: draftRuntimeMode }),
          ...(model ? { model } : {}),
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
        // Every Editor's files travel with them — same hand-off, same reason.
        for (const [instance, state] of Object.entries(editors)) writeEditor(editorInstanceKey(target, instance), state, Date.now());
        // A NEW SESSION STARTS EMPTY. Ordinarily this state is already empty —
        // the canvas polls nothing — but a canvas reached by pressing "New
        // conversation" inherits whatever the last conversation left here, and
        // it would paint for the frame between this and the first hydrate.
        setTurns([]);
        setItems([]);
        setTasks([]);
        setRequests([]);
        setEvents([]);
        // THE SAME BOX, WITH AN ID NOW — not a different composer. Handing
        // ownership over before the id lands stops the restore effect treating
        // this as a switch and emptying a follow-up typed during the round trip.
        owner.current = { sessionId: target, projectId };
        setCreatedSessionId(target);
        // Only when the patch did not already give us a newer record.
        if (Object.keys(creationPatch).length === 0) setSession(created.session);
        window.history.replaceState(null, "", sessionHref({ id: target, projectId, hostId }));
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

  /**
   * IS THIS CONVERSATION ON THE SETTLED SHELF RIGHT NOW? Same rule, same
   * inputs as the sidebar (`bandOf` folds the identical fields), so the
   * banner over the composer and the shelf in the rail can never disagree.
   * The shelf no longer springs open to show you the row you are inside —
   * this banner is what says "you are reading settled history" instead.
   *
   * Archived is excluded: it reports settled too, but there is no un-settle
   * for it, and a banner whose one button cannot work is worse than none.
   */
  const { policy: inboxPolicy } = useInboxPolicy();
  const settled = Boolean(
    session &&
      session.state !== "archived" &&
      isSettled(
        {
          archived: false,
          updatedAt: session.updatedAt,
          ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
          ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
          ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
          ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
          // The unread pair and the read stamp, so this banner and the rail
          // fold the SAME fields. Without them the cockpit would call a
          // session with an unread answer settled while the row it came from
          // says otherwise — and the banner is the thing claiming to explain
          // the row.
          ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
          ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
          ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
        },
        {
          working: session.activity === "working" || session.activity === "queued",
          waitingOnYou: session.activity === "blocked",
        },
        { now, autoSettleAfterHours: inboxPolicy.autoSettleAfterHours },
      ),
  );
  const unsettle = async () => {
    if (!sessionId) return;
    try {
      // A drift-settled session has no override to clear, and clearing nothing
      // writes nothing. Setting an override first makes the clearing patch a
      // real change, and a real change stamps `updatedAt`, which is what
      // actually restarts the inactivity clock. Same two-step as the row's.
      if (session?.settledOverride !== "settled") await api.updateSession(sessionId, { settledOverride: "active" });
      const next = await api.updateSession(sessionId, { settledOverride: null });
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not return the session to the list."));
    }
  };

  /**
   * THE TITLE MENU'S VERBS — the same list the rail row draws, answered with
   * this screen's own record instead of the rail's projection.
   *
   * ON THE SESSION'S OWN MAC. The module-level `api` is this Mac's engine; a
   * session being read on a paired Mac must have its verbs land where the
   * record lives, for `sessionFetch`'s reason in session-inbox-menu.tsx — a
   * local session sharing the id is a real possibility, not a theoretical one.
   *
   * FAILURES GO TO THE SCREEN'S EXISTING ERROR SURFACE rather than an alert.
   * The rail has none and uses `window.alert`; the cockpit has `setError`, and
   * a modal dialog over a conversation would be the louder of the two options
   * for the same information.
   */
  const router = useRouter();
  /** The desktop shell, or nothing in a browser tab — what decides whether the
   *  title menu carries "Open in a new window". */
  const shell = desktopApp();
  const menuApi = createEngineApi(hostFetcher(hostId));
  const patchFromMenu = async (
    patch: { settledOverride?: "settled" | "active" | null; snoozedUntil?: number | null },
    failure: string,
  ) => {
    if (!sessionId) return;
    try {
      const next = await menuApi.updateSession(sessionId, patch);
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", failure));
    }
  };
  const headerMenu: React.ComponentProps<typeof SessionMasthead>["menu"] =
    session && sessionId
      ? {
          session: {
            id: session.id,
            title: session.title,
            ...(session.projectId ? { projectId: session.projectId } : {}),
            ...(projectName ? { projectName } : {}),
            ...(hostId === LOCAL_HOST_ID ? {} : { hostId }),
            workspacePath: session.workspace.path,
            // Only a worktree session has a branch of its own; a local one runs
            // on the project's checkout, whose HEAD belongs to no conversation.
            ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
            ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
            // The fold above, so the menu's toggle and the banner over the
            // composer cannot say different things about the same session.
            settled,
            ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
            ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
            archived: session.state === "archived",
            updatedAt: session.updatedAt,
          },
          activity: {
            working: session.activity === "working" || session.activity === "queued",
            waitingOnYou: session.activity === "blocked",
          },
          now,
          // `current` is unconditional here: this menu is only ever about the
          // session this screen is showing, so `Open` is the one verb it can
          // state and cannot perform.
          capabilities: { remote: hostId !== LOCAL_HOST_ID, readOnly: observe, current: true },
          actions: {
            // Inert on this surface (see `current`), and still handed over: the
            // handler is the definition's contract, not this screen's guess at
            // when it will be called.
            open: (href) => router.push(href),
            copyLink: (href) =>
              void navigator.clipboard.writeText(sessionLink(href)).catch(() => window.alert("The browser refused to copy that.")),
            // The desktop shell only. A browser tab supplies no handler, and the
            // item is absent rather than greyed — same call the rail makes.
            ...(shell?.openWindow ? { openWindow: (href: string) => void shell.openWindow!(href) } : {}),
            newSession: ({ projectId: target, hostId: host, baseRef }) =>
              router.push(canvasHref(target, host, baseRef ? { baseRef } : undefined)),
            pin: (pinned) =>
              void patchFromMenu({ settledOverride: pinned ? "active" : null }, "Could not change the session's pin."),
            // Un-settling reuses `unsettle` rather than restating its two-step:
            // a drift-settled session has no override to clear, and clearing
            // nothing would not stamp `updatedAt` or restart the clock.
            settle: (next) =>
              void (next ? patchFromMenu({ settledOverride: "settled" }, "Could not settle the session.") : unsettle()),
            snooze: (until) => void patchFromMenu({ snoozedUntil: until }, "Could not change the session's snooze."),
            copy: (text) => void navigator.clipboard.writeText(text).catch(() => window.alert("The browser refused to copy that.")),
            projectSettings: ({ projectId: target }) => router.push(projectSettingsHref(target)),
            remove: () => {
              const name = session.title || "Untitled session";
              // The same two presses as the rail's, word for word: the first
              // question is the one people learn to dismiss, the second states
              // the consequence that is not recoverable.
              if (!window.confirm(`Delete "${name}"?`)) return;
              if (!window.confirm(`This removes the transcript and the worktree for "${name}". It cannot be undone.`)) return;
              void menuApi
                .deleteSession(sessionId)
                // DELETING THE SESSION YOU ARE READING MUST NOT MAROON YOU ON
                // IT. A composer in the project you were just working in is
                // where you were going anyway — the same landing the rail picks.
                .then(() => router.push(canvasHref(session.projectId ?? projectId, hostId)))
                .catch((cause: unknown) =>
                  setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not delete the session.")),
                );
            },
          },
        }
      : undefined;

  // A message sent mid-turn is steered into the running turn and renders as a
  // user_message row inside it; a second copy here would double it. The brief
  // `queued` state (an idle session's next turn, claimed within a heartbeat)
  // is not worth a row either.
  // A HELD message is the exception: it is queued, but nothing is about to
  // take it, and the person has to see what a pause (or a restart) is holding
  // in order to decide about it.
  const shown = transcript.filter((turn) => (turn.state !== "queued" || turn.held) && turn.state !== "steering" && turn.state !== "steered");
  /** Whether what is on screen is this conversation's own transcript, rather
   *  than the tail of the last one or a recording of this one. A fresh canvas
   *  has nothing to read, so it is never mid-open. */
  const transcriptLanded = !sessionId || readKey === syncKey;
  /**
   * THE ANSWER A READ RECEIPT WOULD BE ABOUT — the newest turn that left a
   * result, read off the RAW turns because only they carry the sequence the
   * engine compares on (the journal fold is about rendering, and drops it).
   */
  const newestResult = useMemo(
    /**
     * GUARDED ON THE RECORD MATCHING THE ROUTE. Switching sessions without a
     * remount leaves the previous conversation's turns in hand until its
     * hydrate lands, and run ids are minted per session — so an unguarded
     * candidate could name a run id that exists in BOTH, and confirm the wrong
     * one. `session` and `turns` are replaced together by hydrate, so the id
     * agreeing is the same fact as the turns being this session's.
     */
    () => (session?.id === sessionId ? newestResultTurn(turns) : undefined),
    [session, sessionId, turns],
  );
  /**
   * The engine's answer to a receipt, folded back in.
   *
   * THREE GUARDS, EACH FOR A DIFFERENT WAY THIS ARRIVES TOO LATE:
   *
   *   - THE IDENTITY, BOTH HALVES. A receipt raised on a paired Mac's session
   *     must not land on a local session that shares its id — two engines mint
   *     ids independently, so the id alone is not one.
   *   - TWO FIELDS, NOT THE RECORD. This response was built when the receipt
   *     was sent; a tail that landed in between (a title, a new turn, a settle
   *     from another surface) must not be undone by a bookkeeping call.
   *   - MONOTONIC. A slow receipt for turn 5 can land after a fast one for
   *     turn 6, or after the tail already reported a higher mark from another
   *     device. Taking the greater of the two is the only fold that cannot go
   *     backwards — and a lower answer is dropped whole, `readAt` included,
   *     because the stamp belongs to the sequence it came with.
   */
  const onRead = useCallback(
    (identity: ReceiptIdentity, answer: ReceiptAnswer) => {
      if (identity.sessionId !== sessionId || identity.hostId !== hostId) return;
      setSession((current) => {
        if (!current || current.id !== identity.sessionId) return current;
        const next = answer.lastReadTurnSequence;
        if (next === undefined || next <= (current.lastReadTurnSequence ?? 0)) return current;
        return { ...current, lastReadTurnSequence: next, ...(answer.readAt === undefined ? {} : { readAt: answer.readAt }) };
      });
    },
    [sessionId, hostId, setSession],
  );
  const markerRefFor = useReadReceipt({
    ...(sessionId ? { sessionId } : {}),
    hostId,
    ...(newestResult ? { candidate: newestResult } : {}),
    ...(session?.lastReadTurnSequence === undefined ? {} : { readSequence: session.lastReadTurnSequence }),
    // NEVER MID-HYDRATE. What is on screen during a load is the previous
    // render, or nothing at all.
    loading,
    onRead,
  });
  /**
   * The NEWEST reported usage, not the active turn's: a running turn has no
   * figures yet, and blanking the context readout the moment work starts is
   * exactly when a person most wants to know how much room is left.
   */
  const newestUsage = [...transcript].reverse().find((turn) => turn.usage)?.usage;
  /** Background work outlives the turn that started it, so it is counted over
   *  every task rather than over the active turn's. */
  const backgroundTasks = tasks.filter((task) => isBackgroundWork(task) && (task.state === "running" || task.state === "pending")).length;

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
    /* TWO SURFACES, ONE GUTTER. The conversation and the right panel are
       separate cards on the shell's ground (`data-surfaces` is what tells
       app-shell.tsx to stop framing them as one). Same radius and gap as the
       rail, so the window reads as three islands and no edge needs a rule. */
    <main data-surfaces className="group/surfaces flex min-h-0 flex-1 overflow-hidden md:overflow-visible md:gap-2">
      {/* THE RAIL'S OWN SURFACE RECIPE — `bg-sidebar` (the wash, under
          translucency) plus a hairline ring — so the three islands match.
          NOT `app-ground`: a card must paint, or it disappears into the wash
          the way this one did. Below `md` there are no islands and the body
          is the surface.
          THE ROW DOES NOT CLIP ON `md`: a ring is a box-shadow drawn OUTSIDE
          the box, and `overflow-hidden` on this parent shaved the cards'
          outer edge — which is why this outline read thinner than the
          rail's. Each card clips its own content instead.
          A CARD WITH NO WIDTH IS NOT A CARD. "Fill the window" leaves this one
          at zero width without unmounting it (see RightPanel), and CSS scales a
          rounded box's horizontal radii to 0 that narrow — so the ring stopped
          being an outline and became a straight hairline down the full height
          of the row, right at the panel's edge. Unpaint it there; the geometry
          stays, so the panel's `-ml-2` still lands on the row's edge. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:rounded-xl md:bg-sidebar md:shadow-sm md:ring-1 md:ring-sidebar-border md:group-has-[[data-panel-fullscreen]]/surfaces:shadow-none md:group-has-[[data-panel-fullscreen]]/surfaces:ring-0">
        <SessionMasthead
          projectId={projectId}
          hostId={hostId}
          projectName={projectName}
          session={session}
          {...(headerMenu ? { menu: headerMenu } : {})}
          readOnly={observe}
          onRename={(next) => void rename(next)}
          // The masthead's Run control hands monitoring back to the panel
          // through the same opener every other surface uses.
          onWatchRun={() => showPanelTab("run")}
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
        {/* `display: contents` — a click boundary, never a layout box. */}
        <div className="contents" onClickCapture={onConversationClick}>
        <ConversationViewport className="min-w-0 flex-1" conversation={syncKey} landed={transcriptLanded} followRef={follow}>
          <ConversationContent>
            {projectId !== session?.projectId && session && (
              <Alert variant="destructive" className="mx-auto max-w-[50rem]">
                <TriangleAlertIcon />
                <AlertDescription>This URL’s project does not match the engine-owned session record.</AlertDescription>
              </Alert>
            )}
            {/* A RECORDING IS NOT A FAILURE, so it is not dressed as one: the
                conversation below is real, it is simply not being updated, and
                the destructive card would say the opposite of what the screen
                is doing. See lib/stale-state.ts for when this wins. */}
            {stale !== undefined ? (
              <Alert className="mx-auto max-w-[50rem]">
                <ClockIcon />
                <AlertTitle>Showing what was recorded at {new Date(stale).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</AlertTitle>
                <AlertDescription>The engine is not answering — reconnecting…</AlertDescription>
              </Alert>
            ) : (
              error && <SessionProblem error={error} />
            )}
            {/* A fresh canvas shows NOTHING here. The composer is lifted to the
                middle of the screen and is the whole interface; an empty-state
                card above it would be a second thing competing to be read. */}
            {!error && !fresh && shown.length === 0 && <EmptyTranscript loading={loading} />}
            {/* AN EXPLICIT CLICK, NOT A SCROLL TRIGGER. The reader asking for
                history is the only thing that should fetch it — reaching the
                top of the window to re-read something must stay free. */}
            {page?.more && (
              <div className="mx-auto w-full max-w-[50rem]">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={loadingOlder}
                  onClick={loadOlder}
                >
                  {loadingOlder ? "Loading earlier turns…" : "Load earlier turns"}
                </Button>
              </div>
            )}
            {/* WHERE THIS SESSION'S FILES ARE, so a row can tell the project's
                own work from the harness reading its bundled skills out of a
                temp directory (#354). One fact about the session, stated once,
                rather than a prop on every row that never uses it. */}
            <TranscriptWorkspace path={session?.workspace.path}>
            {shown.map((turn) => (
              /* THE END OF THIS ANSWER, when it is the newest one — the
                 position a read receipt is about. Inside the list rather than
                 after it, so a turn that started AFTER the answer (a running
                 reply the reader is watching from the bottom) cannot be
                 mistaken for having seen the answer above it, and vice versa.
                 See components/session/read-receipt.tsx. */
              <Fragment key={turn.runId}>
              <SessionTurn
                key={turn.runId}
                turn={turn}
                roster={roster}
                live={turn.runId === active?.runId}
                now={now}
                requests={openRequests.filter((request) => request.runId === turn.runId && request.id !== composerQuestion?.id)}
                sending={sending}
                onOpenAgent={showAgent}
                onOpenTab={showPanelTab}
                onInsert={insertIntoComposer}
                onOpenFile={(path) => showPanelTab(`file:${path}`)}
                onOpenFileInNewTab={openFileInNewPanelTab}
                onDecide={(requestId, decision, extra) => void decideRequest(requestId, decision, extra)}
                onRetry={(item) => void retryAmbiguous(item)}
                {...(turn.failureCode === "rate_limited" && turn.state === "failed"
                  ? { onResumeNow: () => void resumeNow(turn.runId) }
                  : {})}
              />
              {turn.runId === newestResult?.runId && <ReadReceiptMarker markerRef={markerRefFor(turn.runId)} />}
              </Fragment>
            ))}
            </TranscriptWorkspace>
          </ConversationContent>
          <ConversationScrollButton />
        </ConversationViewport>
        </div>
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
                onEnvMode: chooseEnvMode,
                pendingBase: draftBase,
                // Picking a base IS choosing a worktree: a base for the
                // shared checkout would mean switching its branch, which the
                // engine's read-only git surface refuses by construction.
                onBase: (next: { baseRef?: string; branchName?: string }) => {
                  setDraftBase(next);
                  if (next.baseRef || next.branchName) chooseEnvMode("worktree");
                },
              }
            : {})}
          busy={Boolean(active)}
          sending={sending}
          {...(session?.runtimeMode ?? (fresh ? draftRuntimeMode : undefined)
            ? { runtimeMode: session?.runtimeMode ?? draftRuntimeMode }
            : {})}
          projectId={session?.projectId ?? projectId}
          {...(projectName ? { projectName } : {})}
          {...(session ? { session } : {})}
          {...(newestUsage ? { usage: newestUsage } : {})}
          backgroundTasks={backgroundTasks}
          settled={settled}
          onUnsettle={() => void unsettle()}
          {...(session?.driver === "claude" ? { onCompact: () => void compact() } : {})}
          compacting={compacting}
          {...(composerQuestion
            ? {
                question: composerQuestion,
                onAnswerQuestion: (requestId: string, answers: Record<string, string | string[]>) =>
                  void decideRequest(requestId, "accept", { answers }),
                onCancelQuestion: (requestId: string) => void decideRequest(requestId, "cancel"),
              }
            : {})}
          onDraftChange={(nextDraft) => {
            setDraft(nextDraft);
            setDraftRunId(undefined);
          }}
          onSubmit={() => void submit()}
          onStop={() => void stop()}
          onStopBackground={() => void stopBackground()}
          // Before a session exists there is nothing to patch, so both choices
          // are held locally and applied by the one patch that follows creation.
          onRuntimeMode={fresh ? setDraftRuntimeMode : (mode) => void setRuntimeMode(mode)}
          {...(fresh ? {} : { onResumeAfterRateLimit: (next: boolean) => void setResumeAfterRateLimit(next) })}
          onModelChange={fresh ? setDraftModel : (next) => void setModel(next)}
          onOpenChanges={() => showPanelTab("diff")}
        />
        )}
      </div>
      {panelPresence.mounted && (
        <RightPanel
          open={panelPresence.shown}
          {...(active?.state ? { active: active.state } : {})}
          {...(sessionId ? { sessionId } : {})}
          {...(session?.title ? { sessionTitle: session.title } : {})}
          projectId={session?.projectId ?? projectId}
          {...(session?.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {})}
          items={items}
          tasks={roster}
          {...(focusedTask ? { focusedTask } : {})}
          {...(browserCanStart ? { onOpenBrowser: openBrowser, browserStart } : {})}
          events={events}
          tabs={panel.tabs}
          {...(panel.activeTab ? { tab: panel.activeTab } : {})}
          onTabChange={(id) => updatePanel((current) => ({ ...current, activeTab: id }))}
          onOpenTab={showPanelTab}
          onOpenNewTab={showNewPanelTab}
          onOpenFileInNewTab={openFileInNewPanelTab}
          onInsertReference={insertIntoComposer}
          onCloseTab={(id) => updatePanel((current) => closePanelTab(current, id))}
          // A surface rewriting its own instance's params — the Diff's filter
          // (#335). Through the same `updatePanel` every other tab gesture
          // writes, so the strip's label and the persisted arrangement follow.
          onTabParams={(id, params) => updatePanel((current) => setPanelTabParams(current, id, params))}
          // Persisted through the same `updatePanel` every other tab gesture
          // writes, so a reordered strip comes back reordered.
          onMoveTab={(id, toIndex) => updatePanel((current) => movePanelTab(current, id, toIndex))}
          onClose={() => updatePanel((current) => ({ ...current, open: false }))}
          editors={editors}
          onEditorChange={updateEditor}
          hostId={hostId}
          dataScience={dataScience}
          latex={latex}
        />
      )}
    </main>
  );
}
