/**
 * THE CONVERSION IS THE RISKY PART, because it is arithmetic that has to agree
 * with a CLI that is not in this repo.
 *
 * The threshold Claude Code fires at, read out of the installed binary:
 *
 *     effective = window − min(the model's max output tokens, 20 000)
 *     threshold = min(floor(effective × pct / 100), effective − 13 000)
 *
 * `cliThreshold` below is that formula, written out once. Every "does N% land
 * on N% of the window" case runs the pair the driver is spawned with THROUGH it
 * rather than asserting the strings look right.
 */
import { describe, expect, test } from "bun:test";
import {
  applyClaudeCompaction,
  claudeCompactionEnvFor,
  claudeCompactionOf,
  CLAUDE_COMPACTION_DISABLE_ENV,
  CLAUDE_COMPACTION_PERCENT_ENV,
  CLAUDE_COMPACTION_WINDOW_ENV,
  migrateClaudeCompaction,
  type ProviderInstanceEnvVar,
} from "../src/index";

const plain = (name: string, value: string): ProviderInstanceEnvVar => ({ name, value, sensitive: false });

/** What the installed CLI computes from its environment on a model with this
 *  window. No declared window means the model's own. */
function cliThreshold(env: Record<string, string>, modelWindow: number, maxOutputTokens = 32_000): number {
  const declared = env[CLAUDE_COMPACTION_WINDOW_ENV];
  const window = declared === undefined ? modelWindow : Math.min(modelWindow, Math.max(100_000, Math.min(Number(declared), 1_000_000)));
  const effective = window - Math.min(maxOutputTokens, 20_000);
  const raw = env[CLAUDE_COMPACTION_PERCENT_ENV];
  const pct = raw === undefined ? undefined : Number.parseFloat(raw);
  const byWindow = effective - 13_000;
  return pct !== undefined && pct > 0 && pct <= 100 ? Math.min(Math.floor((effective * pct) / 100), byWindow) : byWindow;
}

const stored = (percent: number) => applyClaudeCompaction([], { mode: "percent", percent })!;

describe("a percentage of the model's window", () => {
  test("the login stores the percentage alone", () => {
    expect(stored(80)).toEqual([plain(CLAUDE_COMPACTION_PERCENT_ENV, "80")]);
    expect(claudeCompactionOf(stored(80))).toEqual({ mode: "percent", percent: 80 });
  });

  test("the spawned pair lands on exactly that share of a 200k and a 1M window", () => {
    for (const window of [200_000, 1_000_000]) {
      for (const percent of [1, 25, 50, 75, 80]) {
        const env = claudeCompactionEnvFor(stored(percent), window)!;
        for (const maxOutputTokens of [20_000, 32_000, 64_000]) {
          expect(cliThreshold(env, window, maxOutputTokens)).toBe((window * percent) / 100);
        }
      }
    }
  });

  test("past the CLI's own summary buffer, the buffer wins — earlier, never later", () => {
    const env = claudeCompactionEnvFor(stored(100), 200_000)!;
    expect(Number(env[CLAUDE_COMPACTION_PERCENT_ENV])).toBeLessThanOrEqual(100);
    expect(cliThreshold(env, 200_000)).toBe(167_000);
  });

  test("an unknown window, or no percentage, leaves the login's rows alone", () => {
    expect(claudeCompactionEnvFor(stored(80), undefined)).toBeUndefined();
    expect(claudeCompactionEnvFor([], 200_000)).toBeUndefined();
    expect(claudeCompactionEnvFor(applyClaudeCompaction([], { mode: "never" })!, 200_000)).toBeUndefined();
  });

  test("a percentage outside 1–100, or fractional, is refused", () => {
    for (const percent of [0, -1, 101, 1.5, Number.NaN]) {
      expect(applyClaudeCompaction([], { mode: "percent", percent })).toBeNull();
    }
  });
});

describe("the other two states", () => {
  test("Default writes no keys, rather than empty ones", () => {
    expect(applyClaudeCompaction(stored(80), { mode: "default" })).toEqual([]);
    expect(claudeCompactionOf([])).toEqual({ mode: "default" });
  });

  test("Never writes the one spelling the CLI accepts", () => {
    expect(applyClaudeCompaction(stored(80), { mode: "never" })).toEqual([plain(CLAUDE_COMPACTION_DISABLE_ENV, "1")]);
  });

  test("a value the CLI ignores is read as absent, not as off", () => {
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_DISABLE_ENV, "0")])).toEqual({ mode: "default" });
    for (const spelling of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_DISABLE_ENV, spelling)])).toEqual({ mode: "never" });
    }
  });

  test("a window row or a fractional percentage is not something the control states", () => {
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_WINDOW_ENV, "200000")])).toBeUndefined();
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_PERCENT_ENV, "40.5")])).toBeUndefined();
  });

  test("the control owns its rows and touches nothing else", () => {
    const env = [plain("ANTHROPIC_BASE_URL", "https://example.test"), plain(CLAUDE_COMPACTION_DISABLE_ENV, "1")];
    expect(applyClaudeCompaction(env, { mode: "percent", percent: 70 })).toEqual([
      plain("ANTHROPIC_BASE_URL", "https://example.test"),
      plain(CLAUDE_COMPACTION_PERCENT_ENV, "70"),
    ]);
  });
});

describe("migrating a pre-#587 token threshold", () => {
  test("the old pair becomes its share of the window, rounded down", () => {
    // 150 000 tokens, as the old control wrote it.
    const old = [plain(CLAUDE_COMPACTION_WINDOW_ENV, "183000"), plain(CLAUDE_COMPACTION_PERCENT_ENV, "100")];
    expect(migrateClaudeCompaction(old, 200_000)).toEqual([plain(CLAUDE_COMPACTION_PERCENT_ENV, "75")]);
    expect(migrateClaudeCompaction(old, 1_000_000)).toEqual([plain(CLAUDE_COMPACTION_PERCENT_ENV, "15")]);
    // 120 000 tokens: 60%.
    const pair = [plain(CLAUDE_COMPACTION_WINDOW_ENV, "153000"), plain(CLAUDE_COMPACTION_PERCENT_ENV, "90.225564")];
    expect(migrateClaudeCompaction(pair, 200_000)).toEqual([plain(CLAUDE_COMPACTION_PERCENT_ENV, "60")]);
  });

  test("clamped to 1–100%", () => {
    expect(migrateClaudeCompaction([plain(CLAUDE_COMPACTION_WINDOW_ENV, "1000000")], 200_000)).toEqual([
      plain(CLAUDE_COMPACTION_PERCENT_ENV, "100"),
    ]);
    // 1 token, as the old control could write it.
    const tiny = [plain(CLAUDE_COMPACTION_WINDOW_ENV, "100000"), plain(CLAUDE_COMPACTION_PERCENT_ENV, "0.00125")];
    expect(migrateClaudeCompaction(tiny, 200_000)).toEqual([plain(CLAUDE_COMPACTION_PERCENT_ENV, "1")]);
  });

  test("Never stays Never; nothing to migrate is undefined; other rows keep their place", () => {
    const never = [plain(CLAUDE_COMPACTION_WINDOW_ENV, "183000"), plain(CLAUDE_COMPACTION_DISABLE_ENV, "1")];
    expect(migrateClaudeCompaction(never, 200_000)).toEqual([plain(CLAUDE_COMPACTION_DISABLE_ENV, "1")]);
    expect(migrateClaudeCompaction(stored(80), 200_000)).toBeUndefined();
    expect(migrateClaudeCompaction([], 200_000)).toBeUndefined();
    const mixed = [plain("A", "1"), plain(CLAUDE_COMPACTION_WINDOW_ENV, "183000"), plain("B", "2")];
    expect(migrateClaudeCompaction(mixed, 200_000)).toEqual([plain("A", "1"), plain("B", "2"), plain(CLAUDE_COMPACTION_PERCENT_ENV, "75")]);
  });

  test("a window row the CLI would ignore migrates to Default", () => {
    expect(migrateClaudeCompaction([plain(CLAUDE_COMPACTION_WINDOW_ENV, "lots")], 200_000)).toEqual([]);
  });
});
