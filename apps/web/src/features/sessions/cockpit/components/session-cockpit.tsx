"use client";

import { useNow } from "@/ui/hooks/use-now";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { WorkspaceInspector } from "@/features/sessions/components/workspace-inspector";
import { workspacePath } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { createJournalProjector, hostPassiveArrivals, isActiveTurn, isCompacting, taskRoster } from "@/platform/engine";
import { installNavigationMarks, markNavigation } from "@/platform/perf-marks";
import { projectSettingsHref } from "@/features/projects";
import { actionableRequests } from "../failed-turn-recovery";
import { canvasHref } from "../../session-list";
import { withSnooze } from "../../session-mutations";
import { sessionLink } from "../../session-link";
import { isSettled, isSnoozed, settleEndedText, settlingActivityOf, terminalsClosedHint, wakeLabel, type SettleableSession, type SettlingActivity } from "../../session-settling";
import { useInboxPolicy } from "../../inbox-policy";
import { desktopApp } from "@/platform/desktop/desktop-app";
import { hostFromPathname, hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { usePluginPanels, pluginCommands } from "@/features/plugins";
import { newestResultTurn, type ReceiptAnswer, type ReceiptIdentity } from "../session-read-receipt";
import { ReadReceiptMarker, useReadReceipt } from "./read-receipt";
import { questionFields } from "@/features/composer/question-drawer";
import { normaliseContextNoticePercent } from "@/features/composer/context-notice";
import { useProviderInstance } from "@/features/providers";
import { processToReveal, stillWorking } from "../background-presence";
import { Composer } from "@/features/composer";
import { CohortFold, foldCohortTurns } from "./cohort-fold";
import { groupNotificationTurns, TranscriptWorkspace } from "@/features/transcript";
import { issuePanelTab, pullPanelTab, RailToggle, RightPanel, type PanelTab, type TaskFocus } from "@/features/panel";
import { claimLinks, openInSystemBrowser, openLinksInSessionBrowser } from "@/platform/link-policy";
import { openUrlInSessionBrowser, parseForgeLink, sameRepository } from "../session-links";
import { SessionSchedules } from "@/features/schedules";
import { canvasPanelKey } from "@/features/panel";
import { Button } from "@/ui/button";
import { ConversationContent, ConversationScrollButton, ConversationTopEdge, ConversationViewport, type ConversationFollowHandle } from "@/ui/conversation";
import { useCommandHandlers } from "@/features/commands";
import { pinToggleOverride, transcriptRows } from "../model";
import { SessionMasthead, SessionProblem, SoloTools, usePanelPresence } from "./masthead";
import { EmptyTranscript, SessionTurn, TurnFrame } from "./session-turn";
import { useSessionSync } from "../hooks/use-session-sync";
import { useCockpitPanel } from "../hooks/use-cockpit-panel";
import { useJournalReactions } from "../hooks/use-journal-reactions";
import { useSessionBrowser } from "../hooks/use-session-browser";
import { useCockpitProject } from "../hooks/use-cockpit-project";
import { useDraftConfig } from "../hooks/use-draft-config";
import { useComposerDraft } from "../hooks/use-composer-draft";
import { useSessionActions } from "../hooks/use-session-actions";
import { useSubmit } from "../hooks/use-submit";

const api = createEngineApi();

export function SessionCockpit({
  projectId,
  sessionId: routeSessionId,
  projectName: serverProjectName,
  solo = false,
}: {
  projectId?: string;
  sessionId?: string;
  /** Resolved by the page, so the breadcrumb and the greeting never paint the
   *  raw id first and correct themselves a moment later. */
  projectName?: string;
  solo?: boolean;
}) {
  const [createdSessionId, setCreatedSessionId] = useState<string>();
  const pathname = usePathname();
  const hostId = hostFromPathname(pathname);
  // A session with no project has no canvas to be on — and `canvasHref` has no
  // URL to build for it. Never on the canvas, rather than on a canvas whose
  // address contains the word "undefined".
  const onCanvas = projectId !== undefined && pathname === canvasHref(projectId, hostId);
  const sessionId = routeSessionId ?? (onCanvas ? undefined : createdSessionId);
  /** No session yet: the composer is the whole screen and nothing is polled. */
  const fresh = !sessionId;
  const {
    session, setSession, clearTranscript, turns, items, tasks, requests, events, page, loadOlder, loadingOlder,
    error, setError, stale, loading, syncKey, transcriptLanded, hydrate,
  } = useSessionSync({ hostId, sessionId, initiallyLoading: Boolean(routeSessionId) });
  const { projectName, projectResolved, defaults: projectDefaults, enabledPlugins } = useCockpitProject({
    hostId, projectId, serverProjectName, transcriptLanded,
  });
  const draftConfig = useDraftConfig({ projectId, fresh, projectDefaults });
  const composer = useComposerDraft({ sessionId, projectId });
  /** The transcript's scroll layer, reachable from `submit`. */
  const follow = useRef<ConversationFollowHandle>(null);
  /** The reader has scrolled back through the transcript — the composer steps
   *  down to its compact shape so it covers less of what they are reading. */
  const [readingBack, setReadingBack] = useState(false);
  const onAtBottomChange = useCallback((atBottom: boolean) => setReadingBack(!atBottom), []);
  const pluginPanels = usePluginPanels(hostId, enabledPlugins);
  const [projectTranscript] = useState(createJournalProjector);

  const panelKey = sessionId ?? (projectId === undefined ? "main" : canvasPanelKey(projectId));

  const {
    panel, editors, updatePanel, updateEditor, makeRoomForPanel, showPanelTab, openFileInNewPanelTab, showNewPanelTab,
    stepPanelTab, openPanel, togglePanel, showSessionBrowser, tabHandlers,
  } = useCockpitPanel({ panelKey, enabledPlugins, hostId, sessionId });
  const panelPresence = usePanelPresence(!solo && panel.open);
  const { browser, browserCanStart, browserStart, openBrowser, browserDraftFlight, browserDraftSendPending } = useSessionBrowser({
    hostId, sessionId, projectId, transcriptLanded, events,
    draft: draftConfig.choices,
    draftText: composer.draftText, owner: composer.owner, panel, editors, setSession, setCreatedSessionId, showSessionBrowser, showPanelTab,
  });

  useCommandHandlers(
    {
      ...(solo
        ? {}
        : {
            "toggle-panel": togglePanel,
            "panel-next-tab": () => stepPanelTab(1),
            "panel-previous-tab": () => stepPanelTab(-1),
            "open-diff": () => showPanelTab("diff"),
            "open-editor": () => showPanelTab("editor"),
            ...Object.fromEntries(pluginCommands(enabledPlugins).map((command) => [command.id, () => showPanelTab(command.surface as PanelTab)])),
          }),
      "pin-session": () => {
        if (!sessionId) return;
        void patchFromMenu({ settledOverride: pinToggleOverride(session?.settledOverride) }, "Could not change the session's pin.");
      },
    },
    [solo, enabledPlugins, stepPanelTab, showPanelTab, updatePanel, makeRoomForPanel],
  );

  const projectRepo = useRef<Promise<string | undefined> | undefined>(undefined);
  const routeLink = useCallback(
    (href: string, fromConversation = true) => {
      const forge = fromConversation ? parseForgeLink(href) : undefined;
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
        openInSystemBrowser(href);
      })();
    },
    [hostId, projectId, sessionId, showPanelTab, showSessionBrowser, updatePanel],
  );
  const onConversationClick = useCallback(
    (event: React.MouseEvent) => {
      if (solo) return;
      if (!openLinksInSessionBrowser()) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement).closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      routeLink(href);
    },
    [solo, routeLink],
  );
  useEffect(() => (solo ? undefined : claimLinks((href) => routeLink(href, false))), [solo, routeLink]);

  const revealNewTerminals = useJournalReactions({ events, browser, enabledPlugins, showPanelTab, updatePanel });

  const transcript = useMemo(
    // A peer's passive report is drawn inside the turn it arrived during — see
    // `hostPassiveArrivals`.
    () => (sessionId ? hostPassiveArrivals(projectTranscript(turns, items, events, tasks)) : []),
    [sessionId, turns, items, events, tasks, projectTranscript],
  );
  const roster = useMemo(() => taskRoster(tasks, transcript.flatMap((turn) => turn.tasks)), [tasks, transcript]);
  /** Which sub-agent the panel should open on, set by pressing its chip in the
   *  transcript and cleared once the panel has scrolled to it. */
  const [focusedTask, setFocusedTask] = useState<TaskFocus>();
  const showAgent = useCallback(
    (taskId: string) => {
      // The count rises on every press, so asking for the same agent twice is
      // two requests rather than one — see `TaskFocus`.
      setFocusedTask((current) => ({ id: taskId, nonce: (current?.nonce ?? 0) + 1 }));
      showPanelTab("agents");
    },
    [showPanelTab],
  );
  /** The "N tasks still working" banner's View — see `processToReveal`. With
   *  no single process to open, a focus left by an earlier chip is dropped so
   *  the tab arrives with every row closed. */
  const showProcesses = useCallback(() => {
    const id = processToReveal(tasks);
    setFocusedTask((current) => (id ? { id, nonce: (current?.nonce ?? 0) + 1 } : undefined));
    showPanelTab("processes");
  }, [tasks, showPanelTab]);
  const active =
    transcript.find((turn) => turn.state === "claimed" || turn.state === "running") ?? transcript.find((turn) => isActiveTurn(turn.state) && !turn.held);
  /** The provider is squeezing its context right now — an open
   *  context_compaction row on the live turn. Gates the compact button so the
   *  client tells the same story the engine enforces. */
  const compacting = isCompacting(active);
  const settlingNow = useNow(30_000);

  // Only open requests on a turn that can still take the answer are actionable;
  // resolved ones are history, and one left on an ended turn has no worker
  // waiting for it (see `actionableRequests`).
  const openRequests = useMemo(() => actionableRequests(requests, transcript), [requests, transcript]);
  const composerQuestion = useMemo(
    () => openRequests.find((request) => questionFields(request).length > 0),
    [openRequests],
  );

  const actions = useSessionActions({ sessionId, session, hydrate, setSession, setError });
  const { submit, adoptConversation } = useSubmit({
    hostId, sessionId, projectId, session, composer, draft: { ...draftConfig.choices, runtimeModeTouched: draftConfig.runtimeModeTouched }, busy: Boolean(active) || compacting,
    browserDraftFlight, browserDraftSendPending, follow, canvas: { panel, editors }, compact: actions.compact, hydrate,
    setSending: actions.setSending, setSession, setError, clearTranscript, setCreatedSessionId,
  });

  const { policy: inboxPolicy } = useInboxPolicy();
  const settleable: SettleableSession | undefined = session && {
    archived: false,
    updatedAt: session.updatedAt,
    ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
    ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
    ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
    ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
    ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
    ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
    ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
  };
  const settlingActivity: SettlingActivity = settlingActivityOf(session ?? {});
  const settled = Boolean(
    session &&
      settleable &&
      session.state !== "archived" &&
      isSettled(settleable, settlingActivity, { now: settlingNow, autoSettleAfterHours: inboxPolicy.autoSettleAfterHours }),
  );
  const snoozedUntil =
    settleable && isSnoozed(settleable, settlingActivity, { now: settlingNow }) ? settleable.snoozedUntil : undefined;
  const unsettle = async () => {
    if (!sessionId) return;
    try {
      if (session?.settledOverride !== "settled") await api.updateSession(sessionId, { settledOverride: "active" });
      const next = await api.updateSession(sessionId, { settledOverride: null });
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not return the session to the list."));
    }
  };

  const router = useRouter();
  /** The desktop shell, or nothing in a browser tab — what decides whether the
   *  title menu carries "Open in a new window". */
  const shell = desktopApp();
  const menuApi = createEngineApi(hostFetcher(hostId));
  const [settleEnded, setSettleEnded] = useState<{ sessionId: string; text: string }>();
  const patchFromMenu = async (patch: { settledOverride?: "settled" | "active" | null }, failure: string) => {
    if (!sessionId) return;
    try {
      const next = await menuApi.updateSession(sessionId, patch);
      setSession(next.session);
      const ended = settleEndedText(next.ended);
      setSettleEnded(ended ? { sessionId, text: ended } : undefined);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", failure));
    }
  };
  const snoozeFromMenu = async (until: number | null) => {
    if (!sessionId || !session) return;
    const before = session;
    setSession(withSnooze(before, until));
    try {
      const next = await menuApi.updateSession(sessionId, { snoozedUntil: until });
      setSession(next.session);
      setError(undefined);
    } catch (cause) {
      // The record as it was, not as the guess left it — the rail's argument,
      // and the reason the banner springs back instead of lying.
      setSession(before);
      setError(
        cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not change the session's snooze."),
      );
    }
  };
  const [menuTerminals, setMenuTerminals] = useState<{ sessionId: string; open: number }>();
  const countMenuTerminals = () => {
    if (!sessionId) return;
    const asked = sessionId;
    // Nothing said until the host answers: a stale count is worse than none.
    setMenuTerminals(undefined);
    void menuApi
      .sessionTerminals(asked)
      .then((answer) => setMenuTerminals({ sessionId: asked, open: answer.open }))
      // An engine that predates the route, or cannot reach the host: Settle
      // simply says nothing extra.
      .catch(() => setMenuTerminals(undefined));
  };
  const openTerminals = menuTerminals && menuTerminals.sessionId === sessionId ? menuTerminals.open : 0;
  const headerMenu: React.ComponentProps<typeof SessionMasthead>["menu"] =
    session && sessionId
      ? {
          onOpen: countMenuTerminals,
          session: {
            id: session.id,
            title: session.title,
            ...(session.projectId ? { projectId: session.projectId } : {}),
            ...(projectName ? { projectName } : {}),
            ...(hostId === LOCAL_HOST_ID ? {} : { hostId }),
            ...(workspacePath(session.workspace) ? { workspacePath: workspacePath(session.workspace)! } : {}),
            // Only a worktree session has a branch of its own; a local one runs
            // on the project's checkout, whose head belongs to no conversation.
            ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
            ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
            // The fold above, so the menu's toggle and the banner over the
            // composer cannot say different things about the same session.
            settled,
            ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
            ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
            ...(openTerminals > 0 ? { terminals: openTerminals } : {}),
            archived: session.state === "archived",
            updatedAt: session.updatedAt,
          },
          activity: {
            working: session.activity === "working" || session.activity === "queued",
            waitingOnYou: session.activity === "blocked",
          },
          now: settlingNow,
          // `current` is unconditional here: this menu is only ever about the
          // session this screen is showing, so `Open` is the one verb it can
          // state and cannot perform.
          capabilities: { remote: hostId !== LOCAL_HOST_ID, current: true },
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
            closeTerminals: () =>
              void menuApi
                .closeSessionTerminals(sessionId)
                .then(() => setMenuTerminals({ sessionId, open: 0 }))
                .catch((cause: unknown) =>
                  setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not close the session's terminals.")),
                ),
            snooze: (until) => void snoozeFromMenu(until),
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
                .then(() => {
                  const home = session.projectId ?? projectId;
                  router.push(home === undefined ? "/" : canvasHref(home, hostId));
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof EngineApiError ? cause : new EngineApiError("internal_error", "Could not delete the session.")),
                );
            },
          },
        }
      : undefined;

  const { shown, hostOf } = transcriptRows(transcript);
  useEffect(() => {
    installNavigationMarks();
    markNavigation("commit", pathname);
  }, [pathname]);
  useEffect(() => {
    if (transcriptLanded) markNavigation("transcript", pathname);
  }, [transcriptLanded, pathname]);
  useEffect(() => {
    if (!loading) markNavigation("idle", pathname);
  }, [loading, pathname]);

  const newestResult = useMemo(
    () => (session?.id === sessionId ? newestResultTurn(turns) : undefined),
    [session, sessionId, turns],
  );
  // A cohort's close stays a row and the coordinator's reactions before it
  // fold. Kept as rows: a turn with a request, open or decided, and the newest
  // answer, whose read-receipt marker a closed fold would never show.
  const segments = foldCohortTurns(shown, {
    ...(active ? { activeRunId: active.runId } : {}),
    keep: new Set([...requests.map((request) => hostOf.get(request.runId) ?? request.runId), ...(newestResult ? [newestResult.runId] : [])]),
  });
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
    loading,
    onRead,
  });
  const newestUsage = [...transcript].reverse().find((turn) => turn.usage)?.usage;
  const providerInstance = useProviderInstance(session?.providerInstanceId, session?.driver);
  const contextNoticePercent = normaliseContextNoticePercent(providerInstance?.contextNoticePercent);
  /** Background work outlives the turn that started it, so it is counted over
   *  every task rather than over the active turn's. `countsAsActivity` is the
   *  rail's own predicate, so the chip and the row badge count the same tasks. */
  const backgroundTasks = stillWorking(tasks).length;

  const panelGestures = solo
    ? {}
    : {
        onOpenAgent: showAgent,
        onOpenTab: showPanelTab,
        onOpenFile: (path: string) => showPanelTab(`file:${path}`),
        onOpenFileInNewTab: openFileInNewPanelTab,
      };

  return (
    <main data-surfaces className="group/surfaces flex min-h-0 flex-1 overflow-hidden md:overflow-visible md:gap-2">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:rounded-xl md:bg-sidebar md:shadow-1 md:ring-1 md:ring-sidebar-border md:group-has-[[data-panel-fullscreen]]/surfaces:shadow-none md:group-has-[[data-panel-fullscreen]]/surfaces:ring-0">
        {solo ? (
          <SoloTools projectId={projectId} hostId={hostId} session={session} />
        ) : (
          <SessionMasthead
            projectId={projectId}
            hostId={hostId}
            projectName={projectName}
            projectResolved={projectResolved}
            session={session}
            {...(headerMenu ? { menu: headerMenu } : {})}
            onRename={(next) => void actions.rename(next)}
            onWatchRun={() => showPanelTab("terminal")}
            onRunTerminals={revealNewTerminals}
            panel={
              <>
                {/* Keyed by host and session, like Run: a different machine is a
                    different mount. The last turn's state is the refresh cue —
                    a schedule is set by a turn and fires as one. */}
                {session && (
                  <SessionSchedules
                    key={`${hostId}:${session.id}`}
                    sessionId={session.id}
                    hostId={hostId}
                    refreshKey={`${turns.at(-1)?.runId}:${turns.at(-1)?.state}`}
                  />
                )}
                {(session?.projectId ?? projectId) !== undefined && <WorkspaceInspector projectId={(session?.projectId ?? projectId)!} />}
                <RailToggle open={panel.open} onToggle={openPanel} />
              </>
            }
          />
        )}
        {/* `display: contents` — a click boundary, never a layout box. */}
        <div className="contents" onClickCapture={onConversationClick}>
        <ConversationViewport className="min-w-0 flex-1" conversation={syncKey} landed={transcriptLanded} followRef={follow} onAtBottomChange={onAtBottomChange}>
          <ConversationContent>
            {projectId !== session?.projectId && session && (
              <Alert variant="destructive" className="mx-auto max-w-[50rem]">
                <TriangleAlertIcon />
                <AlertDescription>This URL’s project does not match the engine-owned session record.</AlertDescription>
              </Alert>
            )}
            {stale !== undefined ? (
              <Alert className="mx-auto max-w-[50rem]">
                <ClockIcon />
                <AlertTitle>Showing what was recorded at {new Date(stale).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</AlertTitle>
                <AlertDescription>The engine is not answering — reconnecting…</AlertDescription>
              </Alert>
            ) : (
              error && <SessionProblem error={error} />
            )}
            {/* A fresh canvas shows nothing here. The composer is lifted to the
                middle of the screen and is the whole interface; an empty-state
                card above it would be a second thing competing to be read. */}
            {!error && !fresh && shown.length === 0 && <EmptyTranscript loading={loading} />}
            <ConversationTopEdge more={Boolean(page?.more)} loading={loadingOlder} onReach={loadOlder}>
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
            </ConversationTopEdge>
            <TranscriptWorkspace path={session ? workspacePath(session.workspace) : undefined}>
            {segments.map((segment) => {
              const rows = groupNotificationTurns(segment.turns, active?.runId).map((group) => {
              const turns = group.map((turn) => (
              <Fragment key={turn.runId}>
              <TurnFrame skippable={turn.runId !== active?.runId}>
              <SessionTurn
                turn={turn}
                roster={roster}
                live={turn.runId === active?.runId}
                requests={openRequests.filter((request) => (hostOf.get(request.runId) ?? request.runId) === turn.runId && request.id !== composerQuestion?.id)}
                sending={actions.sending}
                onInsert={composer.insertIntoComposer}
                {...panelGestures}
                onDecide={(requestId, decision, extra) => void actions.decideRequest(requestId, decision, extra)}
                onRetry={(item) => void actions.retryAmbiguous(item)}
                {...(turn.failureCode === "rate_limited" && turn.state === "failed"
                  ? { onResumeNow: () => void actions.resumeNow(turn.runId) }
                  : {})}
              />
              </TurnFrame>
              {turn.runId === newestResult?.runId && <ReadReceiptMarker markerRef={markerRefFor(turn.runId)} />}
              </Fragment>
              ));
              return group.length === 1 ? (
                <Fragment key={group[0]!.runId}>{turns}</Fragment>
              ) : (
                <div key={group[0]!.runId} className="flex flex-col gap-0.5" data-notification-strip={group.length}>
                  {turns}
                </div>
              );
              });
              return segment.kind === "fold" ? (
                <CohortFold key={segment.turns[0]!.runId} turns={segment.turns} members={segment.members}>
                  {rows}
                </CohortFold>
              ) : (
                <Fragment key={segment.turns[0]!.runId}>{rows}</Fragment>
              );
            })}
            </TranscriptWorkspace>
          </ConversationContent>
          <ConversationScrollButton />
        </ConversationViewport>
        </div>
        <Composer
          draft={composer.draft}
          // A fresh canvas is ready: there is nothing to wait for, because the
          // message you type is the thing that creates the session.
          ready={fresh || Boolean(session)}
          // Not while a conversation is opening: its placement is still moving
          // the viewport, and a composer changing height under it would move it
          // again.
          compact={readingBack && transcriptLanded}
          attachments={composer.attachments}
          onAttach={composer.setAttachments}
          fresh={fresh}
          {...(fresh
            ? {
                driver: draftConfig.driver,
                onDriverChange: draftConfig.chooseDriver,
                pendingModel: draftConfig.model,
                envMode: draftConfig.envMode,
                onEnvMode: draftConfig.chooseEnvMode,
                pendingBase: draftConfig.base,
                onBase: draftConfig.chooseBase,
                ...(draftConfig.driver === "claude" ? { onAdopt: adoptConversation } : {}),
              }
            : {})}
          busy={Boolean(active)}
          sending={actions.sending}
          {...(session?.runtimeMode ?? (fresh ? draftConfig.runtimeMode : undefined)
            ? { runtimeMode: session?.runtimeMode ?? draftConfig.runtimeMode }
            : {})}
          projectId={session?.projectId ?? projectId}
          {...(projectName ? { projectName } : {})}
          {...(session ? { session } : {})}
          {...(newestUsage ? { usage: newestUsage } : {})}
          backgroundTasks={backgroundTasks}
          settled={settled}
          {...(settled && settleEnded && settleEnded.sessionId === sessionId
            ? { settledEnded: settleEnded.text }
            : settled && session && terminalsClosedHint(session)
              ?
                { settledEnded: `${terminalsClosedHint(session)}.` }
              : {})}
          onUnsettle={() => void unsettle()}
          {...(snoozedUntil === undefined
            ? {}
            :
              { snoozeWakeIn: wakeLabel(snoozedUntil, settlingNow) })}
          onWake={() => void snoozeFromMenu(null)}
          {...(session?.driver === "claude" ? { onCompact: () => void actions.compact() } : {})}
          compacting={compacting}
          contextNoticePercent={contextNoticePercent}
          {...(composerQuestion
            ? {
                question: composerQuestion,
                onAnswerQuestion: (requestId: string, answers: Record<string, string | string[]>) =>
                  void actions.decideRequest(requestId, "accept", { answers }),
                onCancelQuestion: (requestId: string) => void actions.decideRequest(requestId, "cancel"),
              }
            : {})}
          onDraftChange={composer.changeDraft}
          onSubmit={() => void submit()}
          onStop={() => void actions.stop()}
          onStopBackground={() => void actions.stopBackground()}
          {...(solo ? {} : { onViewBackground: showProcesses })}
          // Before a session exists there is nothing to patch, so both choices
          // are held locally and applied by the one patch that follows creation.
          onRuntimeMode={
            fresh
              ? draftConfig.chooseRuntimeMode
              : (mode) => void actions.setRuntimeMode(mode)
          }
          {...(fresh ? {} : { onResumeAfterRateLimit: (next: boolean) => void actions.setResumeAfterRateLimit(next) })}
          {...(draftConfig.sessionDefaults.resumeAfterRateLimit === undefined ? {} : { resumeAfterRateLimitDefault: draftConfig.sessionDefaults.resumeAfterRateLimit })}
          onModelChange={fresh ? draftConfig.chooseModel : (next) => void actions.setModel(next)}
          // The composer's foot links its change count to the Diff surface —
          // a right-panel tab, so on the solo route the count stays a count
          // rather than becoming a link to nowhere.
          {...(solo ? {} : { onOpenChanges: () => showPanelTab("diff") })}
        />
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
          turns={turns}
          tasks={roster}
          {...(focusedTask ? { focusedTask } : {})}
          {...(browserCanStart ? { onOpenBrowser: openBrowser, browserStart } : {})}
          events={events}
          tabs={panel.tabs}
          {...(panel.activeTab ? { tab: panel.activeTab } : {})}
          {...tabHandlers}
          onOpenTab={showPanelTab}
          onOpenNewTab={showNewPanelTab}
          onOpenFileInNewTab={openFileInNewPanelTab}
          onInsertReference={composer.insertIntoComposer}
          onAttach={composer.attachFromPanel}
          editors={editors}
          onEditorChange={updateEditor}
          hostId={hostId}
          enabledPlugins={enabledPlugins}
          pluginPanels={pluginPanels}
        />
      )}
    </main>
  );
}
