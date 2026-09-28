/**
 * THE MAP IS WRITTEN THROUGH `updateProject`, AND THAT IS THE PATH THAT CAN LOSE
 * DATA. `packages/engine-client/test/plugins.test.ts` covers the pure precedence
 * and legacy-fold rules on plain objects; this file covers the same rules where
 * they actually meet the disk — the store's single write path, the fold on open,
 * and what a project on disk looks like after each kind of patch.
 *
 * Every case here uses a temp home and a temp checkout. Nothing reads or writes
 * the real `~/.telar`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginEnabled, pluginSettings, readProjectPlugins } from "@telar/engine-client";
import { EngineStateError, EngineStore } from "../../state";

const roots: string[] = [];
const dir = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function readyStore(): EngineStore {
  const store = new EngineStore(dir("telar-plugin-home-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: dir("telar-plugin-checkout-") });
  return store;
}

/** What is actually on disk, before any schema parse re-shapes it. */
function onDisk(store: EngineStore): Record<string, unknown> {
  const file = path.join(store.paths.root, "projects.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).projects[0];
}

describe("the legacy keys are a DEPRECATED INPUT ALIAS, and only the map is written", () => {
  test("a legacy patch lands in the map, and no legacy key is stored or returned", () => {
    const store = readyStore();
    const project = store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });

    expect("latex" in project).toBe(false);
    expect(pluginEnabled(project.plugins!, "latex")).toBe(true);
    expect(pluginSettings(project.plugins!, "latex")).toEqual({ mainFile: "paper.tex" });

    const stored = onDisk(store);
    expect("latex" in stored).toBe(false);
    expect("dataScience" in stored).toBe(false);
    expect((stored.plugins as { version: number }).version).toBe(1);
  });

  test("a legacy patch for one plugin does not disturb the other's entry", () => {
    const store = readyStore();
    store.updateProject("project_one", { dataScience: { enabled: true, stack: ["pandas"] } });
    const project = store.updateProject("project_one", { latex: { enabled: true } });

    expect(pluginEnabled(project.plugins!, "data-science")).toBe(true);
    expect(pluginSettings(project.plugins!, "data-science")).toEqual({ stack: ["pandas"] });
    expect("dataScience" in project).toBe(false);
  });

  test("an invalid legacy block is refused BEFORE anything is written", () => {
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    const before = onDisk(store);
    expect(() => store.updateProject("project_one", { dataScience: { enabled: "yes" } as never })).toThrow(
      EngineStateError,
    );
    // The refusal must not have half-applied: LaTeX is untouched and no
    // data-science entry appeared.
    const project = store.getProject("project_one");
    expect(pluginEnabled(project.plugins!, "latex")).toBe(true);
    expect(pluginEnabled(project.plugins!, "data-science")).toBe(false);
    expect(onDisk(store)).toEqual(before);
  });
});

describe("the generic write path", () => {
  test("a plugin patch reaches a plugin the legacy arm has never heard of", () => {
    const store = readyStore();
    const project = store.updateProject("project_one", {
      plugins: { hello: { enabled: true, settings: { greeting: "hola" } } },
    });
    expect(pluginEnabled(project.plugins!, "hello")).toBe(true);
    expect(pluginSettings(project.plugins!, "hello")).toEqual({ greeting: "hola" });
    // An unmirrored plugin writes NOTHING to the legacy fields — there is no
    // legacy field to write, and inventing one would be a schema key an older
    // engine strips anyway.
    const stored = onDisk(store);
    expect(stored.hello).toBeUndefined();
  });

  test("a plugin patch for a formerly mirrored plugin writes the map and NO legacy key", () => {
    const store = readyStore();
    store.updateProject("project_one", {
      plugins: { latex: { enabled: true, settings: { mainFile: "thesis.tex" } } },
    });
    const stored = onDisk(store);
    expect("latex" in stored).toBe(false);
    expect((stored.plugins as { entries: Record<string, unknown> }).entries.latex).toEqual({
      enabled: true,
      settings: { mainFile: "thesis.tex" },
    });
  });

  test("A GENERIC PATCH WINS OVER A LEGACY ONE IN THE SAME REQUEST", () => {
    // Both arms can name the same plugin. The precedence is stated rather than
    // accidental: the generic map is the authority, so it is applied last.
    const store = readyStore();
    const project = store.updateProject("project_one", {
      latex: { enabled: true, mainFile: "legacy.tex" },
      plugins: { latex: { enabled: true, settings: { mainFile: "generic.tex" } } },
    });
    expect(pluginSettings(project.plugins!, "latex")).toEqual({ mainFile: "generic.tex" });
    expect(pluginSettings(readProjectPlugins(onDisk(store)).plugins, "latex")).toEqual({ mainFile: "generic.tex" });
    expect("latex" in project).toBe(false);
  });

  test("an empty patch does not migrate a project that never configured anything", () => {
    const store = readyStore();
    store.updateProject("project_one", {});
    expect(onDisk(store).plugins).toBeUndefined();
  });
});

describe("disabling", () => {
  test("A NULL PATCH DELETES THE ENTRY, so no reader anywhere still sees the settings", () => {
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    const project = store.updateProject("project_one", { latex: null });

    expect("latex" in project).toBe(false);
    expect(pluginEnabled(project.plugins!, "latex")).toBe(false);
    expect(pluginSettings(project.plugins!, "latex")).toEqual({});

    const stored = onDisk(store);
    expect("latex" in stored).toBe(false);
    expect((stored.plugins as { entries: Record<string, unknown> }).entries.latex).toBeUndefined();
  });

  test("a generic null does the same as a legacy null", () => {
    const store = readyStore();
    store.updateProject("project_one", { dataScience: { enabled: true, stack: ["pandas"] } });
    const project = store.updateProject("project_one", { plugins: { "data-science": null } });
    expect("dataScience" in project).toBe(false);
    expect(pluginEnabled(project.plugins!, "data-science")).toBe(false);
    expect((onDisk(store).plugins as { entries: Record<string, unknown> }).entries["data-science"]).toBeUndefined();
  });

  test("an EXPLICIT disable keeps the settings in the map", () => {
    // Unticking a checkbox is not the same as removing the plugin: the settings
    // beside it are meant to survive so re-enabling does not start from blank.
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    const project = store.updateProject("project_one", { latex: { enabled: false, mainFile: "paper.tex" } });

    expect(pluginEnabled(project.plugins!, "latex")).toBe(false);
    expect(pluginSettings(project.plugins!, "latex")).toEqual({ mainFile: "paper.tex" });
    const stored = onDisk(store);
    expect((stored.plugins as { entries: Record<string, unknown> }).entries.latex).toEqual({
      enabled: false,
      settings: { mainFile: "paper.tex" },
    });
    expect("latex" in stored).toBe(false);
  });

  test("the marker survives disabling the last plugin", () => {
    // Once a project is migrated it stays migrated. Dropping the marker with the
    // last entry would put the project back on the legacy read path, which is
    // exactly where the resurrection bug lives.
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true } });
    store.updateProject("project_one", { latex: null });
    expect((onDisk(store).plugins as { version: number }).version).toBe(1);
  });
});

describe("a legacy-only record on disk folds into the map on open", () => {
  /** A record as an engine that predates the map left it: the legacy blocks,
   *  and no `plugins` key at all. */
  function writeLegacyRecord(store: EngineStore, legacy: Record<string, unknown>): void {
    const file = path.join(store.paths.root, "projects.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    parsed.projects = parsed.projects.map((project: Record<string, unknown>) => {
      const { plugins: _stripped, ...rest } = project;
      return { ...rest, ...legacy };
    });
    fs.writeFileSync(file, JSON.stringify(parsed));
  }

  test("an ENABLED plugin comes across with its settings, and the legacy keys are gone from disk", () => {
    const store = readyStore();
    writeLegacyRecord(store, {
      latex: { enabled: true, mainFile: "paper.tex" },
      dataScience: { enabled: true, stack: ["pandas"] },
    });

    const reopened = new EngineStore(store.paths.root, () => 200);
    expect(reopened.pluginFieldMigration).toBe(1);
    const stored = onDisk(reopened);
    expect("latex" in stored).toBe(false);
    expect("dataScience" in stored).toBe(false);
    expect(stored.plugins).toEqual({
      version: 1,
      entries: {
        latex: { enabled: true, settings: { mainFile: "paper.tex" } },
        "data-science": { enabled: true, settings: { stack: ["pandas"] } },
      },
    });
    const project = reopened.getProject("project_one");
    expect("latex" in project).toBe(false);
    expect(pluginSettings(project.plugins!, "latex")).toEqual({ mainFile: "paper.tex" });
  });

  test("A DISABLED PLUGIN STAYS OFF, and keeps its settings", () => {
    const store = readyStore();
    writeLegacyRecord(store, { latex: { enabled: false, mainFile: "paper.tex" }, dataScience: { enabled: true } });

    const reopened = new EngineStore(store.paths.root, () => 200);
    const { plugins } = readProjectPlugins(reopened.getProject("project_one"));
    expect(pluginEnabled(plugins, "latex")).toBe(false);
    expect(pluginSettings(plugins, "latex")).toEqual({ mainFile: "paper.tex" });
    expect(pluginEnabled(plugins, "data-science")).toBe(true);
  });

  test("RE-OPENING IS A NO-OP — the registry is not rewritten", () => {
    const store = readyStore();
    writeLegacyRecord(store, { latex: { enabled: true, mainFile: "paper.tex" } });
    new EngineStore(store.paths.root, () => 200);
    const file = path.join(store.paths.root, "projects.json");
    const afterFirst = fs.readFileSync(file, "utf8");
    const mtime = fs.statSync(file).mtimeMs;

    const again = new EngineStore(store.paths.root, () => 300);
    expect(again.pluginFieldMigration).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(afterFirst);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  test("a registry with no legacy keys is not touched on open, and a write after the fold keeps the settings", () => {
    const store = readyStore();
    expect(new EngineStore(store.paths.root, () => 200).pluginFieldMigration).toBe(0);

    writeLegacyRecord(store, { latex: { enabled: true, mainFile: "paper.tex" } });
    const reopened = new EngineStore(store.paths.root, () => 300);
    reopened.updateProject("project_one", { dataScience: { enabled: true } });
    const stored = onDisk(reopened);
    expect((stored.plugins as { version: number }).version).toBe(1);
    expect((stored.plugins as { entries: Record<string, { settings?: unknown }> }).entries.latex?.settings).toEqual({
      mainFile: "paper.tex",
    });
    expect("latex" in stored).toBe(false);
  });
});
