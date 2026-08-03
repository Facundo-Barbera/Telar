import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Lightweight settings inspection for presentation only (for example, showing
// that the native Claude instance is routed). Runtime configuration is NOT
// assembled from this allow-list: Claude loads its complete user/project/local
// setting stack itself through the Agent SDK.
export const CLAUDE_RUNTIME_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

type RuntimeKey = (typeof CLAUDE_RUNTIME_ENV_KEYS)[number];

const settingsPath = (): string =>
  process.env.TELAR_CLAUDE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json");

/** Read routing/model values for server-rendered metadata. Never use this to
 * build a Claude subprocess environment; doing so drops unknown native config. */
export function readClaudeRuntimeEnv(): Partial<Record<RuntimeKey, string>> {
  const out: Partial<Record<RuntimeKey, string>> = {};
  for (const key of CLAUDE_RUNTIME_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as {
      env?: Record<string, unknown>;
    };
    for (const key of CLAUDE_RUNTIME_ENV_KEYS) {
      const value = parsed.env?.[key];
      if (typeof value === "string" && value) out[key] = value;
    }
  } catch {
    // Missing or malformed user settings means ordinary direct Claude.
  }
  return out;
}
