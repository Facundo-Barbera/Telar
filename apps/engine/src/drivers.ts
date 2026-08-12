/**
 * The one place that says which provider driver serves which session.
 *
 * WHY THIS IS A MODULE RATHER THAN TWO LITERALS: there are two worker
 * deployments — the daemon's embedded worker and `worker-main.ts` — and they
 * have already diverged once in exactly this way. The out-of-process worker
 * shipped with no browser at all while the embedded one had it, so what the
 * agent could DO depended on how the engine happened to be started, silently.
 * A shared factory makes that class of drift impossible rather than merely
 * unlikely.
 *
 * BOTH DRIVERS ARE BUILT EAGERLY and neither touches its provider at
 * construction: `createClaudeDriver` defers `import()` of the SDK to the first
 * run, and `createCodexDriver` resolves its binary inside `run()`. So a
 * deployment with no Codex installed pays nothing for offering it, and a
 * session that asks for it fails as `provider_unavailable` — the honest answer
 * — rather than being refused a driver up front.
 */
import type { ProviderDriverKind } from "@telar/engine-client";
import { createCodexDriver } from "./codex-driver";
import { createClaudeDriver, type BrowserCapability, type TurnDriver } from "./driver";
import type { DriverSelector } from "./worker";

export type DefaultDriverOptions = {
  /** Handed to Claude only. The Codex app-server runs its own tooling and has
   *  no seam for an engine-owned browser yet — see `codex-driver.ts`'s header. */
  browser?: BrowserCapability;
};

export function createDefaultDrivers(options: DefaultDriverOptions = {}): DriverSelector {
  const claude = createClaudeDriver(undefined, options.browser ? { browser: options.browser } : {});
  const codex = createCodexDriver();
  const byKind: Record<ProviderDriverKind, TurnDriver> = { claude, codex };
  // Returns `undefined` for a kind this build does not know, which the worker
  // turns into a typed `provider_unavailable` failure on the turn rather than
  // an unhandled throw.
  return (kind) => byKind[kind];
}
