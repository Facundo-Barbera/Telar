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
import { cachedJson } from "@/lib/client-json-cache";
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

export function useControlledBrowser(onActiveUrl?: (url: string) => void) {
  const [state, setState] = useState(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [servers, setServers] = useState<LocalServerSuggestion[]>([]);
  const [serverState, setServerState] = useState<"loading" | "ready">("loading");
  const [desktopBridge] = useState<TelarDesktopBrowserBridge | null>(() =>
    typeof window === "undefined" ? null : window.telarDesktop?.browser ?? null,
  );
  const hasNavigatedTab = state.tabs.some((tab) => tab.url !== "about:blank");

  const refresh = useCallback(async () => {
    try {
      const next = desktopBridge
        ? await desktopBridge.getState()
        : await jsonResponse<ControlledBrowserState>(await fetch("/api/browser", { cache: "no-store" }));
      setState(next);
      const active = next.tabs.find((tab) => tab.active) ?? next.tabs[0];
      if (active?.url && active.url !== "about:blank") onActiveUrl?.(active.url);
    } catch (error) {
      setState((current) => ({
        ...current,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setLoading(false);
    }
  }, [desktopBridge, onActiveUrl]);

  useEffect(() => {
    void refresh();
    if (desktopBridge) return desktopBridge.onState(setState);
    const events = new EventSource("/api/browser/events");
    events.onmessage = () => { void refresh(); };
    return () => events.close();
  }, [desktopBridge, refresh]);

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
        ? await desktopBridge.action(action)
        : await jsonResponse<ControlledBrowserState>(await fetch("/api/browser", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(action),
          }));
      setState(next);
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
  }, [desktopBridge]);

  const setup = useCallback(async () => {
    setWorking(true);
    try {
      await jsonResponse(await fetch("/api/browser/setup", { method: "POST" }));
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
  hostRef: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const sync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        void bridge.setBounds({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        });
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    sync();
    void bridge.setVisible(true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void bridge.setVisible(false);
    };
  }, [bridge, hostRef]);
}
