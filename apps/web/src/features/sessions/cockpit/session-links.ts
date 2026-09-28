"use client";

import { desktopBrowserBridge } from "@/features/browser";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher } from "@/platform/engine/host-client";

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

export async function openUrlInSessionBrowser(
  sessionId: string | undefined,
  projectId: string | undefined,
  url: string,
  hostId?: string,
): Promise<"native" | "engine" | undefined> {
  if (!sessionId) return undefined;
  const bridge = desktopBrowserBridge();
  if (bridge) {
    try {
      // The host refuses tabs for an unbound scope; binding is idempotent and
      // re-declared here exactly as the browser panel does before its actions.
      await bridge.bindProfile?.(sessionId, projectId ?? "none");
      await bridge.action(sessionId, { action: "new", url });
      return "native";
    } catch {
      return undefined;
    }
  }
  try {
    const answer = await createEngineApi(hostFetcher(hostId ?? "local")).browserOpen(sessionId, url);
    return answer.browser.tabs.length > 0 ? "engine" : undefined;
  } catch {
    return undefined;
  }
}
