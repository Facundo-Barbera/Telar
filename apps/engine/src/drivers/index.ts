import type { ProviderDriverKind } from "@telar/engine-client";
import { BROWSER_TOOLS, BrowserToolSocket, type BrowserSocketCapability, type EngineBrowser } from "../domains/browser";
import { createClaudeDriver } from "./claude";
import type { DriverSelector } from "../worker";
import { createCodexDriver } from "./codex";
import type { TurnDriver } from "./contract";
import { createOpenCodeDriver } from "./opencode";

export {
  normalizeOutcome,
  ProviderUnavailableError,
  type DriverRequest,
  type DriverRequestOutcome,
  type DriverResult,
  type DriverRun,
  type DriverSessionHooks,
  type ProviderTurnBinding,
  type SessionsCapability,
  type TurnDriver,
} from "./contract";

// One factory for both worker deployments, so the embedded and out-of-process workers can't drift in what they offer.

function browserCapability(browser: EngineBrowser): BrowserSocketCapability {
  return {
    call: (scopeKey, name, args) => browser.call(scopeKey, name, args),
    isReadOnly: (name, args) => browser.isReadOnly(name, args),
    tools: BROWSER_TOOLS,
    state: async (scopeKey) => {
      const state = await browser.state(scopeKey, { screenshot: false });
      return { provider: state.provider, tabs: state.tabs };
    },
    ...(browser.bindProfile ? { bindProfile: (scopeKey, profileKey) => browser.bindProfile!(scopeKey, profileKey) } : {}),
    ...(browser.profileIdentity ? { profileIdentity: (scopeKey) => browser.profileIdentity!(scopeKey) } : {}),
  };
}

export function createBrowserToolSocket(browser: EngineBrowser): BrowserToolSocket {
  return new BrowserToolSocket(browserCapability(browser));
}

export function createDefaultDrivers(): DriverSelector {
  const claude = createClaudeDriver();
  const codex = createCodexDriver();
  const byKind: Record<ProviderDriverKind, TurnDriver> = { claude, codex, opencode: createOpenCodeDriver() };
  return (kind) => byKind[kind];
}
