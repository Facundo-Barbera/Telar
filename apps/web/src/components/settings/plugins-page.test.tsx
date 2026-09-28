// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import type { PluginStatus } from "@telar/engine-client";
import { machinePanePlugins } from "./plugins-page";

const status = (id: string, state: PluginStatus["state"] = "ready"): PluginStatus =>
  ({ meta: { id, name: id, settings: [{ id: "defaults", scope: "machine", label: id }] }, state }) as never;

test("a plugin switched off for this Mac contributes no defaults group", () => {
  const plugins = [status("latex"), status("data-science"), status("broken", "failed")];
  const machine = { version: 1, entries: { latex: { enabled: false } } };
  expect(machinePanePlugins(plugins, machine).map((entry) => entry.meta.id)).toEqual(["data-science"]);
  // No entry at all is allowed, so both running plugins keep their group.
  expect(machinePanePlugins(plugins, undefined).map((entry) => entry.meta.id)).toEqual(["latex", "data-science"]);
});
