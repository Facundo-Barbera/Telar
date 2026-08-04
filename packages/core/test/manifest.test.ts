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
  ensureTelarGitignore,
  getProject,
  guardrailsForRoot,
  listProjects,
  loadManifest,
  registerProject,
  registerOrCreateProject,
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

  // The lookup an Ultra RESUME depends on. Everything downstream of a launch
  // knows a project as a PATH (UltraManifest.project stores the root), so a
  // resume that inherits its original project has a root and no name — without
  // a by-root lookup it could only be guarded when the caller happened to
  // re-supply the project by name, which is opt-out-by-re-entry.
  test("guardrailsForRoot finds a registered project by its root", () => {
    const m = loadValid();
    m.guardrails = { disallowedTools: ["WebFetch"], protectedPaths: [".env"] };
    writeManifest(projRoot, m);

    const found = guardrailsForRoot(projRoot);
    expect(found?.disallowedTools).toEqual(["WebFetch"]);
    expect(found?.protectedPaths).toEqual([".env"]);
    // Same answer for a non-canonical spelling of the same root — the resume
    // path passes whatever the manifest stored.
    expect(guardrailsForRoot(path.join(projRoot, "."))?.protectedPaths).toEqual([".env"]);

    writeManifest(projRoot, loadValid());
  });

  test("guardrailsForRoot returns undefined for an unregistered root", () => {
    // The caller then launches with the control-plane rule only, rather than
    // failing the run — an unregistered root is not a reason to refuse work.
    expect(guardrailsForRoot(path.join(os.tmpdir(), "telar-not-a-project"))).toBeUndefined();
  });

  test("getProject throws on unknown, unregisterProject removes entry only", () => {
    expect(() => getProject("nope")).toThrow(/Unknown project/);
    expect(unregisterProject(path.basename(projRoot))).toBe(true);
    expect(unregisterProject(path.basename(projRoot))).toBe(false);
    expect(fs.existsSync(path.join(projRoot, "telar.yaml"))).toBe(true);
  });
});

describe("automatic registration", () => {
  const roots: string[] = [];
  const freshRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-register-"));
    roots.push(root);
    return root;
  };

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  test("creates and registers telar.yaml when the repo does not have one", () => {
    const root = freshRoot();
    const result = registerOrCreateProject(root);
    const directoryName = path.basename(root);

    expect(result.created).toBe(true);
    expect(result.manifest.name).toBe(directoryName);
    expect(loadManifest(root).gates).toEqual([]);
    expect(fs.readFileSync(path.join(root, "telar.yaml"), "utf8")).not.toMatch(
      /^account:/m,
    );
    expect(getProject(directoryName).entry.root).toBe(path.resolve(root));
  });

  test("detects and preserves an existing telar.yaml", () => {
    const root = freshRoot();
    const existing = ProjectManifest.parse({
      name: "automatic-existing",
      root,
      account: "work",
      gates: [{ name: "lint", run: "bun run lint" }],
    });
    writeManifest(root, existing);
    const before = fs.readFileSync(path.join(root, "telar.yaml"), "utf8");

    const result = registerOrCreateProject(root, {
      name: "must-not-overwrite",
      account: "personal",
      gates: [],
    });

    expect(result.created).toBe(false);
    expect(result.manifest.name).toBe("automatic-existing");
    expect(result.manifest.account).toBe("work");
    expect(fs.readFileSync(path.join(root, "telar.yaml"), "utf8")).toBe(before);
  });

  test("optionally adds canonical Telar rules to .gitignore exactly once", () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");

    const first = registerOrCreateProject(
      root,
      { name: "automatic-ignored" },
      { addToGitignore: true },
    );
    const afterFirst = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    const second = ensureTelarGitignore(root);

    expect(first.gitignoreEntriesAdded).toEqual(["telar.yaml", ".telar/"]);
    expect(afterFirst).toBe("node_modules\ntelar.yaml\n.telar/\n");
    expect(second).toEqual([]);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(afterFirst);
  });

  test("recognizes equivalent root-anchored ignore rules", () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, ".gitignore"), "/telar.yaml\n/.telar\n");
    expect(ensureTelarGitignore(root)).toEqual([]);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(
      "/telar.yaml\n/.telar\n",
    );
  });
});

// telar.yaml is COMMITTED, so an absolute path in it is the one field that
// cannot be true for two checkouts at once. These pin the replacement rule:
// the file never carries `root`, and the directory it was read from is the
// answer. The bug in the room: a manifest saying
// `/Users/facundo/Projects/personal/telar` on a machine that cloned to
// ~/Projects/Telar, which put a session in /private/tmp with no workspace.
describe("root is derived from the directory, never from the file", () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "telar-shared-"));

  test("writeManifest does not persist root", () => {
    writeManifest(shared, ProjectManifest.parse({ name: "shared", root: "/somewhere/else" }));
    const raw = fs.readFileSync(path.join(shared, "telar.yaml"), "utf8");
    expect(raw).not.toMatch(/^root:/m);
    expect(raw).toMatch(/^name: shared$/m);
  });

  test("loadManifest fills root from where the file actually is", () => {
    expect(loadManifest(shared).root).toBe(path.resolve(shared));
  });

  test("a teammate's committed root is IGNORED, not honoured", () => {
    // Exactly the file that caused the incident — another machine's absolute
    // path, checked in. Reading it here must yield THIS checkout.
    fs.writeFileSync(
      path.join(shared, "telar.yaml"),
      "name: shared\nroot: /Users/someone-else/Projects/personal/telar\n",
    );
    expect(loadManifest(shared).root).toBe(path.resolve(shared));
  });

  test("a manifest with no root at all loads fine", () => {
    fs.writeFileSync(path.join(shared, "telar.yaml"), "name: shared\n");
    const m = loadManifest(shared);
    expect(m.root).toBe(path.resolve(shared));
    expect(m.name).toBe("shared");
  });

  test("the roundtrip is stable — load, write, load again", () => {
    const once = loadManifest(shared);
    writeManifest(shared, once);
    expect(loadManifest(shared)).toEqual(once);
  });

  test("a moved checkout reads as its new location", () => {
    const moved = fs.mkdtempSync(path.join(os.tmpdir(), "telar-moved-"));
    fs.copyFileSync(path.join(shared, "telar.yaml"), path.join(moved, "telar.yaml"));
    expect(loadManifest(moved).root).toBe(path.resolve(moved));
    expect(loadManifest(shared).root).toBe(path.resolve(shared));
    fs.rmSync(moved, { recursive: true, force: true });
  });

  afterAll(() => fs.rmSync(shared, { recursive: true, force: true }));
});

function loadValid() {
  return ProjectManifest.parse({ name: path.basename(projRoot), root: path.resolve(projRoot) });
}
