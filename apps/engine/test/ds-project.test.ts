import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";

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
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  return store;
}

test("a project starts with no data-science block and a patch adds one", () => {
  const store = readyStore();
  expect(store.getProject("project_one").dataScience).toBeUndefined();

  const config = { enabled: true, python: { source: "chosen" as const, path: ".venv/bin/python", resolvedAt: 5 } };
  const updated = store.updateProject("project_one", { dataScience: config });
  expect(updated.dataScience).toEqual(config);
  expect(updated.updatedAt).toBe(100);
  // Survives a fresh read, and the list's derived-metadata spread.
  expect(store.getProject("project_one").dataScience).toEqual(config);
  expect(store.listProjects()[0]!.dataScience).toEqual(config);
});

test("null removes the block rather than storing enabled: false forever", () => {
  const store = readyStore();
  store.updateProject("project_one", { dataScience: { enabled: true } });
  const off = store.updateProject("project_one", { dataScience: null });
  expect(off.dataScience).toBeUndefined();
  expect("dataScience" in JSON.parse(fs.readFileSync(path.join(store.paths.root, "projects.json"), "utf8")).projects[0]).toBe(false);
});

test("an invalid block and an unknown project are refused", () => {
  const store = readyStore();
  expect(() => store.updateProject("project_one", { dataScience: { enabled: "yes" } as never })).toThrow(EngineStateError);
  expect(() => store.updateProject("project_nope", { dataScience: { enabled: true } })).toThrow(EngineStateError);
});

test("an empty patch touches nothing but updatedAt", () => {
  const store = readyStore();
  const before = store.getProject("project_one");
  const after = store.updateProject("project_one", {});
  expect({ ...after, updatedAt: before.updatedAt }).toEqual(before);
});
