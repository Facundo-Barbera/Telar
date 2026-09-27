/**
 * `DsCapability` over the generic plugin wire — the worker's copy. Every verb
 * lands on `/v2/sessions/:id/plugins/data-science/*`, whose route table calls
 * `store.dataScience()`, so there is one implementation of every rule and the
 * worker holds no kernel.
 */
import type { PluginCall } from "../plugins/tool-module";
import type { DsCapability } from "./capability";

export function clientDsCapability(call: PluginCall): DsCapability {
  const ds = (method: string, body?: unknown) => call<never>(method, body);
  return {
    kernel: () => ds("kernel"),
    execute: (input) => ds("execute", input),
    interrupt: () => ds("interrupt", {}).then(() => undefined),
    restart: () => ds("restart", {}).then(() => undefined),
    vars: (limit) => ds("vars", { limit }),
    inspect: (name, depth) => ds("inspect", { name, depth }),
    notebookRead: (path, options) => ds("notebook/read", { path, ...options }),
    notebookEdit: (path, edit) => ds("notebook/edit", { path, edit }),
    notebookRun: (path, input) => ds("notebook/run", { path, ...input }),
    plot: (input) => ds("plot", input),
    snapshot: (name, vars) => ds("snapshot", { name, vars }),
    snapshots: () => ds("snapshots"),
    diff: (from, to) => ds("diff", { from, to }),
    checkpoint: (input) => ds("checkpoint", input),
    lineage: (of) => ds("lineage", { of }),
    watches: () => ds("watches"),
    watch: (input) => ds("watch", input),
    experiment: (input) => ds("experiment", input),
    environment: (input) => ds("env", input ?? {}),
    packages: () => ds("packages"),
    install: (input) => ds("install", input),
  };
}
