"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { EngineEvent, ProviderDriverKind, RuntimeMode, Session } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { writeDraft } from "@/features/composer";
import { sessionModelSelection, type ModelChoice } from "@/features/providers";
import { browserPanelTab, describeBrowserStart, latestBrowserState, type BrowserStartState, type PanelTab, type PanelTabState } from "@/features/panel";
import type { EditorState } from "@/features/files";
import { desktopBrowserBridge } from "@/features/browser/desktop-browser-bridge";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { sessionHref } from "../../session-list";
import { newSessionId } from "../../session-mutations";
import { handOffCanvas } from "../canvas-handoff";

export type DraftChoices = {
  driver: ProviderDriverKind;
  envMode: "local" | "worktree";
  base: { baseRef?: string; branchName?: string };
  pick: ModelChoice;
  runtimeMode: RuntimeMode;
};

type Owner = { sessionId: string | undefined; projectId: string | undefined };

/** The session's browser: whether it can start, and opening it — which first turns a fresh canvas into a draft session. */
export function useSessionBrowser({ hostId, sessionId, projectId, transcriptLanded, events, draft, draftText, owner, panel, editors, setSession, setCreatedSessionId, showSessionBrowser, showPanelTab }: {
  hostId: string;
  sessionId: string | undefined;
  projectId: string | undefined;
  transcriptLanded: boolean;
  events: EngineEvent[];
  draft: DraftChoices;
  draftText: RefObject<string>;
  owner: RefObject<Owner>;
  panel: PanelTabState<PanelTab>;
  editors: Record<string, EditorState>;
  setSession: (session: Session) => void;
  setCreatedSessionId: (id: string) => void;
  showSessionBrowser: () => void;
  showPanelTab: (tab: PanelTab) => void;
}) {
  /** Folded once here so the panel and the pinned summary cannot disagree about which tabs are open. */
  const browser = useMemo(() => latestBrowserState(events), [events]);

  const [browserCanStart, setBrowserCanStart] = useState(false);
  useEffect(() => {
    if (!transcriptLanded) return;
    let cancelled = false;
    // Deferred: a synchronous setState in an effect body is a cascading render.
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

  const [browserStart, setBrowserStart] = useState<BrowserStartState>({ status: "idle" });
  const browserOpening = useRef(false);
  const browserDraftIdentity = useRef<{ path: string; id: string } | null>(null);
  const browserDraftFlight = useRef<Promise<string> | null>(null);
  const browserDraftSendPending = useRef(false);

  async function ensureBrowserDraft(): Promise<string> {
    if (sessionId) return sessionId;
    if (projectId === undefined) throw new EngineApiError("invalid_request", "This conversation has no project to open a draft in.");
    if (browserDraftFlight.current) return browserDraftFlight.current;
    const origin = window.location.pathname;
    if (browserDraftIdentity.current?.path !== origin) browserDraftIdentity.current = { path: origin, id: newSessionId() };
    const id = browserDraftIdentity.current.id;
    // Keep both requests on the originating host if navigation changes mid-flight.
    const draftApi = createEngineApi(hostFetcher(hostId));
    const flight = (async () => {
      const created = await draftApi.createSession(projectId, {
        id, draft: true, title: "Browser draft", driver: draft.driver, envMode: draft.envMode,
        ...(draft.envMode === "worktree" ? draft.base : {}),
      });
      const model = sessionModelSelection(created.session.providerInstanceId, draft.pick);
      const patched = await draftApi.updateSession(id, { runtimeMode: draft.runtimeMode, ...(model ? { model } : {}) });
      // Keep the durable draft, but never navigate over a different conversation.
      if (window.location.pathname !== origin) return id;
      writeDraft(id, projectId, draftText.current);
      writeDraft(undefined, projectId, "");
      handOffCanvas(id, projectId, { panel, editors }, { clearCanvas: true });
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
      await desktopBrowserBridge()?.bindProfile?.(target, projectId ?? "none");
      if (window.location.pathname !== origin && window.location.pathname !== destination) return;
      const result = await browserApi.browserState(target, { start: true });
      if (window.location.pathname !== destination) return;
      setBrowserStart(describeBrowserStart(result.browser));
      const active = result.browser.tabs.find((tab) => tab.active) ?? result.browser.tabs[0];
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

  return { browser, browserCanStart, browserStart, openBrowser, browserDraftFlight, browserDraftSendPending };
}
