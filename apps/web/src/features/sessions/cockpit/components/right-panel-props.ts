import type { ComponentProps } from "react";
import type { Session } from "@telar/engine-client";
import type { RightPanel } from "@/features/panel";
import type { useCockpitPanel } from "../hooks/use-cockpit-panel";
import type { useComposerDraft } from "../hooks/use-composer-draft";
import type { useSessionBrowser } from "../hooks/use-session-browser";
import type { useSessionSync } from "../hooks/use-session-sync";
import type { useTranscriptModel } from "../hooks/use-transcript-model";

/** Everything the cockpit hands its right panel, gathered from the hooks that own each piece. */
export function rightPanelProps({ open, hostId, sessionId, projectId, session, sync, model, panel, browser, composer, enabledPlugins, pluginPanels }: {
  open: boolean;
  hostId: string;
  sessionId: string | undefined;
  projectId: string | undefined;
  session: Session | undefined;
  sync: ReturnType<typeof useSessionSync>;
  model: ReturnType<typeof useTranscriptModel>;
  panel: ReturnType<typeof useCockpitPanel>;
  browser: ReturnType<typeof useSessionBrowser>;
  composer: ReturnType<typeof useComposerDraft>;
  enabledPlugins: readonly string[];
  pluginPanels: ComponentProps<typeof RightPanel>["pluginPanels"];
}): ComponentProps<typeof RightPanel> {
  const { active } = model;
  return {
    open,
    ...(active?.state ? { active: active.state } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(session?.title ? { sessionTitle: session.title } : {}),
    projectId: session?.projectId ?? projectId,
    ...(session?.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
    items: sync.items,
    turns: sync.turns,
    tasks: model.roster,
    ...(model.focusedTask ? { focusedTask: model.focusedTask } : {}),
    ...(browser.browserCanStart ? { onOpenBrowser: browser.openBrowser, browserStart: browser.browserStart } : {}),
    events: sync.events,
    tabs: panel.panel.tabs,
    ...(panel.panel.activeTab ? { tab: panel.panel.activeTab } : {}),
    ...panel.tabHandlers,
    onOpenTab: panel.showPanelTab,
    onOpenNewTab: panel.showNewPanelTab,
    onOpenFileInNewTab: panel.openFileInNewPanelTab,
    onInsertReference: composer.insertIntoComposer,
    onAttach: composer.attachFromPanel,
    editors: panel.editors,
    onEditorChange: panel.updateEditor,
    hostId,
    enabledPlugins,
    pluginPanels,
  };
}
