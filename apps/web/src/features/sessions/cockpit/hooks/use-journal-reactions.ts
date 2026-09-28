"use client";

import { useCallback, useEffect, useRef } from "react";
import type { EngineEvent } from "@telar/engine-client";
import { announcePromptShelfChanged } from "@/features/prompts";
import {
  agentBrowserActivity,
  browserPanelTab,
  LIVE_BROWSER_TAB,
  openPanelTab,
  panelTabForPath,
  revealPanelTab,
  type latestBrowserState,
  type PanelTab,
  type PanelTabState,
} from "@/features/panel";
import { freshTerminals, revealTerminal, type RunView } from "@/features/terminal";
import { desktopBrowserBridge } from "@/features/browser/desktop-browser-bridge";

/** What the panel does when the journal says the agent opened a page, a display, a terminal or a prompt draft. */
export function useJournalReactions({ events, browser, enabledPlugins, showPanelTab, updatePanel }: {
  events: EngineEvent[];
  browser: ReturnType<typeof latestBrowserState>;
  enabledPlugins: readonly string[];
  showPanelTab: (tab: PanelTab) => void;
  updatePanel: (next: (current: PanelTabState<PanelTab>) => PanelTabState<PanelTab>) => void;
}) {
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

  // Stamped in an effect, not at render: reading the clock during render is impure.
  const mountedAt = useRef(0);
  const browserEventsThrough = useRef(0);
  const seenEvents = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (mountedAt.current === 0) mountedAt.current = Date.now();
    if (desktopBrowserBridge()) {
      const { acted, through } = agentBrowserActivity(events, mountedAt.current, browserEventsThrough.current);
      browserEventsThrough.current = through;
      if (acted) updatePanel((current) => revealPanelTab(current, { id: LIVE_BROWSER_TAB, kind: LIVE_BROWSER_TAB, params: {} }));
    }
    const fresh = events.filter(
      (event) => (event.type === "display.opened" || event.type === "prompt.drafted") && event.at >= mountedAt.current && !seenEvents.current.has(event.id),
    );
    for (const event of fresh) seenEvents.current.add(event.id);
    const display = fresh.filter((event) => event.type === "display.opened").at(-1);
    if (display?.type === "display.opened") showPanelTab(panelTabForPath(display.path, enabledPlugins));
    if (fresh.some((event) => event.type === "prompt.drafted")) announcePromptShelfChanged();
  }, [events, enabledPlugins, showPanelTab, updatePanel]);

  const seenTerminals = useRef<Set<string>>(new Set());
  return useCallback(
    (terminals: readonly RunView[]) => {
      if (mountedAt.current === 0) mountedAt.current = Date.now();
      const fresh = freshTerminals(terminals, mountedAt.current, seenTerminals.current);
      for (const run of terminals) seenTerminals.current.add(run.terminalId);
      if (fresh.length === 0) return;
      updatePanel((current) => fresh.reduce((state, run) => revealTerminal(state, run, "terminal"), current));
    },
    [updatePanel],
  );
}
