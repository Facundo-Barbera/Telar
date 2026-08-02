import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude's user settings can describe where the Claude harness sends requests
// and how its native model slots resolve. Telar needs those two pieces so a
// session behaves like `claude` launched in the user's terminal, but it must
// not load the rest of the user tier (hooks, MCP servers, permission grants,
// plugins, and commands). This allow-list is that boundary.
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

/** Read only Claude's runtime-routing/model environment. Values already in
 * the server environment are honored too; settings.json wins, matching the
 * explicit configuration the Claude CLI applies for a normal launch. */
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
