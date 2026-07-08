import type { AccountProfile } from "@telar/core";
import os from "os";
import path from "path";

// Auth profiles = Claude accounts. "personal" uses the default CLI login.
// "work" points CLAUDE_CONFIG_DIR at a second config dir — log into it once with:
//   CLAUDE_CONFIG_DIR=~/.claude-work claude /login
export const ACCOUNTS: Record<string, AccountProfile> = {
  personal: { name: "personal" },
  work: { name: "work", configDir: path.join(os.homedir(), ".claude-work") },
};
