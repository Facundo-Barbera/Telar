import type { PluginMeta } from "@telar/engine-client";
import type { ToolFactory } from "../agent-tools";

export type PluginCall = <T>(verb: string, body?: unknown) => Promise<T>;

export function pluginCall(
  client: { plugin<T>(sessionId: string, pluginId: string, method: string, body?: unknown): Promise<T> },
  sessionId: string,
  pluginId: string,
): PluginCall {
  return <T,>(verb: string, body?: unknown) => client.plugin<T>(sessionId, pluginId, verb, body ?? {});
}

export type PluginToolModule = {
  meta: PluginMeta;
  capability(call: PluginCall): unknown;
  tools(tool: ToolFactory, capability: unknown): unknown[];
};
