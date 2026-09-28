import type { AutoCompact, ProviderInstanceEnvVar } from "./schema";

/** A model's window class: `standard` is the ~200k–400k family, `long` 1M. */
type ContextClass = "standard" | "long";

export function contextClassOf(window: number): ContextClass {
  return window >= 500_000 ? "long" : "standard";
}

export const AUTO_COMPACT_DEFAULTS = { standard: 150_000, long: 400_000 } as const;

export function autoCompactLimitFor(limits: { standard: number; long: number }, window: number | undefined): number {
  return window !== undefined && contextClassOf(window) === "long" ? limits.long : limits.standard;
}

export const CLAUDE_COMPACTION_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
export const CLAUDE_COMPACTION_PERCENT_ENV = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
export const CLAUDE_COMPACTION_DISABLE_ENV = "DISABLE_AUTO_COMPACT";
export const CLAUDE_COMPACTION_ENV_NAMES: readonly string[] = [
  CLAUDE_COMPACTION_WINDOW_ENV,
  CLAUDE_COMPACTION_PERCENT_ENV,
  CLAUDE_COMPACTION_DISABLE_ENV,
];

const OUTPUT_RESERVE = 20_000;
const SUMMARY_BUFFER = 13_000;
const WINDOW_FLOOR = 100_000;
const WINDOW_CEILING = 1_000_000;
const CLAUDE_MAX_TOKENS = WINDOW_CEILING - OUTPUT_RESERVE - SUMMARY_BUFFER;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function boundedWindow(declared: number): number {
  return Math.max(WINDOW_FLOOR, Math.min(declared, WINDOW_CEILING));
}

export function claudeCompactionEnv(autoCompact: AutoCompact | undefined, window: number | undefined): Record<string, string | undefined> | undefined {
  if (!autoCompact) return undefined;
  if (autoCompact.mode === "never") return { [CLAUDE_COMPACTION_DISABLE_ENV]: "1" };
  const tokens = Math.min(autoCompactLimitFor(autoCompact, window), CLAUDE_MAX_TOKENS);
  const declared = boundedWindow(tokens + OUTPUT_RESERVE + SUMMARY_BUFFER);
  const percent = Math.ceil((tokens / (declared - OUTPUT_RESERVE)) * 100 * 1e6) / 1e6;
  return {
    [CLAUDE_COMPACTION_WINDOW_ENV]: String(declared),
    [CLAUDE_COMPACTION_PERCENT_ENV]: String(percent),
    [CLAUDE_COMPACTION_DISABLE_ENV]: undefined,
  };
}

export function migrateClaudeCompaction(
  env: readonly ProviderInstanceEnvVar[],
): { env: ProviderInstanceEnvVar[]; autoCompact?: AutoCompact } | undefined {
  if (!env.some((variable) => CLAUDE_COMPACTION_ENV_NAMES.includes(variable.name))) return undefined;
  const byName = new Map(env.map((variable) => [variable.name, variable.value]));
  const kept = env.filter((variable) => !CLAUDE_COMPACTION_ENV_NAMES.includes(variable.name));
  if (TRUTHY.has((byName.get(CLAUDE_COMPACTION_DISABLE_ENV) ?? "").trim().toLowerCase())) {
    return { env: kept, autoCompact: { mode: "never" } };
  }
  const rawWindow = byName.get(CLAUDE_COMPACTION_WINDOW_ENV)?.trim() ?? "";
  if (!/^\d+$/.test(rawWindow) || Number(rawWindow) <= 0) return { env: kept };
  const effective = boundedWindow(Number(rawWindow)) - OUTPUT_RESERVE;
  const byWindow = effective - SUMMARY_BUFFER;
  const rawPercent = Number.parseFloat(byName.get(CLAUDE_COMPACTION_PERCENT_ENV)?.trim() ?? "");
  const tokens =
    Number.isFinite(rawPercent) && rawPercent > 0 && rawPercent <= 100 ? Math.min(Math.floor((effective * rawPercent) / 100), byWindow) : byWindow;
  return { env: kept, autoCompact: { mode: "limits", standard: Math.max(1, tokens), long: Math.max(AUTO_COMPACT_DEFAULTS.long, tokens) } };
}
