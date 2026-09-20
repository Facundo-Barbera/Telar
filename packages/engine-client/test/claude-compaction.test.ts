/**
 * THE CONVERSION IS THE RISKY PART, because it is arithmetic that has to agree
 * with a CLI that is not in this repo.
 *
 * The threshold Claude Code fires at, read out of the installed binary:
 *
 *     effective = window − min(the model's max output tokens, 20 000)
 *     threshold = min(floor(effective × pct / 100), effective − 13 000)
 *
 * `cliThreshold` below is that formula, written out once. Every "does N land on
 * N" case runs the pair this module emits THROUGH it rather than asserting the
 * two strings look right — a pair of plausible-looking variables that computes
 * to the wrong number is exactly the failure a string assertion cannot see.
 *
 * The four cases the issue asked for are each named, plus the two that make the
 * control and a hand-typed variable one mechanism rather than two.
 */
import { describe, expect, test } from "bun:test";
import {
  applyClaudeCompaction,
  claudeCompactionOf,
  claudeCompactionWindowFor,
  CLAUDE_COMPACTION_DISABLE_ENV,
  CLAUDE_COMPACTION_MAX_TOKENS,
  CLAUDE_COMPACTION_PERCENT_ENV,
  CLAUDE_COMPACTION_WINDOW_ENV,
  type ProviderInstanceEnvVar,
} from "../src/index";

const plain = (name: string, value: string): ProviderInstanceEnvVar => ({ name, value, sensitive: false });

/** What the installed CLI computes from a declared window and percentage, with
 *  the model's own window as the thing it clamps against. */
function cliThreshold(env: readonly ProviderInstanceEnvVar[], modelWindow: number, maxOutputTokens = 32_000): number {
  const byName = new Map(env.map((variable) => [variable.name, variable.value]));
  const declared = Number(byName.get(CLAUDE_COMPACTION_WINDOW_ENV));
  const bounded = Math.max(100_000, Math.min(declared, 1_000_000));
  const window = Math.min(modelWindow, bounded);
  const effective = window - Math.min(maxOutputTokens, 20_000);
  const raw = byName.get(CLAUDE_COMPACTION_PERCENT_ENV);
  const pct = raw === undefined ? undefined : Number.parseFloat(raw);
  const byWindow = effective - 13_000;
  return pct !== undefined && pct > 0 && pct <= 100 ? Math.min(Math.floor((effective * pct) / 100), byWindow) : byWindow;
}

describe("the four states of a Claude login's compaction", () => {
  test("N tokens produces a pair the CLI computes back to exactly N", () => {
    // Spread across the two regimes the conversion has: below ~67 000 the CLI's
    // own 100 000 window floor means the percentage carries the number, above it
    // the window does and the percentage agrees.
    for (const tokens of [1, 5_000, 30_000, 66_999, 67_000, 67_001, 100_000, 150_000, 512_345, CLAUDE_COMPACTION_MAX_TOKENS]) {
      const env = applyClaudeCompaction([], { mode: "after", tokens });
      expect(env).not.toBeNull();
      expect(cliThreshold(env!, 1_000_000)).toBe(tokens);
    }
  });

  test("Default writes NO keys, rather than empty ones", () => {
    const configured = applyClaudeCompaction([], { mode: "after", tokens: 150_000 })!;
    const cleared = applyClaudeCompaction(configured, { mode: "default" })!;
    expect(cleared).toEqual([]);
    // The distinction that matters: an empty string is a value the CLI reads.
    expect(cleared.some((variable) => variable.value === "")).toBeFalse();
  });

  test("Never compact writes the one spelling the CLI actually accepts", () => {
    const env = applyClaudeCompaction([], { mode: "never" })!;
    expect(env).toEqual([{ name: CLAUDE_COMPACTION_DISABLE_ENV, value: "1", sensitive: false }]);
    // ...and leaves no window behind to fight with it.
    expect(env.some((variable) => variable.name === CLAUDE_COMPACTION_WINDOW_ENV)).toBeFalse();
  });

  test("no model window enters the conversion, so none is fabricated", () => {
    // The pair is a function of N alone. This is the whole reason the setting
    // can be honoured on the FIRST turn of a session: it does not wait to learn
    // a window from the provider's first reply, and it does not assume one.
    const env = applyClaudeCompaction([], { mode: "after", tokens: 150_000 })!;
    // Every model Claude Code runs reserves the full 20 000 for its reply, so
    // the number lands wherever the session goes...
    for (const maxOutputTokens of [32_000, 64_000, 20_000]) {
      expect(cliThreshold(env, 1_000_000, maxOutputTokens)).toBe(150_000);
    }
    // ...including a 200 000-token model, which still has room for it: the
    // declared window is N + 33 000, so anything up to that model's own window
    // minus 33 000 lands exactly.
    expect(cliThreshold(env, 200_000)).toBe(150_000);
    // Past that, the CLI clamps to the model's own window and compacts EARLIER —
    // never later, and never at a number this module invented.
    const tooBig = applyClaudeCompaction([], { mode: "after", tokens: 500_000 })!;
    expect(cliThreshold(tooBig, 200_000)).toBeLessThan(500_000);
    expect(cliThreshold(tooBig, 1_000_000)).toBe(500_000);
  });

  test("the window it declares is also the smallest model the number lands on", () => {
    // Which is the sentence the card prints, so it is computed once.
    expect(claudeCompactionWindowFor(150_000)).toBe(183_000);
    // Under the CLI's own 100 000 floor the declared window is RAISED, so the
    // model a small threshold needs is 100 000 rather than N + 33 000 — the
    // reason the card asks this rather than adding the two constants itself.
    expect(claudeCompactionWindowFor(30_000)).toBe(100_000);
    expect(claudeCompactionWindowFor(CLAUDE_COMPACTION_MAX_TOKENS)).toBe(1_000_000);
  });

  test("a threshold larger than the CLI's own ceiling is refused, not clamped", () => {
    expect(applyClaudeCompaction([], { mode: "after", tokens: CLAUDE_COMPACTION_MAX_TOKENS + 1 })).toBeNull();
    expect(applyClaudeCompaction([], { mode: "after", tokens: 0 })).toBeNull();
    expect(applyClaudeCompaction([], { mode: "after", tokens: -1 })).toBeNull();
    expect(applyClaudeCompaction([], { mode: "after", tokens: 1.5 })).toBeNull();
    expect(applyClaudeCompaction([], { mode: "after", tokens: Number.NaN })).toBeNull();
  });
});

describe("a hand-typed variable and the control are one mechanism", () => {
  test("what the control writes is what it reads back", () => {
    for (const tokens of [1, 30_000, 67_000, 150_000, CLAUDE_COMPACTION_MAX_TOKENS]) {
      expect(claudeCompactionOf(applyClaudeCompaction([], { mode: "after", tokens })!)).toEqual({ mode: "after", tokens });
    }
    expect(claudeCompactionOf(applyClaudeCompaction([], { mode: "never" })!)).toEqual({ mode: "never" });
    expect(claudeCompactionOf([])).toEqual({ mode: "default" });
  });

  test("a window somebody typed by hand reads back as the number it really produces", () => {
    // Nothing here was written by the control: this is the pair as a person
    // would type it, and the answer is the CLI's own arithmetic over it.
    const env = [plain(CLAUDE_COMPACTION_WINDOW_ENV, "200000")];
    expect(claudeCompactionOf(env)).toEqual({ mode: "after", tokens: 200_000 - 20_000 - 13_000 });
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_WINDOW_ENV, "200000"), plain(CLAUDE_COMPACTION_PERCENT_ENV, "50")])).toEqual({
      mode: "after",
      tokens: 90_000,
    });
    // Below the CLI's floor the declared window is raised, and the read-back
    // says what the login will really do rather than what the row says.
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_WINDOW_ENV, "50000")])).toEqual({ mode: "after", tokens: 67_000 });
  });

  test("a value the CLI ignores is read as absent, not as off", () => {
    // `DISABLE_AUTO_COMPACT=0` does not disable anything and does not enable
    // anything either; the CLI carries on as though it were not set.
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_DISABLE_ENV, "0")])).toEqual({ mode: "default" });
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_DISABLE_ENV, "false")])).toEqual({ mode: "default" });
    for (const spelling of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_DISABLE_ENV, spelling)])).toEqual({ mode: "never" });
    }
  });

  test("a percentage with no window states nothing, because there is nothing to state", () => {
    // The denominator is then whatever model the session runs, which this
    // cannot know. `undefined` is the honest answer; a number would be invented.
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_PERCENT_ENV, "40")])).toBeUndefined();
    expect(claudeCompactionOf([plain(CLAUDE_COMPACTION_WINDOW_ENV, "two hundred thousand")])).toBeUndefined();
  });

  test("the control owns three rows and touches nothing else", () => {
    const env = [plain("ANTHROPIC_BASE_URL", "https://example.test"), plain(CLAUDE_COMPACTION_DISABLE_ENV, "1")];
    const next = applyClaudeCompaction(env, { mode: "after", tokens: 150_000 })!;
    expect(next[0]).toEqual(plain("ANTHROPIC_BASE_URL", "https://example.test"));
    expect(next.map((variable) => variable.name)).toEqual([
      "ANTHROPIC_BASE_URL",
      CLAUDE_COMPACTION_WINDOW_ENV,
      CLAUDE_COMPACTION_PERCENT_ENV,
    ]);
  });
});
