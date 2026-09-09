import { createOpenCodeDriver } from "./opencode/driver";
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
import { BROWSER_TOOLS, type EngineBrowser } from "./browser";
import { BrowserToolSocket, type BrowserSocketCapability } from "./browser/socket";
import { createCodexDriver } from "./codex-driver";
import { createClaudeDriver, type TurnDriver } from "./driver";
import type { DriverSelector } from "./worker";

/**
 * The engine's browser, narrowed to what the session socket may do with it.
 *
 * ASSEMBLED HERE, ONCE, for both deployments. The drivers never import
 * `./browser` — every driver would then drag Chromium's transport in whether or
 * not a session ever browses — so this is the seam, and having ONE of it is
 * what stops the embedded and standalone workers offering different browsers.
 */
export function browserCapability(browser: EngineBrowser): BrowserSocketCapability {
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
    ...(browser.bindProfile ? { bindProfile: (scopeKey, profileKey) => browser.bindProfile!(scopeKey, profileKey) } : {}),
    ...(browser.profileIdentity ? { profileIdentity: (scopeKey) => browser.profileIdentity!(scopeKey) } : {}),
  };
}

/**
 * The browser socket, from the runtime, through the ONE capability assembly
 * above — same anti-drift argument: two construction sites is how the embedded
 * and standalone workers end up serving different browsers.
 */
export function createBrowserToolSocket(browser: EngineBrowser): BrowserToolSocket {
  return new BrowserToolSocket(browserCapability(browser));
}

/**
 * WHAT CODEX SESSIONS STILL DO NOT GET, STATED WHERE IT IS DECIDED.
 *
 * The BROWSER half of the old gap is CLOSED: it is served by the worker's
 * `BrowserToolSocket` (see `./browser/socket.ts`) and registered with both
 * providers — Claude as an `http` entry in `mcpServers`, Codex through
 * `thread/start`'s `config.mcp_servers` overlay. One transport, both drivers.
 *
 * The SESSIONS wall is closed the same way (`./sessions-tools/run-socket.ts`):
 * a Codex turn is pointed at a worker-hosted socket under `telar-sessions`,
 * with the session's own `self` bound behind the token so subscriptions wake
 * it. Claude deliberately KEEPS its in-process registration under `telar` —
 * one wall, two transports, and the wall itself is the shared piece.
 *
 * The SPOOL and WARP remain in-process Claude SDK servers, so CAP-12 ("items
 * are a Telar-wide substrate reachable from any session") is still TRUE FOR
 * CLAUDE SESSIONS ONLY. A Codex session cannot read or file the user's tasks.
 * It is not silently wrong — the model simply has no such tool and says so —
 * but it is not the contract either. Moving the spool onto a session-scoped
 * socket like the browser's is the remainder of stage I of
 * `docs/spool-port.md`, and it is deliberately not faked here — a Codex
 * session with a spool tool that did nothing would be worse than one without.
 */

export function createDefaultDrivers(): DriverSelector {
  const claude = createClaudeDriver();
  const codex = createCodexDriver();
  const byKind: Record<ProviderDriverKind, TurnDriver> = { claude, codex, opencode: createOpenCodeDriver() };
  // Returns `undefined` for a kind this build does not know, which the worker
  // turns into a typed `provider_unavailable` failure on the turn rather than
  // an unhandled throw.
  return (kind) => byKind[kind];
}
