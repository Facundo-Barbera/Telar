import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { GitRunner } from "../../platform/git/runner";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import { useTempStores } from "../../../test/temp-store";

const { root } = useTempStores();

test("a commit needs a message and the message has a ceiling", () => {
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  expect(() => store.sessionGit.commit("session_one", "   ")).toThrow(EngineStateError);
  expect(() => store.sessionGit.commit("session_one", "x".repeat(2_001))).toThrow(EngineStateError);
});

/** Clone and register in one gesture. Git is stubbed: the registration uses the folder the clone created, and a failed clone registers nothing. */
describe("cloneProject", () => {
  /** A git that creates what it claims to have cloned, and records its argv. */
  const cloningGit = (calls: string[][] = []): GitRunner => (_cwd, args) => {
    calls.push(args);
    if (args[0] === "clone") fs.mkdirSync(args[args.length - 1], { recursive: true });
    return { status: 0, stdout: "", stderr: "" };
  };

  test("what landed is what gets registered, named after the folder git chose", async () => {
    const parent = fs.realpathSync.native(root());
    const calls: string[][] = [];
    const store = new EngineStore(root(), () => 100, { git: cloningGit(calls) });
    const project = await store.sessionGit.cloneProject({ url: "https://github.com/owner/repo.git", parent });
    expect(project).toMatchObject({ name: "repo", root: path.join(parent, "repo") });
    // And it is in the registry, which is the half a two-call client could miss.
    expect(store.projectRegistry.list().map((entry) => entry.id)).toEqual([project.id]);
    expect(calls[0]).toEqual(["clone", "--", "https://github.com/owner/repo.git", path.join(parent, "repo")]);
  });

  test("a name can be given, and a blank one falls back to the folder", async () => {
    const parent = fs.realpathSync.native(root());
    const store = new EngineStore(root(), () => 100, { git: cloningGit() });
    expect((await store.sessionGit.cloneProject({ url: "https://x.test/a/one.git", parent, name: "Mine" })).name).toBe("Mine");
    expect((await store.sessionGit.cloneProject({ url: "https://x.test/a/two.git", parent, name: "   " })).name).toBe("two");
  });

  test("a clone that failed registers nothing, and says why in git's own words", async () => {
    const parent = fs.realpathSync.native(root());
    const store = new EngineStore(root(), () => 100, {
      git: () => ({ status: 128, stdout: "", stderr: "fatal: repository not found\n" }),
    });
    await expect(store.sessionGit.cloneProject({ url: "https://x.test/a/gone.git", parent })).rejects.toThrow(/repository not found/);
    expect(store.projectRegistry.list()).toEqual([]);
  });

  test("a target that already exists is a conflict rather than a merge into it", async () => {
    const parent = fs.realpathSync.native(root());
    fs.mkdirSync(path.join(parent, "repo"));
    const calls: string[][] = [];
    const store = new EngineStore(root(), () => 100, { git: cloningGit(calls) });
    await expect(store.sessionGit.cloneProject({ url: "https://x.test/a/repo.git", parent })).rejects.toThrow(EngineStateError);
    // Refused before git ran, so nothing was written into somebody's folder.
    expect(calls).toEqual([]);
  });
});

test("the gitignore write has an undo, and it is the project's own block only", () => {
  // Adding a project ignores Telar's files WITHOUT asking now, so the toast's
  // Undo has to reach the engine — and reach only what the engine wrote.
  const projectRoot = fs.realpathSync.native(root());
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), "node_modules/\n");
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.projectRegistry.register({ id: "project_one", name: "One", root: projectRoot });

  const added = store.sessionGit.gitignore("project_one");
  expect(added.added.length).toBeGreaterThan(0);
  const removal = store.sessionGit.undoGitignore("project_one");
  expect(removal.removed).toEqual(added.added);
  expect(fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8")).toBe("node_modules/\n");
  // Twice is not an error: the toast may arrive after a hand edit.
  expect(store.sessionGit.undoGitignore("project_one").removed).toEqual([]);
});
