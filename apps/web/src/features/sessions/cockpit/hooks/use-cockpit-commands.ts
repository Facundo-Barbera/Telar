"use client";

import { useCommandHandlers } from "@/features/commands";
import type { PanelTab } from "@/features/panel";
import { pluginCommands } from "@/features/plugins";
import type { useCockpitPanel } from "./use-cockpit-panel";

/** The cockpit's keyboard commands: the panel's (none on the solo route), the enabled plugins' openers, and pinning. */
export function useCockpitCommands({ solo, enabledPlugins, panel, pinSession }: {
  solo: boolean;
  enabledPlugins: readonly string[];
  panel: ReturnType<typeof useCockpitPanel>;
  pinSession: () => void;
}) {
  const { togglePanel, stepPanelTab, showPanelTab, updatePanel, makeRoomForPanel } = panel;
  useCommandHandlers(
    {
      ...(solo
        ? {}
        : {
            "toggle-panel": togglePanel,
            "panel-next-tab": () => stepPanelTab(1),
            "panel-previous-tab": () => stepPanelTab(-1),
            "open-diff": () => showPanelTab("diff"),
            "open-editor": () => showPanelTab("editor"),
            ...Object.fromEntries(pluginCommands(enabledPlugins).map((command) => [command.id, () => showPanelTab(command.surface as PanelTab)])),
          }),
      "pin-session": pinSession,
    },
    [solo, enabledPlugins, stepPanelTab, showPanelTab, updatePanel, makeRoomForPanel],
  );
}
