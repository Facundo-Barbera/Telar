/**
 * THE PLUGIN'S TOOL WALL, AND WHY IT IS NOT IN `contract.ts`.
 *
 * A plugin's engine module lives in the DAEMON: it holds the runtime, the jobs,
 * the file handles. A plugin's tool wall is registered in the WORKER, a separate
 * process, when a turn's provider query is assembled. So a tool wall that closed
 * over the plugin's runtime could never be registered where tools are actually
 * registered — it would be a function pointing at objects in another process.
 *
 * The existing features already solved this and the plugin host just makes the
 * solution general: `latexTools(tool, capability)` is pure over a CAPABILITY
 * PORT, and the port has two implementations — one over the store (daemon), one
 * over HTTP (worker). This file is that pattern with the plugin id as a
 * parameter, so the transport half is written ONCE instead of once per feature:
 * `pluginCall(client, sessionId, id)` is the only wire any plugin needs.
 *
 * ── ONE BUILDER, EVERY PROVIDER ─────────────────────────────────────────────
 * `tools` is called once per turn per provider mount. That is what makes
 * both-provider parity structural: there is no second list for a second
 * provider to fall out of sync with. What a provider does NOT get is a
 * different question from what it is offered — see the honest note in
 * `driver.ts` about Codex having no in-process `telar` server at all today.
 */
import type { PluginMeta } from "@telar/engine-client";
import type { ToolFactory } from "../tool-kit";

/**
 * The one wire. Every plugin verb is a POST at
 * `/v2/sessions/:id/plugins/:plugin/:verb`, so a plugin's client capability is
 * always this function with the verbs spelled on top of it.
 */
export type PluginCall = <T>(verb: string, body?: unknown) => Promise<T>;

/** `PluginCall` out of an `EngineClient`. The worker's half, and generic. */
export function pluginCall(
  client: { plugin<T>(sessionId: string, pluginId: string, method: string, body?: unknown): Promise<T> },
  sessionId: string,
  pluginId: string,
): PluginCall {
  return <T,>(verb: string, body?: unknown) => client.plugin<T>(sessionId, pluginId, verb, body ?? {});
}

/**
 * The half of a plugin that can be registered anywhere tools are registered.
 * Deliberately tiny: a manifest, a way to make its capability out of the wire,
 * and the wall itself.
 */
export type PluginToolModule = {
  meta: PluginMeta;
  /**
   * The plugin's own capability port, built over the generic transport. Typed as
   * `unknown` here because the host must hold plugins of different shapes in one
   * list; each plugin narrows it in its own `tools`.
   */
  capability(call: PluginCall): unknown;
  tools(tool: ToolFactory, capability: unknown): unknown[];
};
