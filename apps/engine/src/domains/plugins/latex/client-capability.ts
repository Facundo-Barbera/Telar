import type { PluginCall } from "../tool-module";
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
