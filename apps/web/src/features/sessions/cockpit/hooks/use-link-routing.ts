"use client";

import { useCallback, useEffect, useRef } from "react";
import { createEngineApi } from "@/platform/engine";
import { issuePanelTab, pullPanelTab } from "@/features/panel";
import { hostFetcher } from "@/platform/engine/host-client";
import { claimLinks, openInSystemBrowser, openLinksInSessionBrowser } from "@/platform/link-policy";
import { openUrlInSessionBrowser, parseForgeLink, sameRepository } from "../session-links";
import type { useCockpitPanel } from "./use-cockpit-panel";

/** Routes web links from the conversation (and ones claimed app-wide) to this project's forge tabs or the session browser. */
export function useLinkRouting({ hostId, projectId, sessionId, solo, panel: { showPanelTab, showSessionBrowser, updatePanel } }: {
  hostId: string;
  projectId: string | undefined;
  sessionId: string | undefined;
  solo: boolean;
  panel: ReturnType<typeof useCockpitPanel>;
}) {
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
          // The page's own tab arrives with the next journal sync; see useJournalReactions.
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
  return onConversationClick;
}
