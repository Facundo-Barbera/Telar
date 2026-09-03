/**
 * The curated model list, as the store keeps it.
 *
 * The properties worth pinning here are the ones a settings page can silently
 * violate: a preference document must never be able to take the picker down with
 * it, a cleared list must be distinguishable from an untouched one, and — the
 * design's load-bearing claim — an edit must reach the next menu WITHOUT
 * respawning the provider's CLI.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelCatalogue } from "@telar/engine-client";
import { EngineStateError, EngineStore, statePaths } from "../src/state";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-overlay-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const store = (dir = root()): EngineStore => new EngineStore(dir, () => 100);

test("an unconfigured login reads as an untouched overlay, not as an error", () => {
  // Every surface behaves exactly as it did before the feature existed when this
  // is what it gets.
  expect(store().getModelOverlay("claude")).toEqual({
    instanceId: "claude",
    favorites: [],
    hidden: [],
    order: [],
    custom: [],
    updatedAt: 0,
  });
});

test("a document nobody can parse costs the preference, never the picker", () => {
  // Two DIFFERENT failures, and only one of them is a safeParse: `readJson`
  // swallows a missing file and RETHROWS a parse error. The inbox policy already
  // recorded that trap; this pins it for the overlay too.
  for (const contents of ["not json at all {{{", '{"overlays": "a string"}', '{"overlays": [{"nope": 1}]}']) {
    const dir = root();
    fs.writeFileSync(statePaths(dir).modelOverlays, contents);
    expect(store(dir).getModelOverlay("claude").hidden).toEqual([]);
  }
});

test("presence is the patch, and a submitted list replaces its own whole", () => {
  const engine = store();
  engine.setModelOverlay("claude", { hidden: ["sonnet"], favorites: ["opus[1m]"] });
  // Absent leaves alone...
  expect(engine.setModelOverlay("claude", { favorites: ["sonnet"] }).hidden).toEqual(["sonnet"]);
  // ...and an empty array is a real request: "I cleared this."
  expect(engine.setModelOverlay("claude", { hidden: [] }).hidden).toEqual([]);
  expect(engine.getModelOverlay("claude").favorites).toEqual(["sonnet"]);
});

test("two logins of one provider curate independently", () => {
  // The reason the document is keyed by instance: entitlements are per account.
  const engine = store();
  engine.setModelOverlay("claude", { hidden: ["sonnet"] });
  engine.setModelOverlay("claude_work", { hidden: ["opus[1m]"] });
  expect(engine.getModelOverlay("claude").hidden).toEqual(["sonnet"]);
  expect(engine.getModelOverlay("claude_work").hidden).toEqual(["opus[1m]"]);
});

test("a repeated id is a double-click, not a malformed request", () => {
  expect(store().setModelOverlay("claude", { favorites: ["a", "a", "b"] }).favorites).toEqual(["a", "b"]);
});

test("what could not be a model id at all is refused", () => {
  const engine = store();
  for (const bad of ["", "  ", 'has"quote', "has space", "has\nnewline"]) {
    expect(() => engine.setModelOverlay("claude", { hidden: [bad] })).toThrow(EngineStateError);
  }
  // And what genuinely IS a model id is not — no provider promised a grammar.
  for (const good of ["opus[1m]", "gpt-5.6-sol", "claude-fable-5-1", "us.anthropic.claude-fable-5-1"]) {
    expect(engine.setModelOverlay("claude", { hidden: [good] }).hidden).toEqual([good]);
  }
});

test("two labels for one custom id are two answers, so the write is refused", () => {
  const engine = store();
  expect(() =>
    engine.setModelOverlay("claude", { custom: [{ id: "x", label: "one" }, { id: "x", label: "two" }] }),
  ).toThrow(EngineStateError);
});

test("a malformed instance id never reaches the file", () => {
  expect(() => store().getModelOverlay("../escape")).toThrow(EngineStateError);
});

test("an edit reaches the next catalogue with no refresh and no second CLI spawn", () => {
  // THE LOAD-BEARING ASSERTION. The provider answer is cached for five minutes
  // and `force` is the only way past it; the overlay is applied on top, every
  // time. If this ever needs a `force` to show up, the overlay has been baked
  // into the cache and hiding a row now costs a subprocess.
  let spawns = 0;
  const catalogue = async (driver: "claude" | "codex", now: () => number): Promise<ModelCatalogue> => {
    spawns += 1;
    return {
      driver,
      source: "provider",
      readAt: now(),
      models: [
        { id: "sonnet", label: "Sonnet", isDefault: true, hidden: false, hiddenByUser: false, efforts: [], fastMode: false, source: "provider" },
        { id: "opus[1m]", label: "Opus", isDefault: false, hidden: false, hiddenByUser: false, efforts: [], fastMode: false, source: "provider" },
      ],
    };
  };
  // An EMPTY manifest: this test is about the overlay, and the bundled manifest
  // declares `claude-fable-5-1` — the very id the custom entry below types —
  // which would pre-empt it by design (see the precedence test further down).
  const engine = new EngineStore(root(), () => 100, { models: catalogue, manifest: { version: 1 } });

  return (async () => {
    const before = await engine.modelCatalogue("claude");
    expect(before.models.map((model) => model.id)).toEqual(["sonnet", "opus[1m]"]);
    expect(before.instanceId).toBe("claude");

    engine.setModelOverlay("claude", { hidden: ["sonnet"], order: ["opus[1m]"], custom: [{ id: "claude-fable-5-1" }] });

    const after = await engine.modelCatalogue("claude");
    expect(spawns).toBe(1);
    expect(after.models.map((model) => model.id)).toEqual(["opus[1m]", "sonnet", "claude-fable-5-1"]);
    expect(after.models.find((model) => model.id === "sonnet")?.hiddenByUser).toBe(true);
    expect(after.models.find((model) => model.id === "claude-fable-5-1")?.source).toBe("user");

    // And a second login sees the same provider answer with none of it applied.
    const other = await engine.modelCatalogue("claude", { instanceId: "claude_work" });
    expect(spawns).toBe(1);
    expect(other.models.map((model) => model.id)).toEqual(["sonnet", "opus[1m]"]);
  })();
});

test("a manifest declaration pre-empts a hand-typed custom row for the same id — one row, the declared one", () => {
  /**
   * THE COLLISION THE BUNDLED MANIFEST CREATES. Someone typed `claude-fable-5-1`
   * into the Models tab back when the CLI did not list it; now the manifest
   * declares it. The overlay's own `published` check treats the declared row
   * as published, so the custom entry goes quiet — exactly as it would if the
   * CLI itself had started listing the id — and the reader gets the declared
   * row's real label and efforts rather than the bare id.
   */
  const catalogue = async (driver: "claude" | "codex", now: () => number): Promise<ModelCatalogue> => ({
    driver,
    source: "provider",
    readAt: now(),
    models: [{ id: "sonnet", label: "Sonnet", isDefault: true, hidden: false, hiddenByUser: false, efforts: [], fastMode: false, source: "provider" }],
  });
  const engine = new EngineStore(root(), () => 100, {
    models: catalogue,
    manifest: {
      version: 1,
      claude: { profiles: { f: { longWindow: false } }, models: { "claude-fable-5-1": "f" }, declare: [{ id: "claude-fable-5-1", label: "Fable 5.1", efforts: ["high"] }] },
    },
  });
  engine.setModelOverlay("claude", { hidden: [], order: [], custom: [{ id: "claude-fable-5-1" }] });
  return (async () => {
    const { models } = await engine.modelCatalogue("claude");
    const rows = models.filter((model) => model.id === "claude-fable-5-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Fable 5.1", source: "provider", efforts: ["high"] });
  })();
});
