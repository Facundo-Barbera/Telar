import type { AccountProfile } from "@telar/core";
import os from "os";
import path from "path";

// A configured account plus display-only metadata. `displayTier` is a purely
// cosmetic label (e.g. "5x" / "20x") shown beside the plan badge in the sidebar
// — there's no API to detect the Max multiplier, so it's filled in by hand and
// left undefined until then.
export type AccountEntry = AccountProfile & { displayTier?: string };

// Auth profiles = Claude accounts. "personal" uses the default CLI login.
// "work" points CLAUDE_CONFIG_DIR at a second config dir — log into it once with:
//   CLAUDE_CONFIG_DIR=~/.claude-work claude /login
export const ACCOUNTS: Record<string, AccountEntry> = {
  personal: { name: "personal" },
  work: { name: "work", configDir: path.join(os.homedir(), ".claude-work") },
};
