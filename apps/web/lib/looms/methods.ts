import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoomPhase } from "./store";

/**
 * Method packs — docs/method-contract-v0.md, v0.1.
 *
 * A method is DATA: a phase graph the machine walks, where each phase is a
 * skill invocation (provider-native) behind a gate. The built-in `weave` is
 * the current weaver behaviour expressed as data — the proof that the machine
 * no longer hardcodes a method, only ships one.
 *
 * User packs live machine-side (`~/.telar/methods/<name>/method.json`),
 * never in a repo: definitions are sidecar-only, artifacts are committable.
 * v0 knowingly implements the subset the weave method needs (plan → execute,
 * parallel, per-unit workspaces); sequential/shared and skill provisioning
 * are specified in the contract and land with the bmad pack.
 */

export interface MethodPhaseSpec {
  id: string;
  kind: "plan" | "execute";
  gate: "human" | "none";
  /** Provider-native skill to invoke for this phase, when it is not the
   *  machine's built-in weaver. Unused by `weave`; the bmad pack fills it. */
  skill?: string;
}

export interface Method {
  name: string;
  phases: MethodPhaseSpec[];
}

export const WEAVE: Method = {
  name: "weave",
  phases: [
    { id: "plan", kind: "plan", gate: "human" },
    { id: "execute", kind: "execute", gate: "none" },
  ],
};

export function loadMethod(name: string): Method {
  const home = process.env.TELAR_HOME ?? join(homedir(), ".telar");
  const path = join(home, "methods", name, "method.json");
  if (existsSync(path)) {
    const method = JSON.parse(readFileSync(path, "utf8")) as Method;
    if (method.name && Array.isArray(method.phases)) return method;
  }
  if (name === "weave") return WEAVE;
  throw new Error(`no method pack "${name}" — expected ${path}`);
}

/**
 * A fresh loom's phase state from a method: the plan phase is DONE (the
 * weaver already ran to produce the proposal) and everything after the first
 * human gate is parked. The execute phase always parks behind the approval
 * gate regardless of its own declared gate — spawning agents is never
 * gate-free until standing orders exist.
 */
export function initialPhases(method: Method): LoomPhase[] {
  return method.phases.map((p) => ({
    id: p.id,
    kind: p.kind,
    gate: p.kind === "execute" ? "human" : p.gate,
    status: p.kind === "plan" ? "done" : "waiting",
    at: Date.now(),
  }));
}
