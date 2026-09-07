import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function fakeTectonic(): string {
  const binDir = dir("telar-latex-bin-");
  const file = path.join(binDir, "tectonic");
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}

function readyStore(): { store: EngineStore; projectRoot: string } {
  const store = new EngineStore(dir("telar-latex-project-"), () => 100);
  const projectRoot = dir("telar-latex-checkout-");
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  return { store, projectRoot };
}

test("a project starts with no latex block; a patch adds one and null removes it", () => {
  const { store } = readyStore();
  expect(store.getProject("project_one").latex).toBeUndefined();
  const config = { enabled: true, toolchain: { kind: "tectonic" as const, path: fakeTectonic() }, mainFile: "main.tex" };
  expect(store.updateProject("project_one", { latex: config }).latex).toEqual(config);
  expect(store.getProject("project_one").latex).toEqual(config);
  const off = store.updateProject("project_one", { latex: null });
  expect(off.latex).toBeUndefined();
  expect("latex" in JSON.parse(fs.readFileSync(path.join(store.paths.root, "projects.json"), "utf8")).projects[0]).toBe(false);
});

test("an invalid latex block is refused; dataScience beside it is untouched", () => {
  const { store } = readyStore();
  expect(() => store.updateProject("project_one", { latex: { enabled: "yes" } as never })).toThrow(EngineStateError);
  store.updateProject("project_one", { dataScience: { enabled: true } });
  store.updateProject("project_one", { latex: { enabled: true } });
  const project = store.getProject("project_one");
  expect(project.dataScience?.enabled).toBe(true);
  expect(project.latex?.enabled).toBe(true);
});

test("enabling on a git checkout gitignores the aux dir", () => {
  const { store, projectRoot } = readyStore();
  fs.mkdirSync(path.join(projectRoot, ".git"));
  store.updateProject("project_one", { latex: { enabled: true } });
  expect(fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8")).toContain(".telar/latex/");
});

test("the session door refuses until the project opted in AND the binary exists", () => {
  const { store } = readyStore();
  const session = store.createSession({ projectId: "project_one", environmentId: "local", envMode: "local" });
  expect(() => store.latex(session.id)).toThrow("LaTeX is not enabled");
  // Enabled but pointing at a binary that is not on disk: still nothing.
  store.updateProject("project_one", { latex: { enabled: true, toolchain: { kind: "tectonic", path: "/nope/tectonic" } } });
  expect(() => store.latex(session.id)).toThrow("LaTeX is not enabled");
  expect(store.resolveLatex(store.getSession(session.id))).toBeUndefined();
  // A real binary opens the door.
  store.updateProject("project_one", { latex: { enabled: true, toolchain: { kind: "tectonic", path: fakeTectonic() }, mainFile: "main.tex" } });
  const resolved = store.resolveLatex(store.getSession(session.id));
  expect(resolved?.kind).toBe("tectonic");
  expect(resolved?.mainFile).toBe("main.tex");
  expect(store.latex(session.id)).toBeDefined();
});
