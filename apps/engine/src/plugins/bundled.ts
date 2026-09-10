/**
 * WHICH PLUGINS THE DAEMON REGISTERS. One list, one place, one decision.
 *
 * This is the file that would change on the day plugins are installed from a
 * folder: the loader would append to what this returns, and nothing downstream
 * would know the difference — the host takes a list of modules and does not care
 * where they came from. Everything else about that day is unsolved (see the
 * NOT A SANDBOX header in `contract.ts`); the SHAPE is not.
 */
import { helloPlugin, helloToolModule, type HelloSession } from "./hello";
import { latexPlugin, type LatexPluginDeps } from "./latex";
import { dataSciencePlugin, type DataSciencePluginDeps } from "./data-science";
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
 * THE SAME LIST, SEEN FROM THE WORKER — MINUS THE MIGRATED TOOLKITS.
 *
 * `latex` is absent on purpose and its absence is the compatibility decision:
 * its wall ships as `mcp__telar__latex_*` and stays registered in-process under
 * that key (`driver.ts`), because moving it to this socket would rename every
 * tool and orphan every stored approval. See `plugins/latex.ts`.
 *
 * THE ORIGINAL NOTE, still true: It has to be a second function rather
 * than a field on the first because the two halves live in different processes:
 * the worker has no store to resolve capabilities against, so it can build the
 * walls but not the modules. The GATE is read in both places from the same env
 * var, so a plugin cannot be registered on one side and missing on the other.
 */
export function bundledPluginToolModules(env: NodeJS.ProcessEnv = process.env): PluginToolModule[] {
  const modules: PluginToolModule[] = [];
  if (env[HELLO_GATE] === "1") modules.push(helloToolModule);
  return modules;
}

/**
 * THE WALLS THIS PROCESS MAY SERVE. Read from the bundled list at module load,
 * and replaceable — the worker serves what it was built with, and a test
 * installs its own so a proof plugin's wall can be driven without the env gate.
 *
 * It lives beside the list rather than in the driver because the driver no
 * longer registers plugin tools at all: they reach both providers through
 * `plugins/socket.ts`, and the worker is what binds it.
 */
let registered: readonly PluginToolModule[] = bundledPluginToolModules();

export function pluginToolModules(): readonly PluginToolModule[] {
  return registered;
}

export function setPluginToolModules(modules: readonly PluginToolModule[]): void {
  registered = [...modules];
}
