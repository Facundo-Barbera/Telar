/**
 * CLAUDE'S COMPACTION ROWS BECOME THE PER-CLASS SETTING — the one-time rewrite
 * in `migrateClaudeCompactionToLimits` (#587). Every case uses a temp home.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderInstanceEnvVar } from "@telar/engine-client";
import { EngineStore } from "../../state";

const roots: string[] = [];
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const MARKER = "claude-compaction-migration.json";
const plain = (name: string, value: string): ProviderInstanceEnvVar => ({ name, value, sensitive: false });

/** A store as a pre-#587 engine left it: the login's env as given, no marker. */
function oldStore(env: ProviderInstanceEnvVar[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compaction-"));
  roots.push(root);
  new EngineStore(root, () => 100).providers.save({ id: "claude", env });
  fs.rmSync(path.join(root, MARKER), { force: true });
  return root;
}

const claude = (store: EngineStore) => store.providers.list().find((instance) => instance.id === "claude")!;

describe("the one-time move to per-class limits", () => {
  test("150,000 tokens becomes the 200k limit, 1M takes 400,000, and the rows go", () => {
    const root = oldStore([
      plain("ANTHROPIC_BASE_URL", "https://example.test"),
      plain("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "183000"),
      plain("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "100"),
    ]);
    const store = new EngineStore(root, () => 200);
    expect(store.claudeCompactionMigration).toBe(1);
    expect(claude(store).autoCompact).toEqual({ mode: "limits", standard: 150_000, long: 400_000 });
    expect(claude(store).env).toEqual([plain("ANTHROPIC_BASE_URL", "https://example.test")]);
  });

  test("Never moves across as Never", () => {
    const store = new EngineStore(oldStore([plain("DISABLE_AUTO_COMPACT", "1")]), () => 200);
    expect(claude(store).autoCompact).toEqual({ mode: "never" });
    expect(claude(store).env).toEqual([]);
  });

  test("a login with no rows is left alone", () => {
    const store = new EngineStore(oldStore([plain("ANTHROPIC_BASE_URL", "x")]), () => 200);
    expect(store.claudeCompactionMigration).toBe(0);
    expect(claude(store).autoCompact).toBeUndefined();
  });

  test("it runs once: rows typed by hand later are not moved", () => {
    const root = oldStore([plain("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "183000")]);
    expect(new EngineStore(root, () => 200).claudeCompactionMigration).toBe(1);
    const again = new EngineStore(root, () => 300);
    again.providers.save({ id: "claude", env: [plain("DISABLE_AUTO_COMPACT", "1")] });
    const reopened = new EngineStore(root, () => 400);
    expect(reopened.claudeCompactionMigration).toBeUndefined();
    expect(claude(reopened).env).toEqual([plain("DISABLE_AUTO_COMPACT", "1")]);
    expect(claude(reopened).autoCompact).toEqual({ mode: "limits", standard: 150_000, long: 400_000 });
  });
});

describe("saving the setting", () => {
  test("set, keep, clear — and a limit out of range is refused", () => {
    const root = oldStore([]);
    const store = new EngineStore(root, () => 200);
    store.providers.save({ id: "claude", autoCompact: { mode: "limits", standard: 120_000, long: 500_000 } });
    store.providers.save({ id: "claude", displayName: "Work" });
    expect(claude(store).autoCompact).toEqual({ mode: "limits", standard: 120_000, long: 500_000 });
    expect(() => store.providers.save({ id: "claude", autoCompact: { mode: "limits", standard: 0, long: 1 } })).toThrow("auto-compaction");
    store.providers.save({ id: "claude", autoCompact: null });
    expect(claude(store).autoCompact).toBeUndefined();
  });
});
