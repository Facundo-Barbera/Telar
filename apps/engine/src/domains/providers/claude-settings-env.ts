import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Dropping setting sources also drops the settings file's `env`, which is where a gateway login lives.
export function claudeSettingsEnv(env: Record<string, string | undefined>): Record<string, string> {
  const dir = env["CLAUDE_CONFIG_DIR"] || path.join(os.homedir(), ".claude");
  let settings: unknown;
  try {
    settings = (JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as { env?: unknown } | null)?.env;
  } catch {
    return {};
  }
  if (typeof settings !== "object" || settings === null) return {};
  return Object.fromEntries(Object.entries(settings).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
