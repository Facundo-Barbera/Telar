import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlanSnapshot } from "@/lib/store";

// Codex records subscription rate limits in its session rollout JSONL as
// `token_count` event_msg payloads carrying `rate_limits: { primary, secondary }`.
//   primary   = the short window   (window_minutes 300  = 5 hours)
//   secondary = the long window    (window_minutes 10080 = 7 days / weekly)
// Reading the newest rollout's last snapshot costs nothing — no turn, no OAuth —
// and mirrors Claude's fiveHour/sevenDay model exactly. It's as fresh as the
// account's last Codex turn (surfaced via the snapshot's capturedAt).

type CodexWindow = { used_percent?: number; window_minutes?: number; resets_at?: number };
type CodexRateLimits = { primary?: CodexWindow | null; secondary?: CodexWindow | null };

function codexHome(configDir?: string): string {
  const dir = configDir || path.join(os.homedir(), ".codex");
  return dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
}

// sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl — the dir names and filenames are
// both zero-padded/timestamped, so lexical sort == chronological. Descend to the
// newest day and return its rollout files newest-first (no full-tree walk).
function newestDayRollouts(sessionsDir: string): string[] {
  const newestChild = (dir: string): string | null => {
    let names: string[];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return null;
    }
    const last = names.at(-1);
    return last ? path.join(dir, last) : null;
  };
  let dir: string | null = sessionsDir;
  for (let i = 0; i < 3 && dir; i++) dir = newestChild(dir); // Y -> M -> D
  if (!dir) return [];
  try {
    // turbopackIgnore: runtime scan of ~/.codex session logs — outside the
    // project; Next's output tracing must not follow it.
    return fs
      .readdirSync(/* turbopackIgnore: true */ dir)
      .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .map((f) => path.join(/* turbopackIgnore: true */ dir as string, f));
  } catch {
    return [];
  }
}

const toWindow = (w?: CodexWindow | null): PlanSnapshot["fiveHour"] =>
  w && typeof w.used_percent === "number"
    ? {
        utilization: Math.round(w.used_percent), // already a 0-100 percentage
        resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
      }
    : null;

// Last rate_limits object in a rollout file, or null if it holds none.
function lastRateLimits(file: string): CodexRateLimits | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let found: CodexRateLimits | null = null;
  for (const line of raw.split("\n")) {
    if (!line.includes("rate_limits")) continue;
    try {
      const rl = JSON.parse(line)?.payload?.rate_limits;
      if (rl && (rl.primary || rl.secondary)) found = rl;
    } catch {
      // skip a malformed line
    }
  }
  return found;
}

export function codexUsageSnapshot(configDir?: string): Partial<PlanSnapshot> | null {
  const sessions = path.join(codexHome(configDir), "sessions");
  // Newest day first; the very newest rollout may be an aborted session with no
  // limits, so fall through to the next until one yields a snapshot.
  for (const file of newestDayRollouts(sessions)) {
    const rl = lastRateLimits(file);
    if (!rl) continue;
    return {
      subscriptionType: "codex",
      fiveHour: toWindow(rl.primary),
      sevenDay: toWindow(rl.secondary),
    };
  }
  return null;
}
