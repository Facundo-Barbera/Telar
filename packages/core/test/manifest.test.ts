import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectManifest } from "../src/schemas";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-manifest-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const {
  createProject,
  getProject,
  listProjects,
  loadManifest,
  registerProject,
  telarDir,
  unregisterProject,
  writeManifest,
} = await import("../src/manifest");

const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-proj-"));

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(projRoot, { recursive: true, force: true });
});

describe("manifest", () => {
  test("telarDir honors TELAR_HOME", () => {
    expect(telarDir()).toBe(home);
  });

  test("loadManifest throws on missing telar.yaml", () => {
    expect(() => loadManifest(projRoot)).toThrow(/No telar.yaml/);
  });

  test("createProject scaffolds, registers, and refuses to overwrite", () => {
    const m = createProject(projRoot, { account: "work" });
    expect(m.name).toBe(path.basename(projRoot));
    expect(m.root).toBe(path.resolve(projRoot));
    expect(m.account).toBe("work");
    expect(fs.existsSync(path.join(projRoot, "telar.yaml"))).toBe(true);
    expect(() => createProject(projRoot)).toThrow(/already exists/);
  });

  test("manifest roundtrip via writeManifest/loadManifest", () => {
    const m = loadManifest(projRoot);
    m.gates = [{ name: "lint", run: "true" }];
    writeManifest(projRoot, m);
    expect(loadManifest(projRoot)).toEqual(m);
  });

  test("loadManifest rejects invalid manifests", () => {
    fs.writeFileSync(path.join(projRoot, "telar.yaml"), "name: 42\n");
    expect(() => loadManifest(projRoot)).toThrow(/Invalid telar.yaml/);
    // restore a valid one for the tests below
    writeManifest(projRoot, loadValid());
  });

  test("registerProject is idempotent and preserves addedAt", () => {
    const first = getProject(path.basename(projRoot)).entry;
    registerProject(projRoot);
    const second = getProject(path.basename(projRoot)).entry;
    expect(second.addedAt).toBe(first.addedAt);
    expect(second.root).toBe(path.resolve(projRoot));
  });

  test("listProjects reports manifests and errors without throwing", () => {
    const all = listProjects();
    const mine = all.find((p) => p.entry.name === path.basename(projRoot));
    expect(mine?.manifest?.name).toBe(path.basename(projRoot));
    expect(mine?.error).toBeNull();

    fs.rmSync(path.join(projRoot, "telar.yaml"));
    const broken = listProjects().find((p) => p.entry.name === path.basename(projRoot));
    expect(broken?.manifest).toBeNull();
    expect(broken?.error).toMatch(/No telar.yaml/);
    writeManifest(projRoot, loadValid());
  });

  test("getProject throws on unknown, unregisterProject removes entry only", () => {
    expect(() => getProject("nope")).toThrow(/Unknown project/);
    expect(unregisterProject(path.basename(projRoot))).toBe(true);
    expect(unregisterProject(path.basename(projRoot))).toBe(false);
    expect(fs.existsSync(path.join(projRoot, "telar.yaml"))).toBe(true);
  });
});

function loadValid() {
  return ProjectManifest.parse({ name: path.basename(projRoot), root: path.resolve(projRoot) });
}
