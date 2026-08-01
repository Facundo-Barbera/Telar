import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlanSnapshot, PlanWindow } from "@/lib/store";

// Codex records subscription rate limits in its session rollout JSONL as
// `token_count` event_msg payloads carrying
// `rate_limits: { primary, secondary, plan_type, credits, … }`.
// Reading the newest rollout's last snapshot costs nothing — no turn, no OAuth —
// and maps onto Claude's fiveHour/sevenDay model. It's as fresh as the account's
// last Codex turn (surfaced via the snapshot's capturedAt).
//
// PRIMARY/SECONDARY ARE POSITIONS, NOT WINDOWS — this is the whole point of the
// classifier below, and it is measured against real rollouts in ~/.codex:
//
//   2026-04-18   primary = 300 min (5h)     secondary = 10080 min (weekly)
//   2026-07-08   primary = 300 min (5h)     secondary = 10080 min (weekly)
//   2026-07-20   primary = 10080 min        secondary = null
//   2026-07-31   primary = 10080 min        secondary = null
//
// Somewhere between 8 and 20 July the 5-hour limit went away and the WEEKLY
// window moved into the primary slot. Reading `primary` as "the 5-hour window"
// — which this file used to do — therefore renders a weekly figure under a
// 5-hour label: not a missing meter, a WRONG one. So nothing here reads a
// position. Each window is classified by its own `window_minutes`, which means
// the same code covers both regimes and covers a revert (or a third shape)
// without an edit: whichever windows exist are placed by their real duration,
// and a window that does not exist is simply absent.

type CodexWindow = { used_percent?: number; window_minutes?: number; resets_at?: number };
type CodexCredits = { has_credits?: boolean; unlimited?: boolean; balance?: string };
type CodexRateLimits = {
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  plan_type?: string | null;
  credits?: CodexCredits | null;
};

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

const toWindow = (w?: CodexWindow | null): PlanWindow | null =>
  w && typeof w.used_percent === "number"
    ? {
        utilization: Math.round(w.used_percent), // already a 0-100 percentage
        resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
        // Carried through so the UI can LABEL the meter with the window it
        // actually is, instead of trusting the slot it landed in.
        windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
      }
    : null;

// A day. The boundary between "the short rolling window" (5h today, whatever it
// becomes tomorrow) and "the long one" (weekly). A threshold rather than an
// equality test on 300/10080 so a provider tweak to either duration keeps
// landing in the right meter instead of vanishing.
const LONG_WINDOW_MIN = 24 * 60;

// Place each window by its own duration. Windows with no `window_minutes` fall
// back to their historical positions (primary = short, secondary = long), which
// is the only thing left to go on and matches every rollout that predates the
// field. Two windows of the same class can't both win: the first one placed
// keeps the slot, so a malformed pair degrades to one honest meter.
export function classifyCodexWindows(rl: CodexRateLimits): {
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
} {
  let fiveHour: PlanWindow | null = null;
  let sevenDay: PlanWindow | null = null;
  const place = (w: PlanWindow | null, fallbackLong: boolean) => {
    if (!w) return;
    const long = w.windowMinutes == null ? fallbackLong : w.windowMinutes >= LONG_WINDOW_MIN;
    if (long) sevenDay ??= w;
    else fiveHour ??= w;
  };
  place(toWindow(rl.primary), false);
  place(toWindow(rl.secondary), true);
  return { fiveHour, sevenDay };
}

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
    const { fiveHour, sevenDay } = classifyCodexWindows(rl);
    return {
      // The real plan id ("plus" | "prolite" | …) when Codex reports one. This
      // used to be the literal string "codex", which named the provider rather
      // than the subscription and told the plan badge nothing.
      subscriptionType: rl.plan_type ?? null,
      fiveHour,
      sevenDay,
      credits: rl.credits
        ? {
            hasCredits: rl.credits.has_credits ?? false,
            unlimited: rl.credits.unlimited ?? false,
            balance: rl.credits.balance ?? null,
          }
        : null,
    };
  }
  return null;
}
