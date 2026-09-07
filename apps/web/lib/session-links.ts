"use client";

/**
 * WHAT A CLICKED LINK IN THE CONVERSATION SHOULD DO, once `link-policy.ts`
 * says "keep it in the cockpit".
 *
 * TWO DESTINATIONS, in order of specificity:
 *
 *   1. An issue or pull request OF THIS PROJECT opens as its own right-panel
 *      tab — the same surface a dropped chip opens — because the panel's view
 *      is richer than the web page: it is live, draggable back into the
 *      composer, and next to the work.
 *   2. Anything else opens as a tab in the session's integrated browser (the
 *      desktop shell's native view), where the agent's `browser_*` tools can
 *      see it too.
 *
 * THE REPOSITORY CHECK IS NOT OPTIONAL for (1): the issue surface asks gh for
 * "this project's issue N", so routing another repository's `/issues/N` there
 * would silently show the wrong issue. A GitHub link whose repo is unknown or
 * different is just a page, and goes to the browser like any other link.
 *
 * NON-DESKTOP CLIENTS FALL BACK to the system browser: the screenshot client
 * watches the session's browser but has no channel to command it, and a click
 * that does nothing is worse than a tab in the wrong place.
 */

import { desktopBrowserBridge } from "@/components/browser-live";

export type ForgeLink = { kind: "issue" | "pull"; number: number; repository: string };

/** `github.com/{owner}/{repo}/issues/{n}` or `/pull/{n}`, else nothing. */
export function parseForgeLink(href: string): ForgeLink | undefined {
  try {
    const url = new URL(href);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
    const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(url.pathname);
    if (!match) return undefined;
    const number = Number(match[4]);
    if (!(number > 0)) return undefined;
    return { kind: match[3] === "issues" ? "issue" : "pull", number, repository: `${match[1]}/${match[2]}` };
  } catch {
    return undefined;
  }
}

/** Same repository, GitHub's case-insensitive way. */
export function sameRepository(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * Open `url` as a new tab in the session's integrated browser. True when it
 * landed there; false when this client has no way to (not the desktop shell,
 * or no session yet) — the caller falls back to the system browser.
 */
export async function openUrlInSessionBrowser(sessionId: string | undefined, projectId: string | undefined, url: string): Promise<boolean> {
  const bridge = desktopBrowserBridge();
  if (!bridge || !sessionId) return false;
  try {
    // The host refuses tabs for an unbound scope; binding is idempotent and
    // re-declared here exactly as the browser panel does before its actions.
    await bridge.bindProfile?.(sessionId, projectId ?? "none");
    await bridge.action(sessionId, { action: "new", url });
    return true;
  } catch {
    return false;
  }
}
