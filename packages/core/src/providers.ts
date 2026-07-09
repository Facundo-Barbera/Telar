// Provider seam: the per-provider knobs that differ between Claude and Codex.
// Everything provider-specific about auth/config wiring lives here so the rest
// of the engine stays provider-neutral. This file is auth/config only — which
// SDK actually drives a turn is layered on top of this in the web app.
import type { AuthMode, ProviderId } from "./schemas";

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  // Env var that relocates this provider's whole config/credential dir.
  // Claude: CLAUDE_CONFIG_DIR (creds in the macOS Keychain, keyed per dir).
  // Codex:  CODEX_HOME (creds in auth.json inside the dir — file-based, portable).
  configDirEnv: string;
  // Which env var carries the credential for each non-subscription auth mode.
  tokenEnvByMode: Partial<Record<AuthMode, string>>;
  // Argv (after the binary) that starts an interactive login for this provider.
  loginArgs: string[];
  // Default config-dir location (home-relative), used to detect existing logins.
  defaultConfigDir: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  claude: {
    id: "claude",
    label: "Claude",
    configDirEnv: "CLAUDE_CONFIG_DIR",
    tokenEnvByMode: {
      "oauth-token": "CLAUDE_CODE_OAUTH_TOKEN", // `claude setup-token`, subscription-billed
      "api-key": "ANTHROPIC_API_KEY", // Console key, API-billed
    },
    loginArgs: ["auth", "login"],
    defaultConfigDir: ".claude",
  },
  codex: {
    id: "codex",
    label: "Codex",
    configDirEnv: "CODEX_HOME",
    tokenEnvByMode: {
      "api-key": "OPENAI_API_KEY", // Codex has no subscription setup-token analogue
    },
    loginArgs: ["login"],
    defaultConfigDir: ".codex",
  },
};

export function providerOf(id?: ProviderId): ProviderDescriptor {
  return PROVIDERS[id ?? "claude"];
}
