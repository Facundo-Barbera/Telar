"use client";

import { useCallback, useSyncExternalStore } from "react";

const KEY = "telar:open-links-in-session-browser";
const CHANGED = "telar:link-policy";

export function openLinksInSessionBrowser(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useLinkPolicy(): { openInSessionBrowser: boolean; setOpenInSessionBrowser: (next: boolean) => void } {
  const openInSessionBrowser = useSyncExternalStore(subscribe, openLinksInSessionBrowser, () => false);

  const setOpenInSessionBrowser = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
    }
    window.dispatchEvent(new CustomEvent<boolean>(CHANGED, { detail: next }));
    syncShell();
  }, []);

  return { openInSessionBrowser, setOpenInSessionBrowser };
}

type LinkRouter = (href: string) => void;
type ShellLinks = {
  setRouting(on: boolean): Promise<unknown>;
  onOpen(listener: (payload: { url?: unknown }) => void): () => void;
};
type ShellOpenExternal = (url: string) => Promise<unknown>;

let router: LinkRouter | undefined;
let unsubscribeShell: (() => void) | undefined;

function shell(): { links?: ShellLinks; openExternal?: ShellOpenExternal } {
  if (typeof window === "undefined") return {};
  const desktop = (window as unknown as { telarDesktop?: { links?: ShellLinks; browser?: { openExternal?: ShellOpenExternal } } }).telarDesktop;
  return { links: desktop?.links, openExternal: desktop?.browser?.openExternal };
}

function syncShell(): void {
  const links = shell().links;
  if (!links) return;
  const on = router !== undefined && openLinksInSessionBrowser();
  if (on && !unsubscribeShell) {
    unsubscribeShell = links.onOpen(({ url }) => {
      if (typeof url !== "string") return;
      if (router) router(url);
      else openInSystemBrowser(url);
    });
  } else if (!on && unsubscribeShell) {
    unsubscribeShell();
    unsubscribeShell = undefined;
  }
  void links.setRouting(on).catch(() => undefined);
}

export function claimLinks(route: LinkRouter): () => void {
  router = route;
  syncShell();
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) syncShell();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    if (router !== route) return;
    router = undefined;
    syncShell();
  };
}

export function openInSystemBrowser(href: string): void {
  const openExternal = shell().openExternal;
  if (openExternal) void openExternal(href).catch(() => undefined);
  else window.open(href, "_blank", "noopener,noreferrer");
}
