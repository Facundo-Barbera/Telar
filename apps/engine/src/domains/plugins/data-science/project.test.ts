import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginBlock } from "@telar/engine-client";
import { EngineStore } from "../../../state";
import { EngineStateError } from "../../../platform/kernel";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ds-project-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function readyStore(): EngineStore {
  const store = new EngineStore(root(), () => 100);
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  return store;
}

test("a project starts with no data-science block and a patch adds one", () => {
  const store = readyStore();
  expect(pluginBlock(store.projectRegistry.get("project_one"), "data-science")).toBeUndefined();

  const config = { enabled: true, python: { source: "chosen" as const, path: ".venv/bin/python", resolvedAt: 5 } };
  const updated = store.projectRegistry.update("project_one", { dataScience: config });
  // The alias lands in the map, whole, and is not itself stored or returned.
  expect(pluginBlock(updated, "data-science")).toEqual(config);
  expect("dataScience" in updated).toBe(false);
  expect(updated.updatedAt).toBe(100);
  // Survives a fresh read, and the list's derived-metadata spread.
  expect(pluginBlock(store.projectRegistry.get("project_one"), "data-science")).toEqual(config);
  expect(pluginBlock(store.projectRegistry.list()[0]!, "data-science")).toEqual(config);
});

test("null removes the block rather than storing enabled: false forever", () => {
  const store = readyStore();
  store.projectRegistry.update("project_one", { dataScience: { enabled: true } });
  const off = store.projectRegistry.update("project_one", { dataScience: null });
  expect(pluginBlock(off, "data-science")).toBeUndefined();
  const stored = JSON.parse(fs.readFileSync(path.join(store.paths.root, "projects.json"), "utf8")).projects[0];
  expect("dataScience" in stored).toBe(false);
  expect(stored.plugins.entries["data-science"]).toBeUndefined();
});

test("an invalid block and an unknown project are refused", () => {
  const store = readyStore();
  expect(() => store.projectRegistry.update("project_one", { dataScience: { enabled: "yes" } as never })).toThrow(EngineStateError);
  expect(() => store.projectRegistry.update("project_nope", { dataScience: { enabled: true } })).toThrow(EngineStateError);
});

test("an empty patch touches nothing but updatedAt", () => {
  const store = readyStore();
  const before = store.projectRegistry.get("project_one");
  const after = store.projectRegistry.update("project_one", {});
  expect({ ...after, updatedAt: before.updatedAt }).toEqual(before);
});
