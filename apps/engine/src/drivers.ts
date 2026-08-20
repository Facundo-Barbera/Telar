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
import { BROWSER_TOOLS, type BrowserRuntime } from "./browser";
import { createCodexDriver } from "./codex-driver";
import { createClaudeDriver, type BrowserCapability, type TurnDriver } from "./driver";
import type { DriverSelector } from "./worker";

/**
 * The engine's browser, narrowed to what a driver may do with it.
 *
 * ASSEMBLED HERE, ONCE, for both deployments. The driver must not import
 * `./browser` — every driver would then drag Chromium's transport in whether or
 * not a session ever browses — so this is the seam, and having ONE of it is
 * what stops the embedded and standalone workers offering different browsers.
 */
export function browserCapability(browser: BrowserRuntime): BrowserCapability {
  return {
    call: (scopeKey, name, args) => browser.call(scopeKey, name, args),
    isReadOnly: (name, args) => browser.isReadOnly(name, args),
    tools: BROWSER_TOOLS,
    // `start: false` is the default and is load-bearing: this runs after a
    // navigation, and a state read that could LAUNCH a browser would start one
    // for a session that only ever declined to browse.
    state: async (scopeKey) => {
      const state = await browser.state(scopeKey, { screenshot: false });
      return { provider: state.provider, tabs: state.tabs };
    },
  };
}

export type DefaultDriverOptions = {
  /** Handed to Claude only. The Codex app-server runs its own tooling and has
   *  no seam for an engine-owned browser yet — see `codex-driver.ts`'s header. */
  browser?: BrowserCapability;
};

/**
 * WHAT CODEX SESSIONS DO NOT GET, STATED WHERE IT IS DECIDED.
 *
 * Telar's own toolkits — the browser, and now `spool` — are registered as an
 * IN-PROCESS MCP server through the Claude SDK's `createSdkMcpServer`. The Codex
 * app-server has no equivalent: it accepts MCP servers as CONFIG (a url or a
 * command it launches itself), so an in-process one cannot be handed to it. See
 * `codex-driver.ts`'s `codexMcpServers`, which passes the USER's servers through
 * and has nothing to add ours to.
 *
 * THE CONSEQUENCE IS A REAL, NAMED GAP: CAP-12 says items are a Telar-wide
 * substrate reachable from any session, and today that is TRUE FOR CLAUDE
 * SESSIONS ONLY. A Codex session cannot read or file the user's tasks. It is not
 * silently wrong — the model simply has no such tool and says so — but it is not
 * the contract either.
 *
 * CLOSING IT IS ONE PIECE OF WORK FOR BOTH TOOLKITS: expose the engine's own
 * tools over a transport Codex can be pointed at (`-c mcp_servers.telar.url=…`),
 * at which point the browser lands with the spool. That is stage I of
 * `docs/spool-port.md`, and it is deliberately not faked here — a Codex session
 * with a spool tool that did nothing would be worse than one without.
 */

export function createDefaultDrivers(options: DefaultDriverOptions = {}): DriverSelector {
  const claude = createClaudeDriver(undefined, options.browser ? { browser: options.browser } : {});
  const codex = createCodexDriver();
  const byKind: Record<ProviderDriverKind, TurnDriver> = { claude, codex };
  // Returns `undefined` for a kind this build does not know, which the worker
  // turns into a typed `provider_unavailable` failure on the turn rather than
  // an unhandled throw.
  return (kind) => byKind[kind];
}
