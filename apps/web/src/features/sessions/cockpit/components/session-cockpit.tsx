"use client";

import { useNow } from "@/ui/hooks/use-now";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WorkspaceInspector } from "@/components/session/workspace-inspector";
import {
  type EngineEvent,
  type ClaudeConversation,
  type EngineRequest,
  type RequestDecision,
  type Item,
  type ProviderDriverKind,
  type RuntimeMode,
  type Session,
  type SessionSnapshot,
  type SnapshotPage,
  type Task,
  type Turn,
  type TurnModelSelection,
  seedSessionTitle,
  turnHasContent,
  workspacePath,
} from "@telar/engine-client";
import { announcePromptShelfChanged, splitImages } from "@/features/prompts";
import { createEngineApi, newRunId, retryAmbiguousTurn, EngineApiError } from "@/platform/engine";
import { createJournalProjector, hostPassiveArrivals, isActiveTurn, isCompacting, projectJournal, taskRoster } from "@/platform/engine";
import { isCompactDraft, readDraft, rememberedProjectName, writeDraft, writeFrontDoorNote } from "@/features/composer";
import { installNavigationMarks, markNavigation } from "@/lib/perf-marks";
import { projectSettingsHref } from "@/features/projects";
import { actionableRequests } from "../failed-turn-recovery";
import { canvasHref, sessionHref } from "../../session-list";
import { newSessionId, withSnooze } from "../../session-mutations";
import { sessionLink } from "../../session-link";
import { isSettled, isSnoozed, settleEndedText, settlingActivityOf, terminalsClosedHint, wakeLabel, type SettleableSession, type SettlingActivity } from "../../session-settling";
import { useInboxPolicy } from "../../inbox-policy";
import { useSessionDefaults } from "../../session-defaults";
import { LOCAL_HOST, saveSnapshot, snapshotKey, snapshotStore } from "../../snapshot-cache";
import { desktopApp } from "@/lib/desktop-app";
import { hostFromPathname, hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { usePluginPanels, pluginCommands } from "@/features/plugins";
import { newestResultTurn, type ReceiptAnswer, type ReceiptIdentity } from "../session-read-receipt";
import { ReadReceiptMarker, useReadReceipt } from "./read-receipt";
import { questionFields } from "@/lib/question-drawer";
import { normaliseContextNoticePercent } from "@/lib/context-notice";
import { choiceNamesAnything, choiceOf, projectDraftModel, sessionModelSelection, type ModelChoice, useProviderInstance } from "@/features/providers";
import { sessionConnection } from "@/platform/engine";
import { INITIAL_TURNS, loadOlderTurns, mergeRows, tailIntervalMs } from "@/platform/engine";
import { recallTranscript, rememberTranscript, transcriptKey } from "../transcript-cache";
import { decideStale } from "../stale-state";
import { processToReveal, stillWorking } from "../background-presence";
import { Composer, MAX_ATTACHMENTS } from "@/features/composer";
import { CohortFold, foldCohortTurns } from "./cohort-fold";
import { groupNotificationTurns, TranscriptWorkspace } from "@/features/transcript";
import { agentBrowserActivity, browserPanelTab, browserScopeToRelease, browserTabId, describeBrowserStart, editorInstanceKey, filePanelTabPath, issuePanelNumber, issuePanelTab, latestBrowserState, LIVE_BROWSER_TAB, isRestorablePanelTab, panelTabForPath, pullPanelNumber, pullPanelTab, RailToggle, RightPanel, type BrowserStartState, type PanelTab, type TaskFocus } from "@/features/panel";
import { desktopBrowserBridge } from "@/lib/desktop-browser-bridge";
import { claimLinks, openInSystemBrowser, openLinksInSessionBrowser } from "@/lib/link-policy";
import { openUrlInSessionBrowser, parseForgeLink, sameRepository } from "../session-links";
import { SessionSchedules } from "@/features/schedules";
import {
  activePanelTab,
  addPanelTab,
  canvasPanelKey,
  closePanelTab,
  collapsePanelTabs,
  emptyPanelTabs,
  findPanelTab,
  movePanelTab,
  nextPanelTabId,
  openNewPanelTab,
  openPanelTab,
  readPanelTabs,
  revealPanelTab,
  setPanelTabParams,
  writePanelTabs,
  clearPanelTabs,
  type PanelTabParams,
  type PanelTabState,
} from "@/features/panel";
import { closeTerminalTab, createRunApi, foldTerminalParams, freshTerminals, revealTerminal, type RunView } from "@/features/terminal";
import {
  editorFileForPath,
  emptyEditor,
  openInEditor,
  readEditor,
  writeEditor,
  clearEditor,
  type EditorState,
  type OpenIntent,
} from "@/features/files";
import { forgeParams, openForge, readForgeOpen } from "@/features/github";
import { Button } from "@/components/ui/button";
import { ConversationContent, ConversationScrollButton, ConversationTopEdge, ConversationViewport, type ConversationFollowHandle } from "@/components/ui/conversation";
import { useSidebar } from "@/components/ui/sidebar";
import { useCommandHandlers } from "@/features/commands";
import { appendToDraft, cockpitPlugins, pinToggleOverride, transcriptRows } from "../model";
import { SessionMasthead, SessionProblem, SoloTools, usePanelPresence } from "./masthead";
import { EmptyTranscript, SessionTurn, TurnFrame } from "./session-turn";

const api = createEngineApi();
/** Below this the session rail, the conversation and the panel cannot all
 *  hold their minimum widths at once. Chosen as rail (16rem) + conversation
 *  floor (24rem) + panel floor (20rem), rounded up. */
const NARROW_WINDOW = 1280;

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
  const [draftDriver, setDraftDriver] = useState<ProviderDriverKind>("claude");
  const [draftEnvMode, setDraftEnvMode] = useState<"local" | "worktree">("local");
  const [envModeTouched, setEnvModeTouched] = useState(false);
  const { defaults: sessionDefaults, loading: sessionDefaultsLoading } = useSessionDefaults();
  const [seededEnvMode, setSeededEnvMode] = useState<"local" | "worktree">();
  /** The project's own answer, once its record arrives. Absent means it follows the Mac. */
  const [projectEnvMode, setProjectEnvMode] = useState<{ projectId: string; envMode?: "local" | "worktree" }>();
  const projectAnswered = projectId === undefined || projectEnvMode?.projectId === projectId;
  const envModeSeed = (projectId !== undefined ? projectEnvMode?.envMode : undefined) ?? sessionDefaults.envMode;
  // A render-phase adjustment, not an effect — this app's lint enforces that
  // for "adjust state when a value changes", and the value here is the
  // engine's answer arriving.
  if (!sessionDefaultsLoading && projectAnswered && !envModeTouched && seededEnvMode !== envModeSeed) {
    setSeededEnvMode(envModeSeed);
    setDraftEnvMode(envModeSeed);
  }
  /** every human pick goes through here, so the seed above can never overwrite
   *  one — including the implicit pick of choosing a base ref. */
  const chooseEnvMode = useCallback((next: "local" | "worktree") => {
    setEnvModeTouched(true);
    setDraftEnvMode(next);
  }, []);
  /** The base-ref picker's create-time choice: what a worktree is cut from,
   *  and optionally the human's own name for its branch. Only meaningful with
   *  `envMode: "worktree"` — picking a base is what flips the mode there. */
  const [draftBase, setDraftBase] = useState<{ baseRef?: string; branchName?: string }>({});
  const searchParams = useSearchParams();
  const requestedBase = fresh ? (searchParams.get("base") ?? undefined) : undefined;
  const [seededBase, setSeededBase] = useState<string>();
  if (requestedBase !== undefined && seededBase !== requestedBase) {
    setSeededBase(requestedBase);
    setDraftBase({ baseRef: requestedBase });
    chooseEnvMode("worktree");
  }
  const [draftRuntimeMode, setDraftRuntimeMode] = useState<RuntimeMode>("auto");
  const [runtimeModeTouched, setRuntimeModeTouched] = useState(false);
  const runtimeModeSeed = sessionDefaults.runtimeMode ?? "auto";
  if (!sessionDefaultsLoading && !runtimeModeTouched && draftRuntimeMode !== runtimeModeSeed) setDraftRuntimeMode(runtimeModeSeed);
  const [draftModel, setDraftModel] = useState<ModelChoice>({});
  const [modelTouched, setModelTouched] = useState(false);
  const [projectModel, setProjectModel] = useState<{ projectId: string; seed: ReturnType<typeof projectDraftModel> }>();
  const [seededModelFor, setSeededModelFor] = useState<string>();
  // Render-phase, like the envMode seed above. Keyed by project, so a canvas
  // that moves to another project starts from that project's default.
  if (!sessionId && !modelTouched && projectModel && projectModel.projectId === projectId && seededModelFor !== projectId) {
    setSeededModelFor(projectId);
    if (projectModel.seed) {
      setDraftDriver(projectModel.seed.driver);
      setDraftModel(projectModel.seed.choice);
    }
  }
  /** every human pick of a model knob goes through here, so the seed can never
   *  overwrite one. Each control sends the whole choice, so changing one knob
   *  keeps the rest of the project's default. */
  const chooseDraftModel = useCallback((next: ModelChoice) => {
    setModelTouched(true);
    setDraftModel(next);
  }, []);
  const draftPick: ModelChoice = modelTouched ? draftModel : {};
  const chooseDriver = useCallback((next: ProviderDriverKind) => {
    setModelTouched(true);
    setDraftDriver(next);
    setDraftModel({});
  }, [setDraftModel]);
  const [sessionRecord, setSession] = useState<Session>();
  const session = sessionId ? sessionRecord : undefined;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
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
  const [readKey, setReadKey] = useState<string>();
  /** The transcript's scroll layer, reachable from `submit`. */
  const follow = useRef<ConversationFollowHandle>(null);
  /** The reader has scrolled back through the transcript — the composer steps
   *  down to its compact shape so it covers less of what they are reading. */
  const [readingBack, setReadingBack] = useState(false);
  const onAtBottomChange = useCallback((atBottom: boolean) => setReadingBack(!atBottom), []);
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState<PanelTabState<PanelTab>>(() => emptyPanelTabs<PanelTab>());
  const panelNow = useRef(panel);
  const [editors, setEditors] = useState<Record<string, EditorState>>(() => ({}));
  const panelPresence = usePanelPresence(!solo && panel.open);
  const [projectName, setProjectName] = useState<string | undefined>(serverProjectName);
  const [projectResolved, setProjectResolved] = useState(false);
  const nameKey = JSON.stringify([hostId, projectId]);
  const [nameSubject, setNameSubject] = useState(nameKey);
  if (nameSubject !== nameKey) {
    setNameSubject(nameKey);
    setProjectName(undefined);
    setProjectResolved(false);
  }
  /** The project's enabled plugin ids, read with its name. None until known. */
  const [enabledPlugins, setEnabledPlugins] = useState<readonly string[]>([]);
  const pluginPanels = usePluginPanels(hostId, enabledPlugins);
  const [projectTranscript] = useState(createJournalProjector);
  const cursor = useRef(0);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const syncKey = JSON.stringify([hostId ?? LOCAL_HOST, sessionId]);
  const syncSession = useRef(syncKey);
  const syncGeneration = useRef(0);
  const tailInFlight = useRef(false);
  const transcriptLanded = !sessionId || readKey === syncKey;

  const [transcriptSubject, setTranscriptSubject] = useState(syncKey);
  if (transcriptSubject !== syncKey) {
    setTranscriptSubject(syncKey);
    const recalled = sessionId ? recallTranscript(transcriptKey(hostId ?? LOCAL_HOST, sessionId)) : undefined;
    if (recalled) {
      setSession(recalled.session);
      setTurns(recalled.turns);
      setItems(recalled.items);
      setTasks(recalled.tasks);
      setRequests(recalled.requests);
      setEvents(recalled.events);
      setPage(recalled.page);
      setReadKey(syncKey);
    }
  }

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
  /** What the last recording was made of — identities, not contents, so a tail
   *  that changed nothing can be recognised and skipped. See `remember`. */
  const photographed = useRef<{
    id: string;
    session: unknown;
    turns: unknown;
    items: unknown;
    tasks: unknown;
    requests: unknown;
    events: unknown;
  }>(undefined);
  /** …and the snapshot the next outage will show. Written from the freshly
   *  fetched values rather than from state, which has not committed yet. */
  const remember = useCallback((id: string, snapshot: SessionSnapshot & { events?: EngineEvent[] }) => {
    live();
    rememberTranscript(transcriptKey(hostId ?? LOCAL_HOST, id), {
      ...snapshot,
      events: snapshot.events ?? [],
      cursor: snapshot.cursor ?? 0,
    });
    const store = snapshotStore();
    if (!store) return;
    const held = photographed.current;
    if (
      held &&
      held.id === id &&
      held.session === snapshot.session &&
      held.turns === snapshot.turns &&
      held.items === snapshot.items &&
      held.tasks === snapshot.tasks &&
      held.requests === snapshot.requests &&
      held.events === snapshot.events
    ) {
      return;
    }
    photographed.current = {
      id,
      session: snapshot.session,
      turns: snapshot.turns,
      items: snapshot.items,
      tasks: snapshot.tasks,
      requests: snapshot.requests,
      events: snapshot.events,
    };
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
        const hydrated = await sessionConnection(hostId ?? LOCAL_HOST, createEngineApi(hostFetcher(hostId)), sessionId, { turns: INITIAL_TURNS }).read();
        if (generation !== syncGeneration.current || syncSession.current !== syncKey) return;
        setSession(hydrated.session);
        setTurns(hydrated.turns);
        setItems(hydrated.items);
        setTasks(hydrated.tasks);
        setRequests(hydrated.requests);
        setEvents(hydrated.events);
        setPage(hydrated.page);
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

  const panelKey = sessionId ?? (projectId === undefined ? "main" : canvasPanelKey(projectId));

  useEffect(() => {
    // Deferred to a task rather than called in the effect body: a synchronous
    // setState there is a cascading render, and it is the same rule the git
    // readout in workspace-environment.tsx follows.
    const task = window.setTimeout(() => {
      const stored = readEditor(panelKey);
      const restored = readPanelTabs<PanelTab>(panelKey, isRestorablePanelTab);
      const browsers = desktopBrowserBridge() ? collapsePanelTabs(restored, (tab) => browserTabId(tab) !== undefined, LIVE_BROWSER_TAB) : restored;
      const next = collapsePanelTabs(browsers, (tab) => tab === "terminal", "terminal", foldTerminalParams);
      const loaded: Record<string, EditorState> = { editor: stored };
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

  const [browserCanStart, setBrowserCanStart] = useState(false);
  useEffect(() => {
    if (!transcriptLanded) return;
    let cancelled = false;
    // Deferred to a task, same rule as the panel restore above: a synchronous
    // setState in an effect body is a cascading render.
    const task = window.setTimeout(() => {
      setBrowserCanStart(false);
      if (!sessionId) {
        setBrowserCanStart(Boolean(projectId && (hostId !== LOCAL_HOST_ID || desktopBrowserBridge())));
        return;
      }
      createEngineApi(hostFetcher(hostId)).browserState(sessionId).then(
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
  }, [sessionId, projectId, hostId, transcriptLanded]);

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

  const editorTargetId = useCallback((state: PanelTabState<PanelTab>) => {
    const active = activePanelTab(state);
    if (active?.kind === "editor") return active.id;
    return state.tabs.find((entry) => entry.kind === "editor")?.id ?? nextPanelTabId(state, "editor");
  }, []);

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

  const showPanelTab = useCallback(
    (tab: PanelTab, intent: OpenIntent = "pin") => {
      makeRoomForPanel();
      const path = filePanelTabPath(tab);
      if (path !== undefined) {
        // Resolved from the committed strip, and handed to both updates, so the
        // file and the tab that comes forward cannot name different Editors.
        const target = editorTargetId(panelNow.current);
        updateEditor(target, (current) => openInEditor(current, editorFileForPath(path, enabledPlugins), intent));
        updatePanel((current) => openPanelTab(current, "editor"));
        return;
      }
      const issue = issuePanelNumber(tab);
      const pull = issue === undefined ? pullPanelNumber(tab) : undefined;
      if (issue !== undefined || pull !== undefined) {
        const kind = issue !== undefined ? "issues" : "pulls";
        const number = (issue ?? pull)!;
        updatePanel((current) => {
          const opened = openPanelTab(current, kind);
          const target = activePanelTab(opened);
          if (!target) return opened;
          return setPanelTabParams(opened, target.id, forgeParams(openForge(readForgeOpen(target.params), number)));
        });
        return;
      }
      updatePanel((current) => openPanelTab(current, tab));
    },
    [makeRoomForPanel, updatePanel, updateEditor, editorTargetId, enabledPlugins],
  );

  const openFileInNewPanelTab = useCallback(
    (path: string) => {
      makeRoomForPanel();
      // Minted from the committed strip so the files can be seeded under the
      // same id the tab is about to take.
      const id = nextPanelTabId(panelNow.current, "editor");
      updateEditor(id, (current) => openInEditor(current, editorFileForPath(path, enabledPlugins), "pin"));
      updatePanel((current) => addPanelTab(current, { id, kind: "editor", params: { path } }));
    },
    [makeRoomForPanel, updatePanel, updateEditor, enabledPlugins],
  );

  const showNewPanelTab = useCallback(
    (tab: PanelTab, params?: PanelTabParams) => {
      makeRoomForPanel();
      updatePanel((current) => openNewPanelTab(current, tab, params));
    },
    [makeRoomForPanel, updatePanel],
  );

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
      ...(solo
        ? {}
        : {
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
            ...Object.fromEntries(pluginCommands(enabledPlugins).map((command) => [command.id, () => showPanelTab(command.surface as PanelTab)])),
          }),
      "pin-session": () => {
        if (!sessionId) return;
        void patchFromMenu({ settledOverride: pinToggleOverride(session?.settledOverride) }, "Could not change the session's pin.");
      },
    },
    [solo, enabledPlugins, stepPanelTab, showPanelTab, updatePanel, makeRoomForPanel],
  );

  const showSessionBrowser = useCallback(() => {
    makeRoomForPanel();
    updatePanel((current) => addPanelTab(current, { id: LIVE_BROWSER_TAB, kind: LIVE_BROWSER_TAB, params: {} }));
  }, [makeRoomForPanel, updatePanel]);

  // Appended rather than spliced: the caret lives inside ComposerEditor, out of reach here.
  const insertIntoComposer = useCallback((text: string) => {
    if (!text) return;
    setDraft((current) => appendToDraft(current, text));
    // A draft that came back from a turn stops being that turn's recall the
    // moment anything is added to it — the same rule `onDraftChange` follows.
    setDraftRunId(undefined);
  }, [setDraft, setDraftRunId]);

  const attachFromPanel = useCallback((files: readonly File[], caption?: string) => {
    if (files.length > 0) setAttachments((current) => [...current, ...files].slice(0, MAX_ATTACHMENTS));
    if (caption) insertIntoComposer(caption);
  }, [setAttachments, insertIntoComposer]);

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

  const seenPages = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (desktopBrowserBridge()) return;
    const pages = browser?.tabs ?? [];
    const fresh = pages.filter((page) => !seenPages.current.has(page.id));
    for (const page of pages) seenPages.current.add(page.id);
    if (fresh.length === 0) return;
    updatePanel((current) => {
      if (!current.open) return current;
      return fresh.reduce((state, page) => openPanelTab(state, browserPanelTab(page.id)), current);
    });
  }, [browser, updatePanel]);

  const browserEventsThrough = useRef(0);
  const browserMountedAt = useRef(0);
  useEffect(() => {
    if (!desktopBrowserBridge()) return;
    if (browserMountedAt.current === 0) browserMountedAt.current = Date.now();
    const { acted, through } = agentBrowserActivity(events, browserMountedAt.current, browserEventsThrough.current);
    browserEventsThrough.current = through;
    if (!acted) return;
    updatePanel((current) => revealPanelTab(current, { id: LIVE_BROWSER_TAB, kind: LIVE_BROWSER_TAB, params: {} }));
  }, [events, updatePanel]);

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
    showPanelTab(panelTabForPath(last.path, enabledPlugins));
  }, [events, enabledPlugins, showPanelTab]);

  const seenTerminals = useRef<Set<string>>(new Set());
  const revealNewTerminals = useCallback(
    (terminals: readonly RunView[]) => {
      if (mountedAt.current === 0) mountedAt.current = Date.now();
      const fresh = freshTerminals(terminals, mountedAt.current, seenTerminals.current);
      for (const run of terminals) seenTerminals.current.add(run.terminalId);
      if (fresh.length === 0) return;
      updatePanel((current) => fresh.reduce((state, run) => revealTerminal(state, run, "terminal"), current));
    },
    [updatePanel],
  );

  const seenDrafts = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (mountedAt.current === 0) mountedAt.current = Date.now();
    const fresh = events.filter(
      (event) => event.type === "prompt.drafted" && event.at >= mountedAt.current && !seenDrafts.current.has(event.id),
    );
    if (fresh.length === 0) return;
    for (const event of fresh) seenDrafts.current.add(event.id);
    announcePromptShelfChanged();
  }, [events]);

  const owner = useRef<{ sessionId: string | undefined; projectId: string | undefined }>({ sessionId, projectId });
  /** The live text, readable from an effect that must not re-run per keystroke. */
  const draftText = useRef(draft);
  const [browserStart, setBrowserStart] = useState<BrowserStartState>({ status: "idle" });
  const browserOpening = useRef(false);
  const browserDraftIdentity = useRef<{ path: string; id: string } | null>(null);
  const browserDraftFlight = useRef<Promise<string> | null>(null);
  const browserDraftSendPending = useRef(false);

  async function ensureBrowserDraft(): Promise<string> {
    if (sessionId) return sessionId;
    // A draft is a session waiting to be created IN A project. There is no such
    // thing without one, and `/main` never reaches here: it always has a
    // session already.
    if (projectId === undefined) throw new EngineApiError("invalid_request", "This conversation has no project to open a draft in.");
    if (browserDraftFlight.current) return browserDraftFlight.current;
    const origin = window.location.pathname;
    if (browserDraftIdentity.current?.path !== origin) {
      browserDraftIdentity.current = { path: origin, id: newSessionId() };
    }
    const id = browserDraftIdentity.current.id;
    // Keep both requests on the originating host if navigation changes mid-flight.
    const draftApi = createEngineApi(hostFetcher(hostId));
    const flight = (async () => {
      const created = await draftApi.createSession(projectId, {
        id, draft: true, title: "Browser draft", driver: draftDriver, envMode: draftEnvMode,
        ...(draftEnvMode === "worktree" ? draftBase : {}),
      });
      const model = sessionModelSelection(created.session.providerInstanceId, draftPick);
      const patched = await draftApi.updateSession(id, {
        runtimeMode: draftRuntimeMode,
        ...(model ? { model } : {}),
      });
      // Keep the durable draft, but never navigate over a different conversation.
      if (window.location.pathname !== origin) return id;
      writeDraft(id, projectId, draftText.current);
      writeDraft(undefined, projectId, "");
      writePanelTabs(id, panel, Date.now());
      // …and the files open in each Editor with them: the arrangement a person
      // built while writing the first message is the arrangement they want
      // while it runs.
      for (const [instance, state] of Object.entries(editors)) writeEditor(editorInstanceKey(id, instance), state, Date.now());
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

  async function adoptConversation(conversation: ClaudeConversation): Promise<void> {
    if (projectId === undefined) {
      throw new EngineApiError("invalid_request", "This conversation has no project to create a session in.");
    }
    if (sessionId) {
      // The engine refuses this too; saying it here means the person is told
      // before a session is created rather than after.
      throw new EngineApiError("conflict", "This conversation has already started. Open a new one to bring in another.");
    }
    const id = newSessionId();
    const canvas = window.location.pathname;
    const title = (conversation.customTitle || conversation.firstPrompt || conversation.title || "Claude Code conversation")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    const adoptApi = createEngineApi(hostFetcher(hostId));
    window.history.replaceState(null, "", sessionHref({ id, projectId, hostId }));
    let target: string;
    try {
      const created = await adoptApi.createSession(projectId, {
        id,
        title,
        driver: "claude",
        envMode: draftEnvMode,
        ...(draftEnvMode === "worktree" && draftBase.baseRef ? { baseRef: draftBase.baseRef } : {}),
        ...(draftEnvMode === "worktree" && draftBase.branchName ? { branchName: draftBase.branchName } : {}),
      });
      target = created.session.id;
      if (target !== id) window.history.replaceState(null, "", sessionHref({ id: target, projectId, hostId }));
      const adopted = await adoptApi.adoptClaudeConversation(target, conversation.sessionId);
      setSession(adopted.session);
    } catch (cause: unknown) {
      window.history.replaceState(null, "", canvas);
      throw cause;
    }
    writePanelTabs(target, panel, Date.now());
    for (const [instance, state] of Object.entries(editors)) writeEditor(editorInstanceKey(target, instance), state, Date.now());
    setTurns([]);
    setItems([]);
    setTasks([]);
    setRequests([]);
    setEvents([]);
    owner.current = { sessionId: target, projectId };
    setCreatedSessionId(target);
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
        writeDraft(leaving.sessionId, leaving.projectId, draftText.current);
        // authoritative, unlike the fallback below: a different composer's text
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
    if (!transcriptLanded) return;
    let cancelled = false;
    const local = hostId === LOCAL_HOST_ID;
    let answered = false;
    const task = window.setTimeout(() => {
      if (cancelled || answered || !local) return;
      const remembered = projectId === undefined ? undefined : rememberedProjectName(projectId);
      if (remembered) setProjectName(remembered);
    }, 0);
    void createEngineApi(hostFetcher(hostId)).projects().then(
      (result) => {
        if (cancelled) return;
        answered = true;
        const found = result.projects.find((project) => project.id === projectId);
        setProjectName(found?.name);
        // answered, whether or not it held the project — which is the difference
        // between "the name has not arrived" and "this project is not on this
        // Mac", and only the second is worth saying out loud.
        setProjectResolved(true);
        // Where a new conversation's composer starts; see `draftModel`.
        if (projectId !== undefined) {
          setProjectModel({ projectId, seed: projectDraftModel(found?.defaultModel) });
          setProjectEnvMode({ projectId, ...(found?.envMode ? { envMode: found.envMode } : {}) });
        }
        // Replaced only when the set changed, so everything keyed on it keeps
        // its identity across a refetch that found the same plugins.
        const plugins = cockpitPlugins(found);
        setEnabledPlugins((current) => (current.join(",") === plugins.join(",") ? current : plugins));
        if (local) writeFrontDoorNote(result.projects, projectId);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [projectId, hostId, transcriptLanded]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    // Another session's liveness says nothing about this one.
    lastLiveAt.current = undefined;
    staleAt.current = undefined;
    void snapshotStore()
      ?.read(snapshotKey(hostId ?? LOCAL_HOST, sessionId))
      .then((cached) => {
        if (!cached || cancelled || lastLiveAt.current !== undefined) return;
        if (recallTranscript(transcriptKey(hostId ?? LOCAL_HOST, sessionId))) return;
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
          setReadKey(syncKey);
        },
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [hydrate, sessionId, hostId, fail, syncKey]);

  const tailMs = tailIntervalMs(turns);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void tail().catch((cause) => !cancelled && fail(cause, "Could not tail the session journal."));
    }, tailMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [tail, sessionId, fail, tailMs]);

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
    if (!turnHasContent(draft, attachments.map((file) => file.type)) || browserDraftSendPending.current) return;
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
    follow.current?.toBottom();
    // Cleared optimistically and before the round trip: the box emptying is the
    // acknowledgement, and waiting on the network to give it back is the thing
    // that makes queueing feel like a form submission.
    const text = draft.trim();
    const files = attachments;
    setDraft("");
    writeDraft(sessionId ?? browserTarget, projectId, "");
    setDraftRunId(undefined);
    setAttachments([]);
    try {
      let target = sessionId ?? browserTarget;
      if (!target) {
        if (projectId === undefined) {
          setError(new EngineApiError("invalid_request", "This conversation has no project to create a session in."));
          return;
        }
        const id = newSessionId();
        const canvas = window.location.pathname;
        window.history.replaceState(null, "", sessionHref({ id, projectId, hostId }));
        const created = await api.createSession(projectId, {
          id,
          title: seedSessionTitle(text, splitImages(files).images.map((file) => file.name)),
          driver: draftDriver,
          envMode: draftEnvMode,
          ...(draftEnvMode === "worktree" && draftBase.baseRef ? { baseRef: draftBase.baseRef } : {}),
          ...(draftEnvMode === "worktree" && draftBase.branchName ? { branchName: draftBase.branchName } : {}),
        }).catch((cause: unknown) => {
          window.history.replaceState(null, "", canvas);
          throw cause;
        });
        target = created.session.id;
        if (target !== id) window.history.replaceState(null, "", sessionHref({ id: target, projectId, hostId }));
        const model = sessionModelSelection(created.session.providerInstanceId, draftPick);
        const creationPatch = {
          ...(runtimeModeTouched ? { runtimeMode: draftRuntimeMode } : {}),
          ...(model ? { model } : {}),
        };
        if (Object.keys(creationPatch).length > 0) {
          const patched = await api.updateSession(target, creationPatch);
          setSession(patched.session);
        }
        writePanelTabs(target, panel, Date.now());
        // Every Editor's files travel with them — same hand-off, same reason.
        for (const [instance, state] of Object.entries(editors)) writeEditor(editorInstanceKey(target, instance), state, Date.now());
        setTurns([]);
        setItems([]);
        setTasks([]);
        setRequests([]);
        setEvents([]);
        owner.current = { sessionId: target, projectId };
        setCreatedSessionId(target);
        // Only when the patch did not already give us a newer record.
        if (Object.keys(creationPatch).length === 0) setSession(created.session);
      }
      const attachmentIds: string[] = [];
      for (const file of files) {
        const stored = await api.uploadAttachment(target, file);
        attachmentIds.push(stored.attachment.id);
      }
      const pending = session?.model ?? draftPick;
      await api.submitTurn(target, {
        runId,
        input: text,
        ...(choiceNamesAnything(pending) ? { model: choiceOf(pending) as TurnModelSelection } : {}),
        ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
      });
      // Only for a session that already existed. A just-created one is hydrated
      // by the effect that fires when `sessionId` changes, and calling it here
      // would run against the stale id captured in this closure.
      if (sessionId) await hydrate();
      setError(undefined);
    } catch (cause) {
      // Give the words back — and the files. Losing a typed message to a failed
      // post is unforgivable in a way that a visible error is not, and a human
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
  const setModel = async (next: ModelChoice) => {
    if (!session || !sessionId) return;
    try {
      const updated = await api.updateSession(sessionId, {
        model:
          sessionModelSelection(session.providerInstanceId, next) ??
            // `null`, not `undefined`: JSON.stringify drops an undefined key, so
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
            onRename={(next) => void rename(next)}
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
                sending={sending}
                onInsert={insertIntoComposer}
                {...panelGestures}
                onDecide={(requestId, decision, extra) => void decideRequest(requestId, decision, extra)}
                onRetry={(item) => void retryAmbiguous(item)}
                {...(turn.failureCode === "rate_limited" && turn.state === "failed"
                  ? { onResumeNow: () => void resumeNow(turn.runId) }
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
          draft={draft}
          // A fresh canvas is ready: there is nothing to wait for, because the
          // message you type is the thing that creates the session.
          ready={fresh || Boolean(session)}
          // Not while a conversation is opening: its placement is still moving
          // the viewport, and a composer changing height under it would move it
          // again.
          compact={readingBack && transcriptLanded}
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
                ...(draftDriver === "claude" ? { onAdopt: adoptConversation } : {}),
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
          {...(session?.driver === "claude" ? { onCompact: () => void compact() } : {})}
          compacting={compacting}
          contextNoticePercent={contextNoticePercent}
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
          {...(solo ? {} : { onViewBackground: showProcesses })}
          // Before a session exists there is nothing to patch, so both choices
          // are held locally and applied by the one patch that follows creation.
          onRuntimeMode={
            fresh
              ? (mode) => {
                  setRuntimeModeTouched(true);
                  setDraftRuntimeMode(mode);
                }
              : (mode) => void setRuntimeMode(mode)
          }
          {...(fresh ? {} : { onResumeAfterRateLimit: (next: boolean) => void setResumeAfterRateLimit(next) })}
          {...(sessionDefaults.resumeAfterRateLimit === undefined ? {} : { resumeAfterRateLimitDefault: sessionDefaults.resumeAfterRateLimit })}
          onModelChange={fresh ? chooseDraftModel : (next) => void setModel(next)}
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
          onTabChange={(id) => updatePanel((current) => ({ ...current, activeTab: id }))}
          onOpenTab={showPanelTab}
          onOpenNewTab={showNewPanelTab}
          onOpenFileInNewTab={openFileInNewPanelTab}
          onInsertReference={insertIntoComposer}
          onAttach={attachFromPanel}
          onCloseTab={(id) => {
            // Outside the reducer on purpose: a reducer runs twice under
            // StrictMode, and killing a process is not something to do twice.
            const closing = findPanelTab(panel, id);
            if (closing?.kind === "terminal") {
              // The tab stays until the person has answered — "no" keeps it,
              // and everything in it, running.
              const runApi = createRunApi(hostFetcher(hostId));
              void closeTerminalTab(closing.params, {
                ...(sessionId ? { stopRun: (terminalId: string) => runApi.stop(sessionId, terminalId) } : {}),
              }).then((closed) => {
                if (closed) updatePanel((current) => closePanelTab(current, id));
              });
              return;
            }
            const releasing = sessionId ? browserScopeToRelease(sessionId, closing) : undefined;
            if (releasing) void desktopBrowserBridge()?.releaseScope?.(releasing, true, { closedByPerson: true }).catch(() => undefined);
            updatePanel((current) => closePanelTab(current, id));
          }}
          onTabParams={(id, params) => updatePanel((current) => setPanelTabParams(current, id, params))}
          // Persisted through the same `updatePanel` every other tab gesture
          // writes, so a reordered strip comes back reordered.
          onMoveTab={(id, toIndex) => updatePanel((current) => movePanelTab(current, id, toIndex))}
          onClose={() => updatePanel((current) => ({ ...current, open: false }))}
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
