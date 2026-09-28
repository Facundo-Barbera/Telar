import { helloPlugin, helloToolModule, type HelloSession } from "./hello";
import { latexPlugin, latexToolModule, type LatexPluginDeps } from "./latex/plugin";
import { dataSciencePlugin, dataScienceToolModule, type DataSciencePluginDeps } from "./data-science/plugin";
import type { PluginEngineModule } from "./contract";
import type { PluginToolModule } from "./tool-module";

export type BundledPluginDeps = {
  resolveHello: (sessionId: string) => HelloSession;
  latex: LatexPluginDeps;
  dataScience: DataSciencePluginDeps;
};

export const HELLO_GATE = "TELAR_PLUGIN_HELLO";

export const BUNDLED_PLUGIN_IDS = ["latex", "data-science", "hello"] as const;

export function bundledPlugins(deps: BundledPluginDeps, env: NodeJS.ProcessEnv = process.env): PluginEngineModule[] {
  const modules: PluginEngineModule[] = [];
  modules.push(latexPlugin(deps.latex));
  modules.push(dataSciencePlugin(deps.dataScience));
  if (env[HELLO_GATE] === "1") modules.push(helloPlugin({ resolve: deps.resolveHello }));
  return modules;
}

export function bundledPluginToolModules(env: NodeJS.ProcessEnv = process.env): PluginToolModule[] {
  const modules: PluginToolModule[] = [latexToolModule, dataScienceToolModule];
  if (env[HELLO_GATE] === "1") modules.push(helloToolModule);
  return modules;
}

let registered: readonly PluginToolModule[] = bundledPluginToolModules();

export function pluginToolModules(): readonly PluginToolModule[] {
  return registered;
}

export function setPluginToolModules(modules: readonly PluginToolModule[]): void {
  registered = [...modules];
}

export function pluginBriefings(enabled: Iterable<string>): string[] {
  const ids = new Set(enabled);
  return registered.flatMap((module) => (ids.has(module.meta.id) && module.meta.briefing ? [module.meta.briefing] : []));
}
