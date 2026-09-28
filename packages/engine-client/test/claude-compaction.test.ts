import { describe, expect, test } from "bun:test";
import {
  AUTO_COMPACT_DEFAULTS,
  autoCompactLimitFor,
  type AutoCompact,
  claudeCompactionEnv,
  CLAUDE_COMPACTION_DISABLE_ENV,
  CLAUDE_COMPACTION_PERCENT_ENV,
  CLAUDE_COMPACTION_WINDOW_ENV,
  contextClassOf,
  migrateClaudeCompaction,
  type ProviderInstanceEnvVar,
} from "../src/index";

const plain = (name: string, value: string): ProviderInstanceEnvVar => ({ name, value, sensitive: false });

function cliThreshold(env: Record<string, string | undefined>, modelWindow: number, maxOutputTokens = 32_000): number {
  const declared = env[CLAUDE_COMPACTION_WINDOW_ENV];
  const window = declared === undefined ? modelWindow : Math.min(modelWindow, Math.max(100_000, Math.min(Number(declared), 1_000_000)));
  const effective = window - Math.min(maxOutputTokens, 20_000);
  const raw = env[CLAUDE_COMPACTION_PERCENT_ENV];
  const pct = raw === undefined ? undefined : Number.parseFloat(raw);
  const byWindow = effective - 13_000;
  return pct !== undefined && pct > 0 && pct <= 100 ? Math.min(Math.floor((effective * pct) / 100), byWindow) : byWindow;
}

const limits = (standard: number, long: number): AutoCompact => ({ mode: "limits", standard, long });

describe("window classes", () => {
  test("200k and Codex's 272k are standard; 872k and 1M are long", () => {
    expect([200_000, 272_000, 400_000, 872_000, 1_000_000].map(contextClassOf)).toEqual(["standard", "standard", "standard", "long", "long"]);
  });

  test("an unknown window takes the standard limit — the earlier one", () => {
    const setting = { standard: 150_000, long: 400_000 };
    expect(autoCompactLimitFor(setting, 200_000)).toBe(150_000);
    expect(autoCompactLimitFor(setting, 1_000_000)).toBe(400_000);
    expect(autoCompactLimitFor(setting, undefined)).toBe(150_000);
  });
});

describe("the environment a Claude session is spawned with", () => {
  test("each class's limit lands on exactly that many tokens", () => {
    for (const [window, expected] of [
      [200_000, 150_000],
      [1_000_000, 400_000],
    ] as const) {
      const env = claudeCompactionEnv(limits(150_000, 400_000), window)!;
      for (const maxOutputTokens of [20_000, 32_000, 64_000]) expect(cliThreshold(env, window, maxOutputTokens)).toBe(expected);
    }
  });

  test("small limits land too, under the CLI's 100,000 window floor", () => {
    for (const tokens of [1, 5_000, 30_000, 66_999, 67_000]) {
      expect(cliThreshold(claudeCompactionEnv(limits(tokens, tokens), 200_000)!, 200_000)).toBe(tokens);
    }
  });

  test("a limit past the model's own ceiling compacts at that ceiling — earlier, never later", () => {
    expect(cliThreshold(claudeCompactionEnv(limits(190_000, 400_000), 200_000)!, 200_000)).toBe(167_000);
    expect(cliThreshold(claudeCompactionEnv(limits(150_000, 1_000_000), 1_000_000)!, 1_000_000)).toBe(967_000);
  });

  test("Never sets the one spelling the CLI accepts; Default sets nothing", () => {
    expect(claudeCompactionEnv({ mode: "never" }, 200_000)).toEqual({ [CLAUDE_COMPACTION_DISABLE_ENV]: "1" });
    expect(claudeCompactionEnv(undefined, 200_000)).toBeUndefined();
  });

  test("limits delete a disable row, so a stale one cannot override the setting", () => {
    const env = claudeCompactionEnv(limits(150_000, 400_000), 200_000)!;
    expect(CLAUDE_COMPACTION_DISABLE_ENV in env).toBeTrue();
    expect(env[CLAUDE_COMPACTION_DISABLE_ENV]).toBeUndefined();
  });
});

describe("migrating a pre-#587 Claude login", () => {
  test("the old token count becomes the 200k limit; 1M takes the default", () => {
    const old = [plain("ANTHROPIC_BASE_URL", "https://example.test"), plain(CLAUDE_COMPACTION_WINDOW_ENV, "183000"), plain(CLAUDE_COMPACTION_PERCENT_ENV, "100")];
    expect(migrateClaudeCompaction(old)).toEqual({
      env: [plain("ANTHROPIC_BASE_URL", "https://example.test")],
      autoCompact: limits(150_000, AUTO_COMPACT_DEFAULTS.long),
    });
    expect(migrateClaudeCompaction([plain(CLAUDE_COMPACTION_WINDOW_ENV, "153000"), plain(CLAUDE_COMPACTION_PERCENT_ENV, "90.225564")])?.autoCompact).toEqual(
      limits(120_000, 400_000),
    );
    expect(migrateClaudeCompaction([plain(CLAUDE_COMPACTION_WINDOW_ENV, "100000"), plain(CLAUDE_COMPACTION_PERCENT_ENV, "37.5")])?.autoCompact).toEqual(
      limits(30_000, 400_000),
    );
  });

  test("a count above the 1M default keeps 1M sessions where they were", () => {
    expect(migrateClaudeCompaction([plain(CLAUDE_COMPACTION_WINDOW_ENV, "533000")])?.autoCompact).toEqual(limits(500_000, 500_000));
  });

  test("Never stays Never, and rows the CLI would ignore mean Default", () => {
    expect(migrateClaudeCompaction([plain(CLAUDE_COMPACTION_DISABLE_ENV, "yes"), plain(CLAUDE_COMPACTION_WINDOW_ENV, "183000")])).toEqual({
      env: [],
      autoCompact: { mode: "never" },
    });
    expect(migrateClaudeCompaction([plain(CLAUDE_COMPACTION_WINDOW_ENV, "lots")])).toEqual({ env: [] });
    expect(migrateClaudeCompaction([plain(CLAUDE_COMPACTION_DISABLE_ENV, "0")])).toEqual({ env: [] });
  });

  test("a login with no compaction rows has nothing to migrate", () => {
    expect(migrateClaudeCompaction([])).toBeUndefined();
    expect(migrateClaudeCompaction([plain("ANTHROPIC_BASE_URL", "x")])).toBeUndefined();
  });
});
