/**
 * `LatexCapability` out of `EngineClient` calls — the worker's copy. Every
 * verb lands on a `/v2/sessions/:id/latex/*` route that calls `store.latex()`,
 * so there is one implementation of every rule and the worker runs no TeX.
 */
import type { EngineClient } from "@telar/engine-client";
import type { LatexCapability } from "./capability";

export function clientLatexCapability(client: Pick<EngineClient, "latex">, sessionId: string): LatexCapability {
  const latex = (method: string, body?: unknown) => client.latex<never>(sessionId, method, body);
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
