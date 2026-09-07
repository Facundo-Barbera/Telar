import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preflightPython, projectEnvSignals, relativisePythonPath, resolvePythonPath, type Exec } from "../src/ds/python-env";
import { telarVenvDir } from "../src/ds/telar-venv";
import { discoverEnvironments, environmentRootOf, isCondaEnv, isVenv } from "../src/ds/environments";
import type { Toolchain } from "../src/ds/toolchain";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ds-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fakeVenv(dir: string, kind: "venv" | "conda" | "bare" = "venv"): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const python = path.join(bin, "python");
  fs.writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (kind === "venv") fs.writeFileSync(path.join(dir, "pyvenv.cfg"), "home = /usr/bin\n");
  if (kind === "conda") fs.mkdirSync(path.join(dir, "conda-meta"), { recursive: true });
  return python;
}

const PROBE_OK = JSON.stringify({ version: "3.12.1", versionInfo: [3, 12], sitePackages: [], modules: {} });

/** An exec that answers only what the test scripts. Any python binary probes ok. */
function scriptedExec(answers: Record<string, { status: number; stdout: string }>): Exec {
  return async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    for (const [pattern, answer] of Object.entries(answers)) {
      if (key.startsWith(pattern)) return { ...answer, stderr: "" };
    }
    if (file.endsWith("/python") || file.endsWith("/python3")) return { status: 0, stdout: `${PROBE_OK}\n`, stderr: "" };
    return { status: 127, stdout: "", stderr: "not scripted" };
  };
}

const NO_TOOLS: Toolchain = { pythons: [] };
const WITH_UV: Toolchain = { uv: { path: "/opt/homebrew/bin/uv", version: "0.12.5" }, pythons: [] };

test("a project venv is listed first, uv's pick second, and the same environment shows once", async () => {
  const project = root();
  const venvPython = fakeVenv(path.join(project, ".venv"));
  fs.writeFileSync(path.join(project, "uv.lock"), "", "utf8");
  const exec = scriptedExec({ "/opt/homebrew/bin/uv python find": { status: 0, stdout: `${venvPython}\n` } });
  const environments = await discoverEnvironments(project, { exec, toolchain: { ...WITH_UV, pythons: [{ version: "3.14.7", minor: "3.14", path: "/opt/homebrew/bin/python3.14", installed: true, prerelease: false }] } });
  expect(environments.map((e) => [e.manager, e.name, e.location])).toEqual([["venv", ".venv", "project"], ["system", "Python 3.14.7", "user"]]);
  expect(environments[0]!.reason).toBe("found .venv/ in the checkout");
  expect(environments[0]!.preflight.ok).toBe(true);
  expect(projectEnvSignals(project)).toEqual(["uv.lock"]);
});

test("a venv whose python is a symlink to the base interpreter is still its own environment", async () => {
  const project = root();
  const base = fakeVenv(root(), "bare");
  const venvDir = path.join(project, ".venv");
  fs.mkdirSync(path.join(venvDir, "bin"), { recursive: true });
  fs.symlinkSync(base, path.join(venvDir, "bin", "python"));
  fs.writeFileSync(path.join(venvDir, "pyvenv.cfg"), "");
  const exec = scriptedExec({ "/opt/homebrew/bin/uv python find": { status: 0, stdout: `${base}\n` } });
  const environments = await discoverEnvironments(project, { exec, toolchain: WITH_UV });
  expect(environments.map((e) => e.manager)).toEqual(["venv", "system"]);
});

test("conda environments come from `conda env list` and the registry file, deduped; Telar's venv is offered when it exists", async () => {
  const project = root();
  const condaHome = root();
  fakeVenv(condaHome, "conda");
  fs.mkdirSync(path.join(condaHome, "condabin"));
  const named = path.join(condaHome, "envs", "ds-3.12");
  fakeVenv(named, "conda");
  const registry = path.join(root(), "environments.txt");
  fs.writeFileSync(registry, `${condaHome}\n${named}\n`);
  const engine = root();
  const telar = telarVenvDir(engine, "project_x");
  fakeVenv(telar);
  const exec = scriptedExec({ "/opt/conda/bin/conda env list --json": { status: 0, stdout: JSON.stringify({ envs: [condaHome, named] }) } });
  const environments = await discoverEnvironments(project, {
    exec,
    toolchain: { conda: { path: "/opt/conda/bin/conda", version: "24.1", flavour: "conda" }, pythons: [] },
    telarVenv: telar,
    condaEnvironmentsFile: registry,
  });
  expect(environments.map((e) => [e.manager, e.name])).toEqual([["conda", `base (${path.basename(condaHome)})`], ["conda", "ds-3.12"], ["telar", "Telar's environment"]]);
  expect(environments[2]!.location).toBe("telar");
});

test("nothing installed, nothing found — an empty list rather than a throw", async () => {
  expect(await discoverEnvironments(root(), { exec: scriptedExec({}), toolchain: NO_TOOLS })).toEqual([]);
});

test("an environment's root and manager are read off the directory", () => {
  const venv = root();
  fakeVenv(venv, "venv");
  const conda = root();
  fakeVenv(conda, "conda");
  const bare = root();
  fakeVenv(bare, "bare");
  expect(isVenv(venv)).toBe(true);
  expect(isCondaEnv(conda)).toBe(true);
  expect(environmentRootOf(path.join(venv, "bin", "python"))).toEqual({ root: venv, manager: "venv" });
  expect(environmentRootOf(path.join(conda, "bin", "python"))).toEqual({ root: conda, manager: "conda" });
  expect(environmentRootOf(path.join(bare, "bin", "python"))).toBeUndefined();
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

test("preflight asks about declared distributions and carries the answers", async () => {
  const python = fakeVenv(root());
  const exec: Exec = async (_file, args) => {
    expect(args.at(-1)).toBe("scikit-learn,numpy");
    return { status: 0, stdout: JSON.stringify({ version: "3.12.1", versionInfo: [3, 12], sitePackages: [], modules: {}, dists: { "scikit-learn": "1.5.0", numpy: null } }), stderr: "" };
  };
  const probe = await preflightPython(python, [], exec, ["scikit-learn", "numpy"]);
  expect(probe.dists).toEqual({ "scikit-learn": "1.5.0", numpy: null });
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
