/**
 * WHICH PLUGINS THE DAEMON REGISTERS. One list, one place, one decision.
 *
 * Plugins installed from a folder (`external/`) are appended to what this
 * returns, and nothing downstream knows the difference — the host takes a list
 * of modules and does not care where they came from. They may not take a name
 * this list uses: see `BUNDLED_PLUGIN_IDS`.
 */
import { helloPlugin, helloToolModule, type HelloSession } from "./hello";
import { latexPlugin, latexToolModule, type LatexPluginDeps } from "./latex";
import { dataSciencePlugin, dataScienceToolModule, type DataSciencePluginDeps } from "./data-science";
import type { PluginEngineModule } from "./contract";
import type { PluginToolModule } from "./tool-module";

/**
 * What the daemon must supply. Every entry is a CAPABILITY RESOLVER — "given a
 * session, what does this plugin see" — because that is the one question a
 * plugin cannot answer for itself: which project a session belongs to, and
 * whether that project has opted in, is store knowledge.
 */
export type BundledPluginDeps = {
  resolveHello: (sessionId: string) => HelloSession;
  latex: LatexPluginDeps;
  dataScience: DataSciencePluginDeps;
};

/**
 * The proof plugin is GATED, and the gate is an environment variable rather than
 * a setting.
 *
 * `hello` exists to prove that adding a plugin needs no new feature-specific
 * branch anywhere in the core — not to be a feature. A setting would put it in
 * front of users in a settings page; an env var keeps it where it belongs, in a
 * developer's shell and in the test that drives the generic path end to end.
 */
export const HELLO_GATE = "TELAR_PLUGIN_HELLO";

/** Every id shipped here, gated or not — reserved against installed plugins. */
export const BUNDLED_PLUGIN_IDS = ["latex", "data-science", "hello"] as const;

export function bundledPlugins(deps: BundledPluginDeps, env: NodeJS.ProcessEnv = process.env): PluginEngineModule[] {
  const modules: PluginEngineModule[] = [];
  // MIGRATED, AND UNGATED. LaTeX is a shipped feature: its presence in the
  // registry is not a developer's choice, and a project that has not enabled it
  // is refused at the plugin's own gate rather than by leaving it unregistered.
  modules.push(latexPlugin(deps.latex));
  modules.push(dataSciencePlugin(deps.dataScience));
  if (env[HELLO_GATE] === "1") modules.push(helloPlugin({ resolve: deps.resolveHello }));
  return modules;
}

/**
 * THE SAME LIST, SEEN FROM THE WORKER.
 *
 * Every wall rides the `telar` key, so a plugin tool keeps the one name it
 * shipped with (`mcp__telar__latex_compile`) whichever transport carries it —
 * which is what lets LaTeX and Data Science live here without orphaning a
 * single stored approval.
 *
 * It has to be a second function rather than a field on the first because the
 * two halves live in different processes: the worker has no store to resolve
 * capabilities against, so it can build the walls but not the modules. The
 * GATE is read in both places from the same env var, so a plugin cannot be
 * registered on one side and missing on the other.
 */
export function bundledPluginToolModules(env: NodeJS.ProcessEnv = process.env): PluginToolModule[] {
  const modules: PluginToolModule[] = [latexToolModule, dataScienceToolModule];
  if (env[HELLO_GATE] === "1") modules.push(helloToolModule);
  return modules;
}

/**
 * THE WALLS THIS PROCESS MAY SERVE. Read from the bundled list at module load,
 * and replaceable — the worker serves what it was built with, and a test
 * installs its own so a proof plugin's wall can be driven without the env gate.
 *
 * It lives beside the list rather than in the driver because three places
 * register from it — the Claude in-process server, the Claude driver's `telar`
 * socket and the worker's lease for Codex and OpenCode — and none of them names
 * a plugin.
 */
let registered: readonly PluginToolModule[] = bundledPluginToolModules();

export function pluginToolModules(): readonly PluginToolModule[] {
  return registered;
}

export function setPluginToolModules(modules: readonly PluginToolModule[]): void {
  registered = [...modules];
}

/**
 * THE PARAGRAPHS A SESSION IS TOLD, one per enabled plugin that has one — in
 * registration order, so the same set always reads the same way and a reused
 * query's system prompt does not churn.
 */
export function pluginBriefings(enabled: Iterable<string>): string[] {
  const ids = new Set(enabled);
  return registered.flatMap((module) => (ids.has(module.meta.id) && module.meta.briefing ? [module.meta.briefing] : []));
}
