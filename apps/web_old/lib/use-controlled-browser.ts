"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";
import type {
  ControlledBrowserAction,
  ControlledBrowserState,
} from "@/lib/browser-runtime-contract";
import { subscribeBrowserRuntimeEvents } from "@/lib/browser-client-events";
import { cachedJson } from "@/lib/client-json-cache";
import { diagnosticFetch } from "@/lib/client-request-diagnostics";
import type {
  LocalServerSuggestion,
  LocalServersResponse,
} from "@/lib/local-server-contract";
import type { TelarDesktopBrowserBridge } from "@/types/telar-desktop";

const EMPTY_STATE: ControlledBrowserState = {
  available: true,
  running: false,
  tabs: [],
  screenshot: null,
  error: null,
  version: 0,
};

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

export function useControlledBrowser(scopeKey: string, onActiveUrl?: (url: string) => void) {
  const [state, setState] = useState<ControlledBrowserState>({ ...EMPTY_STATE, scopeKey });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [servers, setServers] = useState<LocalServerSuggestion[]>([]);
  const [serverState, setServerState] = useState<"loading" | "ready">("loading");
  const [desktopBridge] = useState<TelarDesktopBrowserBridge | null>(() =>
    typeof window === "undefined" ? null : window.telarDesktop?.browser ?? null,
  );
  const activeTab = state.tabs.find((tab) => tab.active) ?? state.tabs[0] ?? null;
  const hasNavigatedTab = Boolean(activeTab && activeTab.url !== "about:blank");

  useEffect(() => {
    setState({ ...EMPTY_STATE, scopeKey });
    setLoading(true);
    setServers([]);
    setServerState("loading");
  }, [scopeKey]);

  const applyState = useCallback((next: ControlledBrowserState) => {
    if (next.scopeKey && next.scopeKey !== scopeKey) return;
    setState(next);
    const active = next.tabs.find((tab) => tab.active) ?? next.tabs[0];
    if (active?.url) onActiveUrl?.(active.url);
  }, [onActiveUrl, scopeKey]);

  const refresh = useCallback(async () => {
    try {
      const next = desktopBridge
        ? await desktopBridge.getState(scopeKey)
        : await jsonResponse<ControlledBrowserState>(await diagnosticFetch(
            `/api/browser?scopeKey=${encodeURIComponent(scopeKey)}`,
            { cache: "no-store" },
            "refresh controlled browser state",
          ));
      applyState(next);
    } catch (error) {
      setState((current) => ({
        ...current,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setLoading(false);
    }
  }, [applyState, desktopBridge, scopeKey]);

  useEffect(() => {
    void refresh();
    if (desktopBridge) return desktopBridge.onState(applyState);
    return subscribeBrowserRuntimeEvents((event) => {
      if (event.stateChanged) void refresh();
    });
  }, [applyState, desktopBridge, refresh]);

  useEffect(() => {
    if (hasNavigatedTab || serverState !== "loading") return;
    let live = true;
    void cachedJson<LocalServersResponse>("/api/local-servers", { maxAgeMs: 5_000 })
      .then((data) => {
        if (!live) return;
        setServers(Array.isArray(data.servers) ? data.servers : []);
        setServerState("ready");
      })
      .catch(() => {
        if (!live) return;
        setServers([]);
        setServerState("ready");
      });
    return () => { live = false; };
  }, [hasNavigatedTab, serverState]);

  const act = useCallback(async (action: ControlledBrowserAction) => {
    setWorking(true);
    try {
      const next = desktopBridge
        ? await desktopBridge.action(scopeKey, action)
        : await jsonResponse<ControlledBrowserState>(await diagnosticFetch("/api/browser", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...action, scopeKey }),
          }, `browser action ${action.action}`));
      applyState(next);
      return true;
    } catch (error) {
      setState((current) => ({
        ...current,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    } finally {
      setWorking(false);
    }
  }, [applyState, desktopBridge, scopeKey]);

  const setup = useCallback(async () => {
    setWorking(true);
    try {
      await jsonResponse(await diagnosticFetch(
        "/api/browser/setup",
        { method: "POST" },
        "install browser runtime",
      ));
      await refresh();
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setWorking(false);
    }
  }, [refresh]);

  return {
    act,
    desktopBridge,
    hasNavigatedTab,
    loading,
    refresh,
    servers,
    serverState,
    setup,
    state,
    working,
  };
}

export function useDesktopBrowserViewport(
  bridge: TelarDesktopBrowserBridge,
  scopeKey: string,
  hostRef: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    let transitionFrame = 0;
    let disposed = false;
    let visibilityRequested = false;
    const applyBounds = async () => {
      const rect = host.getBoundingClientRect();
      await bridge.setBounds(scopeKey, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
      if (disposed) return;
      // THE LATCH RESETS ON A ZERO-AREA HOST, and that single line is the fix
      // for "the browser is blank until I refresh".
      //
      // `visibilityRequested` used to be a one-shot for the life of the effect:
      // the FIRST applyBounds asserted visibility and no later one ever did.
      // That is fine only if the first call sees the host at its real size, and
      // both of the ways this surface actually mounts violate that — collapsing
      // and re-opening the panel, and switching conversations (which remounts on
      // a new scopeKey) — because each mounts while the panel is still animating
      // open, when the host measures 0×0. The one assertion the effect had was
      // therefore spent on a zero-size view, and when the layout settled nothing
      // re-asserted. A reload looked like a fix because it mounts against an
      // already-settled layout.
      //
      // Treating "no area" as "not shown yet" makes visibility a function of the
      // CURRENT measurement rather than of mount order, so the followTransition
      // loop below (which already re-runs applyBounds for ~360ms) re-asserts as
      // soon as the host has real geometry. Nothing is asserted repeatedly at a
      // steady state: once shown at a non-empty size the latch holds as before.
      if (rect.width === 0 || rect.height === 0) {
        visibilityRequested = false;
        return;
      }
      if (visibilityRequested) return;
      visibilityRequested = true;
      await bridge.setVisible(scopeKey, true);
    };
    const sync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        void applyBounds();
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    // ResizeObserver does not report every positional change caused by an
    // ancestor's flex/margin animation. Follow that short transition directly
    // so Electron's native WebContentsView remains glued to its renderer host.
    const transitionDeadline = performance.now() + 360;
    const followTransition = () => {
      void applyBounds();
      if (performance.now() < transitionDeadline) {
        transitionFrame = window.requestAnimationFrame(followTransition);
      }
    };
    followTransition();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(transitionFrame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void bridge.setVisible(scopeKey, false);
    };
  }, [bridge, hostRef, scopeKey]);
}
