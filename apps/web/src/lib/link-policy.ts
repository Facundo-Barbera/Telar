"use client";

/**
 * Where conversation links open: the system browser, or (when on) a right-panel tab or the
 * session's integrated browser. Per-window localStorage, since nothing engine-side reads it;
 * the desktop shell's main process gets a mirror (see `claimLinks`).
 */

import { useCallback, useSyncExternalStore } from "react";

const KEY = "telar:open-links-in-session-browser";
const CHANGED = "telar:link-policy";

/** The live answer, for handlers that are not hooks. */
export function openLinksInSessionBrowser(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

// `storage` carries a flip made in another window, which the same-window event never reaches.
function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useLinkPolicy(): { openInSessionBrowser: boolean; setOpenInSessionBrowser: (next: boolean) => void } {
  // The server snapshot is "off" so the first client render matches the server's.
  const openInSessionBrowser = useSyncExternalStore(subscribe, openLinksInSessionBrowser, () => false);

  const setOpenInSessionBrowser = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      // Storage denied costs persistence, not the flip in front of you.
    }
    window.dispatchEvent(new CustomEvent<boolean>(CHANGED, { detail: next }));
    syncShell();
  }, []);

  return { openInSessionBrowser, setOpenInSessionBrowser };
}

/**
 * Popups (`target=_blank`, Streamdown's confirmed links) are decided in the shell's main
 * process, so the setting is mirrored there (`apps/desktop/link-routing.js`). The last cockpit
 * to claim wins; releasing clears only its own claim.
 */
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
  // A shell that refuses leaves links on the system browser.
  void links.setRouting(on).catch(() => undefined);
}

/** Claim this window's links for `route`; returns the release. */
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

/** Fallback when neither the panel nor the session's browser can take a link; via the shell when present. */
export function openInSystemBrowser(href: string): void {
  const openExternal = shell().openExternal;
  if (openExternal) void openExternal(href).catch(() => undefined);
  else window.open(href, "_blank", "noopener,noreferrer");
}
