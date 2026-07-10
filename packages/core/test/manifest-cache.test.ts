import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcache-home-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { createProject, getProject, writeManifest } = await import("../src/manifest");

const roots: string[] = [];
function freshProject(account = "personal") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcache-proj-"));
  roots.push(root);
  const manifest = createProject(root, { account });
  return { root, name: manifest.name, manifest };
}
const manifestPath = (root: string) => path.join(root, "telar.yaml");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe("manifest cache / self-heal", () => {
  test("self-heals a wiped telar.yaml from the cached manifest", () => {
    const { root, name, manifest } = freshProject("work");
    fs.rmSync(manifestPath(root)); // simulate `git clean` nuking the untracked file
    expect(fs.existsSync(manifestPath(root))).toBe(false);

    const { manifest: healed } = getProject(name);
    expect(healed).toEqual(manifest); // returns the cached last-known-good
    expect(fs.existsSync(manifestPath(root))).toBe(true); // file recreated on disk
    // and the restored file re-parses to the same thing
    expect(getProject(name).manifest).toEqual(manifest);
  });

  test("still throws on a malformed telar.yaml even when a cache exists", () => {
    const { root, name } = freshProject();
    fs.writeFileSync(manifestPath(root), ": : not [ valid : yaml");
    expect(() => getProject(name)).toThrow(/Malformed YAML|Invalid telar.yaml/);
  });

  test("throws on a missing telar.yaml when the registry entry has no cache", () => {
    const { root, name } = freshProject();
    // Strip the cached manifest from the registry to mimic a legacy entry.
    const regFile = path.join(home, "projects.json");
    const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
    delete reg[name].manifest;
    fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));

    fs.rmSync(manifestPath(root));
    expect(() => getProject(name)).toThrow(/No telar.yaml/);
  });

  test("refreshes the cached copy when telar.yaml is edited", () => {
    const { root, name } = freshProject();
    const edited = getProject(name).manifest;
    edited.gates = [{ name: "lint", run: "bun run lint" }];
    writeManifest(root, edited);

    // getProject picks up the change and writes it back into the registry cache
    expect(getProject(name).manifest.gates).toEqual(edited.gates);
    const reg = JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8"));
    expect(reg[name].manifest.gates).toEqual(edited.gates);
  });
});
