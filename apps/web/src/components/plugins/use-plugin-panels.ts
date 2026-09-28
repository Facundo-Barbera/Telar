"use client";

import { useEffect, useState } from "react";
import { registerPluginToolPrefixes } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher } from "@/lib/hosts/client";
import { pluginPanelSources, type PluginPanelSource } from "@/lib/plugins/panels";
import { PLUGIN_WEB } from "@/lib/plugins/registry";

const NONE: readonly PluginPanelSource[] = [];

/**
 * The enabled installed plugins' panels, read from this screen's Mac. Asked
 * only when an enabled id is not a bundled one, so a project with just Data
 * Science or LaTeX costs no extra request. The same answer registers the
 * installed prefixes, so their tool rows are typed like a bundled plugin's.
 */
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
