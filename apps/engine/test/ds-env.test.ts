import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectPythonCandidates,
  preflightPython,
  projectEnvSignals,
  relativisePythonPath,
  resolvePythonPath,
  type Exec,
} from "../src/ds/python-env";
import { telarVenvDir } from "../src/ds/telar-venv";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ds-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fakeVenv(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const python = path.join(bin, "python");
  fs.writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return python;
}

/** An exec that answers only what the test scripts, and fails everything else. */
function scriptedExec(answers: Record<string, { status: number; stdout: string }>): Exec {
  return async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    for (const [pattern, answer] of Object.entries(answers)) {
      if (key.startsWith(pattern)) return { ...answer, stderr: "" };
    }
    return { status: 127, stdout: "", stderr: "not scripted" };
  };
}

test("a project venv is listed first, uv second, and duplicates by real path collapse", async () => {
  const project = root();
  const venvPython = fakeVenv(path.join(project, ".venv"));
  fs.writeFileSync(path.join(project, "uv.lock"), "", "utf8");
  const exec = scriptedExec({
    // uv resolves to the same interpreter the venv scan found — must appear once.
    "uv python find": { status: 0, stdout: `${venvPython}\n` },
    "sh -c command -v python3": { status: 0, stdout: "/usr/bin/python3\n" },
  });
  const candidates = await detectPythonCandidates(project, { exec });
  expect(candidates.map((c) => c.kind)).toEqual(["project-venv", "path"]);
  expect(candidates[0]!.reason).toBe("found .venv/");
  expect(projectEnvSignals(project)).toEqual(["uv.lock"]);
});

test("pyenv is consulted only when .python-version is present; Telar's venv is offered when it exists", async () => {
  const project = root();
  const engine = root();
  const telar = telarVenvDir(engine, "project_x");
  const telarPython = fakeVenv(telar);
  const exec = scriptedExec({
    "pyenv which python": { status: 0, stdout: "/opt/pyenv/versions/3.12.1/bin/python\n" },
  });

  const without = await detectPythonCandidates(project, { exec, telarVenv: telar });
  expect(without.map((c) => c.kind)).toEqual(["telar"]);
  expect(without[0]!.path).toBe(telarPython);

  fs.writeFileSync(path.join(project, ".python-version"), "3.12.1\n", "utf8");
  const withPyenv = await detectPythonCandidates(project, { exec, telarVenv: telar });
  expect(withPyenv.map((c) => c.kind)).toEqual(["pyenv", "telar"]);
});

test("preflight refuses a path that is not executable and parses the probe's answer", async () => {
  const missing = await preflightPython(path.join(root(), "nope"));
  expect(missing.ok).toBe(false);
  expect(missing.reason).toBe("not an executable file");

  const python = fakeVenv(root());
  const exec = scriptedExec({
    [python]: {
      status: 0,
      stdout: JSON.stringify({ version: "3.12.1", versionInfo: [3, 12], sitePackages: ["/x/site-packages"], modules: { pandas: true, duckdb: false } }) + "\n",
    },
  });
  const probe = await preflightPython(python, ["pandas", "duckdb"], exec);
  expect(probe.ok).toBe(true);
  expect(probe.versionInfo).toEqual([3, 12]);
  expect(probe.modules).toEqual({ pandas: true, duckdb: false });

  const broken = await preflightPython(python, [], scriptedExec({ [python]: { status: 0, stdout: "Traceback\n" } }));
  expect(broken.ok).toBe(false);
});

test("a python inside the project stores relative and resolves back; one outside stays absolute", () => {
  const project = root();
  const inside = path.join(project, ".venv", "bin", "python");
  expect(relativisePythonPath(project, inside)).toBe(path.join(".venv", "bin", "python"));
  expect(resolvePythonPath(project, ".venv/bin/python")).toBe(path.join(project, ".venv/bin/python"));
  expect(relativisePythonPath(project, "/usr/bin/python3")).toBe("/usr/bin/python3");
  expect(resolvePythonPath(project, "/usr/bin/python3")).toBe("/usr/bin/python3");
});

test("Telar venv paths key by project, and by worktree beneath it", () => {
  expect(telarVenvDir("/e", "project_a")).toBe("/e/python/project_a");
  expect(telarVenvDir("/e", "project_a", "feature-x")).toBe("/e/python/project_a/wt-feature-x");
});
