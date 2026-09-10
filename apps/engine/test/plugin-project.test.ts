/**
 * THE MAP IS WRITTEN THROUGH `updateProject`, AND THAT IS THE PATH THAT CAN LOSE
 * DATA. `packages/engine-client/test/plugins.test.ts` covers the pure precedence
 * and rollback rules on plain objects; this file covers the same rules where they
 * actually meet the disk — the store's single write path, its atomic mirrors, and
 * what a project on disk looks like after each kind of patch.
 *
 * Every case here uses a temp home and a temp checkout. Nothing reads or writes
 * the real `~/.telar`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginEnabled, pluginSettings, readProjectPlugins } from "@telar/engine-client";
import { EngineStateError, EngineStore } from "../src/state";

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

describe("the legacy write path still works, and now writes both sides", () => {
  test("a legacy patch lands in the map AND in the mirror", () => {
    const store = readyStore();
    const project = store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });

    expect(project.latex).toEqual({ enabled: true, mainFile: "paper.tex" });
    expect(pluginEnabled(project.plugins!, "latex")).toBe(true);
    expect(pluginSettings(project.plugins!, "latex")).toEqual({ mainFile: "paper.tex" });

    const stored = onDisk(store);
    expect(stored.latex).toEqual({ enabled: true, mainFile: "paper.tex" });
    expect((stored.plugins as { version: number }).version).toBe(1);
  });

  test("a legacy patch for one plugin does not disturb the other's entry", () => {
    const store = readyStore();
    store.updateProject("project_one", { dataScience: { enabled: true, stack: ["pandas"] } });
    const project = store.updateProject("project_one", { latex: { enabled: true } });

    expect(pluginEnabled(project.plugins!, "data-science")).toBe(true);
    expect(project.dataScience).toEqual({ enabled: true, stack: ["pandas"] });
  });

  test("an invalid legacy block is refused BEFORE anything is written", () => {
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    expect(() => store.updateProject("project_one", { dataScience: { enabled: "yes" } as never })).toThrow(
      EngineStateError,
    );
    // The refusal must not have half-applied: LaTeX is untouched and no
    // data-science entry appeared.
    const project = store.getProject("project_one");
    expect(pluginEnabled(project.plugins!, "latex")).toBe(true);
    expect(pluginEnabled(project.plugins!, "data-science")).toBe(false);
    expect(project.dataScience).toBeUndefined();
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

  test("a plugin patch for a MIRRORED plugin maintains the mirror too", () => {
    const store = readyStore();
    store.updateProject("project_one", {
      plugins: { latex: { enabled: true, settings: { mainFile: "thesis.tex" } } },
    });
    expect(onDisk(store).latex).toEqual({ enabled: true, mainFile: "thesis.tex" });
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
    expect(project.latex?.mainFile).toBe("generic.tex");
  });

  test("an empty patch does not migrate a project that never configured anything", () => {
    const store = readyStore();
    store.updateProject("project_one", {});
    expect(onDisk(store).plugins).toBeUndefined();
  });
});

describe("disabling", () => {
  test("A NULL PATCH DELETES BOTH SIDES, so no reader anywhere still sees the settings", () => {
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    const project = store.updateProject("project_one", { latex: null });

    expect(project.latex).toBeUndefined();
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
    expect(project.dataScience).toBeUndefined();
    expect(pluginEnabled(project.plugins!, "data-science")).toBe(false);
  });

  test("an EXPLICIT disable keeps the settings on both sides", () => {
    // Unticking a checkbox is not the same as removing the plugin: the settings
    // beside it are meant to survive so re-enabling does not start from blank.
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    const project = store.updateProject("project_one", { latex: { enabled: false, mainFile: "paper.tex" } });

    expect(pluginEnabled(project.plugins!, "latex")).toBe(false);
    expect(pluginSettings(project.plugins!, "latex")).toEqual({ mainFile: "paper.tex" });
    expect(onDisk(store).latex).toEqual({ enabled: false, mainFile: "paper.tex" });
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

describe("rollback, on disk", () => {
  /** An OLDER engine binary: `Project` strips the unknown `plugins` key on
   *  parse, so the next write it makes drops the map and keeps the mirror. */
  function simulateOldEngineRewrite(store: EngineStore): void {
    const file = path.join(store.paths.root, "projects.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    parsed.projects = parsed.projects.map((project: Record<string, unknown>) => {
      const { plugins: _stripped, ...rest } = project;
      return rest;
    });
    fs.writeFileSync(file, JSON.stringify(parsed));
  }

  test("rolling back and forward preserves an ENABLED plugin and its settings", () => {
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    simulateOldEngineRewrite(store);

    const rolledForward = new EngineStore(store.paths.root, () => 200);
    const project = rolledForward.getProject("project_one");
    const { plugins } = readProjectPlugins(project);
    expect(pluginEnabled(plugins, "latex")).toBe(true);
    expect(pluginSettings(plugins, "latex")).toEqual({ mainFile: "paper.tex" });
  });

  test("A PLUGIN DISABLED BEFORE THE ROLLBACK DOES NOT COME BACK ON", () => {
    // The whole point of deleting the mirror rather than only adding it. The old
    // binary can only see mirrors; if the mirror had been left behind, rolling
    // forward would resurrect a feature the user turned off.
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    store.updateProject("project_one", { dataScience: { enabled: true } });
    store.updateProject("project_one", { latex: null });
    simulateOldEngineRewrite(store);

    const rolledForward = new EngineStore(store.paths.root, () => 200);
    const { plugins } = readProjectPlugins(rolledForward.getProject("project_one"));
    expect(pluginEnabled(plugins, "latex")).toBe(false);
    expect(pluginEnabled(plugins, "data-science")).toBe(true);
  });

  test("a write after rolling forward re-stamps the marker", () => {
    const store = readyStore();
    store.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
    simulateOldEngineRewrite(store);

    const rolledForward = new EngineStore(store.paths.root, () => 200);
    rolledForward.updateProject("project_one", { dataScience: { enabled: true } });
    const stored = onDisk(rolledForward);
    expect((stored.plugins as { version: number }).version).toBe(1);
    // And the LaTeX settings the old binary carried in the mirror survived the
    // round trip into the re-stamped map.
    expect((stored.plugins as { entries: Record<string, { settings?: unknown }> }).entries.latex?.settings).toEqual({
      mainFile: "paper.tex",
    });
  });
});
