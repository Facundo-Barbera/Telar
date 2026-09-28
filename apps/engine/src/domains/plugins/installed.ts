import { registerPluginToolPrefixes } from "@telar/engine-client";
import { pluginToolModules, setPluginToolModules } from "./bundled";
import type { LoadedExternalPlugin, RefusedExternalPlugin } from "./external/manifest";
import { externalToolModule, isExternalToolModule } from "./external/module";

export type InstalledPlugins = ReturnType<typeof installedPlugins>;

/**
 * What is installed now: loaded plugins by id, and refused folders by listed id. Settings changes both.
 * `sync` re-registers their tool walls beside this process's own; the out-of-process worker loads the folder itself.
 */
export function installedPlugins(external: { loaded: LoadedExternalPlugin[]; refused: RefusedExternalPlugin[] }) {
  const loaded = new Map(external.loaded.map((plugin) => [plugin.manifest.id, plugin]));
  const refused = new Map(external.refused.map((plugin) => [plugin.meta.id, plugin.dir]));
  const baseToolModules = pluginToolModules().filter((module) => !isExternalToolModule(module));
  const prefixes = () => [...loaded.values()].flatMap((plugin) => (plugin.manifest.toolPrefix ? [plugin.manifest.toolPrefix] : []));
  const sync = () => {
    registerPluginToolPrefixes(prefixes());
    setPluginToolModules([...baseToolModules, ...[...loaded.values()].map(externalToolModule)]);
  };
  sync();
  return { loaded, refused, prefixes, sync };
}
