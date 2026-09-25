"use client";

/**
 * WHERE A LINK IN A CONVERSATION OPENS — the system browser, or this session's.
 *
 * Off, a click behaves the way the web behaves: a new tab in whatever browser
 * the machine defaults to. On, the cockpit keeps the reading in the cockpit:
 * an issue or pull request the session mentions opens as its own right-panel
 * tab, and any other link opens as a tab in the session's integrated browser —
 * the same tabs the agent's `browser_*` tools drive, so what you opened is
 * what it can act on.
 *
 * LOCAL STORAGE, NOT ENGINE STATE, and deliberately so: `session-defaults.ts`
 * lives on the engine because the ENGINE reads that document on the create
 * path. Nothing engine-side ever reads this — it decides what a click in THIS
 * window does, and the desktop shell (which has a native browser to open into)
 * and a phone (which does not) are right to answer differently.
 *
 * Same-window CustomEvent for cross-component sync, the `useSessionDefaults`
 * pattern: the settings row flips it, the transcript reads it, neither polls.
 * The desktop shell's main process gets a MIRROR of it — see `claimLinks`.
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

// `storage` is the flip made in ANOTHER window, which the same-window event
// never reaches.
function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useLinkPolicy(): { openInSessionBrowser: boolean; setOpenInSessionBrowser: (next: boolean) => void } {
  // The server snapshot is "off", so the first client render agrees with the
  // server's and the stored answer lands straight after hydration.
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
 * WHO OPENS THIS WINDOW'S LINKS — the cockpit, while it is mounted.
 *
 * Catching clicks in the page is not enough on the desktop: a link the page
 * never sees as a click (Streamdown's confirmed link, a `target=_blank` in the
 * right panel or in tool output) becomes a popup, and popups are decided in
 * the shell's main process, which cannot read this window's localStorage. So
 * the setting is MIRRORED there (`apps/desktop/link-routing.js`): while a
 * cockpit has claimed its links and the setting is on, the shell hands each
 * such popup back here instead of to the system browser, and it is routed like
 * any caught click.
 *
 * One router at a time: the last cockpit to claim wins, and releasing only
 * clears the claim it made.
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
  // A shell that refuses (an older one, or a window it does not recognise)
  // leaves links on the system browser, which is where they went anyway.
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

/**
 * The fallback when neither the panel nor the session's browser can take a
 * link. Through the shell when there is one: `window.open` there is a popup,
 * and a claimed window's popups come straight back to the router.
 */
export function openInSystemBrowser(href: string): void {
  const openExternal = shell().openExternal;
  if (openExternal) void openExternal(href).catch(() => undefined);
  else window.open(href, "_blank", "noopener,noreferrer");
}
