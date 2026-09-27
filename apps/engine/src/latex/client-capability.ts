/**
 * `LatexCapability` over the generic plugin wire — the worker's copy. Every
 * verb lands on `/v2/sessions/:id/plugins/latex/*`, whose route table calls
 * `store.latex()`, so there is one implementation of every rule and the worker
 * runs no TeX.
 */
import type { PluginCall } from "../plugins/tool-module";
import type { LatexCapability } from "./capability";

export function clientLatexCapability(call: PluginCall): LatexCapability {
  const latex = (method: string, body?: unknown) => call<never>(method, body);
  return {
    toolchain: () => latex("toolchain"),
    compile: (input) => latex("compile", input ?? {}),
    status: () => latex("status"),
    log: (input) => latex("log", input ?? {}),
    packages: () => latex("packages"),
    install: (input) => latex("install", input),
    clean: (input) => latex("clean", input ?? {}),
  };
}
