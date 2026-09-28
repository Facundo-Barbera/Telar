"use client";

import { useEffect, useState } from "react";
import { registerPluginToolPrefixes } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine/index";
import { hostFetcher } from "@/lib/hosts/client";
import { pluginPanelSources, type PluginPanelSource } from "../panels";
import { PLUGIN_WEB } from "../registry";

const NONE: readonly PluginPanelSource[] = [];

export function usePluginPanels(hostId: string, enabled: readonly string[]): readonly PluginPanelSource[] {
  const [panels, setPanels] = useState<readonly PluginPanelSource[]>(NONE);
  const installed = enabled.some((id) => !Object.hasOwn(PLUGIN_WEB, id));
  useEffect(() => {
    let cancelled = false;
    if (!installed) {
      const task = window.setTimeout(() => !cancelled && setPanels(NONE), 0);
      return () => {
        cancelled = true;
        window.clearTimeout(task);
      };
    }
    createEngineApi(hostFetcher(hostId))
      .machinePlugins()
      .then(
        ({ plugins }) => {
          if (cancelled) return;
          registerPluginToolPrefixes(plugins.flatMap((status) => status.meta.toolPrefixes));
          const found = pluginPanelSources(plugins, enabled);
          setPanels(found.length > 0 ? found : NONE);
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [hostId, enabled, installed]);
  return panels;
}
