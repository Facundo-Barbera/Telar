import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalName, declaredDependencies, installCommandFor, installSteps, listPackages, projectRequirements, removeSteps, requirementsStep, validSpec } from "../src/ds/packages";
import { condaEnvRoot, planBootstrap, planEnvironment } from "../src/ds/telar-venv";
import type { Toolchain } from "../src/ds/toolchain";
import type { Exec } from "../src/ds/python-env";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-pkgs-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const UV: Toolchain = { uv: { path: "/opt/homebrew/bin/uv", version: "0.12.5" }, pythons: [] };
const CONDA: Toolchain = { conda: { path: "/opt/miniforge3/bin/conda", version: "24.11.0", flavour: "conda" }, pythons: [] };
const BREW: Toolchain = { brew: { path: "/opt/homebrew/bin/brew", version: "4.4" }, pythons: [] };
const venv = { manager: "venv" as const, root: "/p/.venv", python: "/p/.venv/bin/python" };
const conda = { manager: "conda" as const, root: "/opt/miniforge3/envs/ds", python: "/opt/miniforge3/envs/ds/bin/python" };

test("requirement specs admit names, extras and version clauses, and nothing shaped like a flag or a shell", () => {
  for (const good of ["pandas", "seaborn==0.13.2", "polars>=1.0,<2", "scikit-learn", "pyarrow[pandas]", "numpy~=2.1", "Django!=4.0"]) expect(validSpec(good)).toBe(true);
  for (const bad of ["--index-url evil", "-e .", "pandas; rm -rf /", "a b", "", "pandas && ls", "$(whoami)"]) expect(validSpec(bad)).toBe(false);
  expect(() => installSteps(venv, ["--upgrade"], UV)).toThrow(/not a package requirement/);
  expect(() => removeSteps(venv, ["pandas>=1"], UV)).toThrow(/not a package name/);
});

test("the manager decides the command: uv pip for venvs, conda for conda envs, pip when uv is absent", () => {
  expect(installSteps(venv, ["seaborn", "polars>=1"], UV)[0]).toMatchObject({ file: "/opt/homebrew/bin/uv", args: ["pip", "install", "--python", venv.python, "seaborn", "polars>=1"] });
  expect(removeSteps(venv, ["seaborn"], UV)[0]!.args).toEqual(["pip", "uninstall", "--python", venv.python, "seaborn"]);
  expect(installSteps(conda, ["seaborn"], CONDA)[0]).toMatchObject({ file: "/opt/miniforge3/bin/conda", args: ["install", "-p", conda.root, "-y", "seaborn"] });
  expect(installSteps(venv, ["seaborn"], { pythons: [] })[0]).toMatchObject({ file: venv.python, args: ["-m", "pip", "install", "seaborn"] });
  expect(removeSteps(venv, ["seaborn"], { pythons: [] })[0]!.args).toContain("-y");
  expect(() => installSteps(conda, ["x"], UV)).toThrow(/conda is not installed/);
});

test("a uv project's .venv is written with uv add / uv remove, so the manifest stays in step", () => {
  const project = root();
  fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\nname = \"x\"\n");
  const projectVenv = { manager: "venv" as const, root: path.join(project, ".venv"), python: path.join(project, ".venv", "bin", "python") };
  const add = installSteps(projectVenv, ["seaborn", "polars>=1"], UV, { root: project })[0]!;
  expect(add).toMatchObject({ file: UV.uv!.path, args: ["add", "seaborn", "polars>=1"], cwd: project });
  expect(add.env).toEqual({ UV_PROJECT_ENVIRONMENT: projectVenv.root });
  expect(removeSteps(projectVenv, ["seaborn"], UV, { root: project })[0]!.args).toEqual(["remove", "seaborn"]);
  // Another env keeps uv pip even beside the manifest; no manifest keeps uv pip in the .venv too.
  expect(installSteps(venv, ["seaborn"], UV, { root: project })[0]!.args[0]).toBe("pip");
  const bare = root();
  expect(installSteps({ ...projectVenv, root: path.join(bare, ".venv"), python: path.join(bare, ".venv", "bin", "python") }, ["seaborn"], UV, { root: bare })[0]!.args[0]).toBe("pip");

  expect(installCommandFor(projectVenv, UV, { root: project })).toBe("uv add");
  expect(installCommandFor(venv, UV, { root: project })).toBe("uv pip");
  expect(installCommandFor(conda, CONDA)).toBe("conda");
  expect(installCommandFor(venv, { pythons: [] })).toBe("pip");
});

test("declared dependencies come from pyproject and requirements.txt, canonical and deduped", () => {
  const project = root();
  expect(declaredDependencies(project)).toEqual([]);
  fs.writeFileSync(
    path.join(project, "pyproject.toml"),
    `[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "x"\ndependencies = [\n  "scikit-learn>=1.4",\n  'uvicorn[standard]==0.30',\n  "NumPy",\n]\n\n[dependency-groups]\ndev = ["pytest"]\n`,
  );
  fs.writeFileSync(path.join(project, "requirements.txt"), "# pinned\n-r base.txt\nnumpy\nrequests >=2\n");
  expect(declaredDependencies(project)).toEqual(["scikit-learn", "uvicorn", "numpy", "requests"]);
  expect(canonicalName("Scikit_Learn")).toBe("scikit-learn");
});

test("listPackages parses uv pip list and conda list", async () => {
  const exec: Exec = async (file, args) => {
    if (file.endsWith("uv")) return { status: 0, stdout: JSON.stringify([{ name: "pandas", version: "3.0.5" }, { name: "numpy", version: "2.3.1" }]), stderr: "" };
    if (file.endsWith("conda")) return { status: 0, stdout: JSON.stringify([{ name: "python", version: "3.12.4", channel: "conda-forge" }]), stderr: "" };
    return { status: 1, stdout: "", stderr: "boom" };
  };
  expect(await listPackages(venv, UV, exec)).toEqual([{ name: "numpy", version: "2.3.1" }, { name: "pandas", version: "3.0.5" }]);
  expect(await listPackages(conda, CONDA, exec)).toEqual([{ name: "python", version: "3.12.4", channel: "conda-forge" }]);
  expect(listPackages(venv, { pythons: [] }, exec)).rejects.toThrow("boom");
});

test("project manifests are detected and each becomes the right install step", () => {
  const project = root();
  expect(projectRequirements(project)).toEqual([]);
  fs.writeFileSync(path.join(project, "requirements.txt"), "pandas\n");
  fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\n");
  fs.writeFileSync(path.join(project, "environment.yml"), "name: x\n");
  expect(projectRequirements(project)).toEqual(["requirements.txt", "pyproject.toml", "environment.yml"]);

  const projectVenv = { manager: "venv" as const, root: path.join(project, ".venv"), python: path.join(project, ".venv", "bin", "python") };
  expect(requirementsStep(projectVenv, project, "requirements.txt", UV).args).toEqual(["pip", "install", "--python", projectVenv.python, "-r", path.join(project, "requirements.txt")]);
  const sync = requirementsStep(projectVenv, project, "pyproject.toml", UV);
  expect(sync.args).toEqual(["sync"]);
  expect(sync.env).toEqual({ UV_PROJECT_ENVIRONMENT: projectVenv.root });
  expect(requirementsStep(venv, project, "pyproject.toml", UV).args).toEqual(["pip", "install", "--python", venv.python, "-e", "."]);
  expect(requirementsStep(conda, project, "environment.yml", CONDA).args).toEqual(["env", "update", "-p", conda.root, "-f", path.join(project, "environment.yml"), "--prune"]);
  expect(() => requirementsStep(venv, project, "environment.yml", UV)).toThrow(/conda environment/);
  expect(() => requirementsStep(venv, project, "uv.lock", UV)).toThrow(/not in this project/);
});

test("planEnvironment shapes uv venv and conda create, and refuses what cannot succeed", () => {
  const project = root();
  const telar = path.join(root(), "python", "p");
  const inProject = planEnvironment({ manager: "venv", location: "project", python: "3.13", stack: true }, UV, { projectRoot: project, telarVenv: telar });
  expect(inProject.root).toBe(path.join(project, ".venv"));
  expect(inProject.steps.map((s) => s.args)).toEqual([
    ["venv", "--python", "3.13", path.join(project, ".venv")],
    ["pip", "install", "--python", inProject.python, "pandas", "matplotlib", "duckdb", "pyarrow"],
  ]);
  const underTelar = planEnvironment({ manager: "venv", location: "telar", python: "/usr/bin/python3" }, UV, { projectRoot: project, telarVenv: telar });
  expect(underTelar.steps.at(-1)!.args).toEqual(["pip", "install", "--python", underTelar.python, "ipykernel", "jupyter_client"]);

  fs.mkdirSync(path.join(project, ".venv"));
  expect(() => planEnvironment({ manager: "venv", location: "project", python: "3.13" }, UV, { projectRoot: project, telarVenv: telar })).toThrow(/already exists/);
  expect(() => planEnvironment({ manager: "venv", location: "telar", python: "3.13" }, { pythons: [] }, { projectRoot: project, telarVenv: telar })).toThrow(/uv is not installed/);
  expect(() => planEnvironment({ manager: "venv", location: "telar", python: "latest" }, UV, { projectRoot: project, telarVenv: telar })).toThrow(/neither a Python version/);

  const condaPlan = planEnvironment({ manager: "conda", name: "ds-3.12", python: "3.12", stack: true }, CONDA, { projectRoot: project, telarVenv: telar });
  expect(condaPlan.steps[0]!.args).toEqual(["create", "-n", "ds-3.12", "-y", "python=3.12", "pandas", "matplotlib", "duckdb", "pyarrow"]);
  expect(condaPlan.root).toBe(condaEnvRoot(CONDA.conda!.path, "ds-3.12"));
  expect(() => planEnvironment({ manager: "conda", name: "bad name", python: "3.12" }, CONDA, { projectRoot: project, telarVenv: telar })).toThrow(/name is letters/);
  expect(() => planEnvironment({ manager: "conda", name: "x", python: "3.12" }, UV, { projectRoot: project, telarVenv: telar })).toThrow(/conda is not installed/);
});

test("planBootstrap prefers Homebrew, falls back to the vendor installer, and refuses what is already there", () => {
  expect(planBootstrap({ what: "uv" }, BREW).steps[0]!.args).toEqual(["install", "uv"]);
  const script = planBootstrap({ what: "uv" }, { pythons: [] });
  expect(script.steps.map((s) => s.file)).toEqual(["curl", "sh"]);
  expect(script.steps[0]!.args.at(-1)).toBe("https://astral.sh/uv/install.sh");
  expect(() => planBootstrap({ what: "uv" }, UV)).toThrow(/already installed/);
  expect(planBootstrap({ what: "python", version: "3.13" }, UV).steps[0]!.args).toEqual(["python", "install", "3.13"]);
  expect(() => planBootstrap({ what: "python", version: "3.13" }, { pythons: [] })).toThrow(/uv is not installed/);
  expect(() => planBootstrap({ what: "python", version: "latest" }, UV)).toThrow(/not a Python version/);
  expect(planBootstrap({ what: "conda" }, BREW).steps[0]!.args).toEqual(["install", "--cask", "miniforge"]);
  expect(planBootstrap({ what: "conda" }, { pythons: [] }).steps[1]!.args).toContain("-b");
  expect(() => planBootstrap({ what: "conda" }, CONDA)).toThrow(/already installed/);
});
