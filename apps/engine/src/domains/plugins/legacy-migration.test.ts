/**
 * THE LEGACY `dataScience` / `latex` BLOCKS FOLD INTO THE PLUGIN MAP — P1c.
 *
 * Every open of a store runs this over the real registry, so it is tested the
 * way it will meet one: FIXTURES written to a temp engine root, never a live
 * store. What must hold:
 *
 *   fold         a legacy-only record ends with the map, settings whole, and
 *                no legacy keys
 *   map wins     an existing entry is never overwritten by a legacy block
 *   off stays off  a legacy `enabled: false` folds as off, not as absent-then-on
 *   untouched    a registry with no legacy keys is not rewritten at all
 *   idempotent   a second open changes nothing
 *   alias        the deprecated PATCH keys write the map and are never stored
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, migrateLegacyPluginFields, pluginBlock } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { EngineStore } from "../../state";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-plugin-legacy-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const python = { source: "chosen", path: ".venv/bin/python", resolvedAt: 1 };

/** A registry on disk as an older engine left it: projects with extra raw fields. */
function fixture(extras: Record<string, Record<string, unknown>>): { engineRoot: string; file: string } {
  const engineRoot = root();
  const seed = new EngineStore(engineRoot, () => 100);
  for (const id of Object.keys(extras)) seed.registerProject({ id, name: id, root: root() });
  const file = path.join(engineRoot, "projects.json");
  const registry = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, unknown>[] };
  registry.projects = registry.projects.map((project) => ({ ...project, ...extras[project.id as string] }));
  fs.writeFileSync(file, JSON.stringify(registry));
  return { engineRoot, file };
}

const raw = (file: string, id: string) =>
  (JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, unknown>[] }).projects.find((project) => project.id === id)!;

test("a legacy-only record is folded into the map on open, settings whole, legacy keys gone", () => {
  const { engineRoot, file } = fixture({
    project_old: {
      dataScience: { enabled: true, python, stack: ["pandas"] },
      latex: { enabled: false, mainFile: "paper.tex" },
    },
  });
  const store = new EngineStore(engineRoot, () => 200);
  expect(store.pluginFieldMigration).toBe(1);

  const stored = raw(file, "project_old");
  expect(stored).not.toHaveProperty("dataScience");
  expect(stored).not.toHaveProperty("latex");
  expect(stored.plugins).toEqual({
    version: 1,
    entries: {
      "data-science": { enabled: true, settings: { python, stack: ["pandas"] } },
      // OFF STAYS OFF — and keeps what it had chosen.
      latex: { enabled: false, settings: { mainFile: "paper.tex" } },
    },
  });
  expect(pluginBlock(store.getProject("project_old"), "latex")).toEqual({ enabled: false, mainFile: "paper.tex" });
});

test("an existing map entry wins; a legacy block only fills an id the map lacks", () => {
  const { engineRoot, file } = fixture({
    project_both: {
      plugins: { version: 1, entries: { latex: { enabled: false, settings: { mainFile: "kept.tex" } } } },
      latex: { enabled: true, mainFile: "stale.tex" },
      dataScience: { enabled: true, python },
    },
  });
  new EngineStore(engineRoot, () => 200);
  const stored = raw(file, "project_both");
  expect(stored.plugins).toEqual({
    version: 1,
    entries: {
      latex: { enabled: false, settings: { mainFile: "kept.tex" } },
      "data-science": { enabled: true, settings: { python } },
    },
  });
  expect(stored).not.toHaveProperty("latex");
});

test("a registry with no legacy keys is not rewritten, and gains no empty map", () => {
  const { engineRoot, file } = fixture({ project_plain: {} });
  const before = fs.readFileSync(file, "utf8");
  const store = new EngineStore(engineRoot, () => 200);
  expect(store.pluginFieldMigration).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(raw(file, "project_plain")).not.toHaveProperty("plugins");
});

test("a second open changes nothing", () => {
  const { engineRoot, file } = fixture({ project_old: { dataScience: { enabled: true, python } } });
  new EngineStore(engineRoot, () => 200);
  const once = fs.readFileSync(file, "utf8");
  const again = new EngineStore(engineRoot, () => 300);
  expect(again.pluginFieldMigration).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe(once);
});

test("the fold itself: untouched without legacy keys, and never overwriting", () => {
  const plain = { id: "p", plugins: { version: 1, entries: {} } };
  expect(migrateLegacyPluginFields(plain)).toEqual({ project: plain, changed: false });
  const mixed = migrateLegacyPluginFields({
    id: "p",
    plugins: { version: 1, entries: { "data-science": { enabled: false } } },
    dataScience: { enabled: true, python },
  });
  expect(mixed).toEqual({ project: { id: "p", plugins: { version: 1, entries: { "data-science": { enabled: false } } } }, changed: true });
});

test("the deprecated PATCH aliases write the map and are never stored or returned", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });

  // @ts-expect-error deprecated alias the engine still accepts
  const { project } = await client.updateProject("project_one", { latex: { enabled: true, mainFile: "paper.tex" } });
  expect(project).not.toHaveProperty("latex");
  expect(pluginBlock(project, "latex")).toEqual({ enabled: true, mainFile: "paper.tex" });

  // @ts-expect-error deprecated alias the engine still accepts
  const off = await client.updateProject("project_one", { latex: null });
  expect(pluginBlock(off.project, "latex")).toBeUndefined();
  expect(raw(path.join(engineRoot, "projects.json"), "project_one")).not.toHaveProperty("latex");

  // An invalid legacy block is refused in the words it always was.
  // @ts-expect-error deprecated alias the engine still accepts
  await expect(client.updateProject("project_one", { dataScience: { enabled: "yes" } as never })).rejects.toMatchObject({
    message: "data science configuration is invalid",
  });
});
