/**
 * TOKEN AUTO-COMPACT THRESHOLDS BECOME PERCENTAGES — the one-time rewrite in
 * `migrateClaudeCompactionToPercent` (#587). Every case uses a temp home.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderInstanceEnvVar } from "@telar/engine-client";
import { EngineStore } from "../src/state";

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
  new EngineStore(root, () => 100).saveProviderInstance({ id: "claude", env });
  fs.rmSync(path.join(root, MARKER), { force: true });
  return root;
}

const envOf = (store: EngineStore) => store.listProviderInstances().find((instance) => instance.id === "claude")!.env;

describe("the one-time percentage rewrite", () => {
  test("150,000 tokens — the old seed — becomes 75% of a 200k window", () => {
    const root = oldStore([
      plain("ANTHROPIC_BASE_URL", "https://example.test"),
      plain("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "183000"),
      plain("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "100"),
    ]);
    const store = new EngineStore(root, () => 200);
    expect(store.claudeCompactionMigration).toBe(1);
    expect(envOf(store)).toEqual([plain("ANTHROPIC_BASE_URL", "https://example.test"), plain("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "75")]);
  });

  test("a threshold past the window clamps to 100%", () => {
    const store = new EngineStore(oldStore([plain("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "1000000")]), () => 200);
    expect(envOf(store)).toEqual([plain("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "100")]);
  });

  test("Never and a login with no threshold are left as they are", () => {
    const never = new EngineStore(oldStore([plain("DISABLE_AUTO_COMPACT", "1")]), () => 200);
    expect(never.claudeCompactionMigration).toBe(0);
    expect(envOf(never)).toEqual([plain("DISABLE_AUTO_COMPACT", "1")]);
  });

  test("it runs once: a later open changes nothing", () => {
    const root = oldStore([plain("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "183000")]);
    expect(new EngineStore(root, () => 200).claudeCompactionMigration).toBe(1);
    const reopened = new EngineStore(root, () => 300);
    expect(reopened.claudeCompactionMigration).toBeUndefined();
    expect(envOf(reopened)).toEqual([plain("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "75")]);
  });
});
