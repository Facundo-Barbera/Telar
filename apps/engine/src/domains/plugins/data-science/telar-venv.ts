import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobStep } from "./jobs";
import { canonicalName, validSpec } from "./packages";
import { BRIDGE_MODULES, STACK_MODULES, defaultExec, type Exec } from "./python-env";
import type { Toolchain } from "./toolchain";

function telarPythonRoot(engineRoot: string): string {
  return path.join(engineRoot, "python");
}

export function telarVenvDir(engineRoot: string, projectId: string, worktree?: string): string {
  const base = path.join(telarPythonRoot(engineRoot), projectId);
  return worktree ? path.join(base, `wt-${worktree}`) : base;
}

export function telarVenvPython(dir: string): string | undefined {
  for (const candidate of [path.join(dir, "bin", "python"), path.join(dir, "Scripts", "python.exe")]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { }
  }
  return undefined;
}

export type VenvOutcome =
  | { ok: true; python: string; installed: string[] }
  | { ok: false; reason: string };

export type EnsureVenvOptions = {
  basePython: string;
  stack?: boolean;
  exec?: Exec;
  uv?: string;
};

async function uvAvailable(exec: Exec, uv: string): Promise<boolean> {
  const result = await exec(uv, ["--version"], { timeoutMs: 5_000 }).catch(() => undefined);
  return Boolean(result && result.status === 0);
}

const UV_MISSING = "uv is not installed — install it from the Data science settings, or see https://docs.astral.sh/uv/getting-started/installation/";

export async function ensureTelarVenv(dir: string, options: EnsureVenvOptions): Promise<VenvOutcome> {
  const exec = options.exec ?? defaultExec;
  const uv = options.uv ?? "uv";
  if (!(await uvAvailable(exec, uv))) return { ok: false, reason: UV_MISSING };
  if (!telarVenvPython(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const created = await exec(uv, ["venv", "--python", options.basePython, dir], { timeoutMs: 60_000 });
    if (created.status !== 0) return { ok: false, reason: lastLine(created.stderr) || "uv venv failed" };
  }
  const python = telarVenvPython(dir);
  if (!python) return { ok: false, reason: "venv was created but has no python executable" };
  const packages = [...BRIDGE_MODULES, ...(options.stack ? STACK_MODULES : [])];
  const installed = await exec(uv, ["pip", "install", "--python", python, ...packages], { timeoutMs: 300_000 });
  if (installed.status !== 0) return { ok: false, reason: lastLine(installed.stderr) || "uv pip install failed" };
  return { ok: true, python, installed: packages };
}

export function removeTelarVenv(dir: string): boolean {
  fs.rmSync(dir, { recursive: true, force: true });
  return !fs.existsSync(dir);
}

export type CreateEnvironmentRequest =
  | { manager: "venv"; location: "project" | "telar"; python: string; stack?: boolean }
  | { manager: "conda"; name: string; python: string; stack?: boolean };

export type CreateEnvironmentPlan = {
  steps: JobStep[];
  root: string;
  python: string;
};

const CONDA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PY_VERSION = /^3\.\d{1,2}(\.\d{1,3})?([a-z]+\d*)?$/;

function specName(spec: string): string {
  return canonicalName(/^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(spec.trim())?.[0] ?? spec.trim());
}

function plannedPackages(stack: readonly string[], machineDefaults: readonly string[] = []): string[] {
  const bad = machineDefaults.map((spec) => spec.trim()).filter((spec) => spec.length > 0 && !validSpec(spec));
  if (bad.length) {
    throw new Error(
      `this Mac's default packages include something that is not a package requirement: ${bad.join(", ")} — fix it in Settings › Plugins`,
    );
  }
  const packages = [...stack];
  const seen = new Set(packages.map(specName));
  for (const spec of machineDefaults.map((entry) => entry.trim()).filter(Boolean)) {
    const name = specName(spec);
    if (seen.has(name)) continue;
    seen.add(name);
    packages.push(spec);
  }
  return packages;
}

export function planEnvironment(
  request: CreateEnvironmentRequest,
  toolchain: Toolchain,
  where: {
    projectRoot: string;
    telarVenv: string;
    defaultPackages?: readonly string[];
  },
): CreateEnvironmentPlan {
  if (!PY_VERSION.test(request.python) && !path.isAbsolute(request.python)) throw new Error(`"${request.python}" is neither a Python version like 3.13 nor an interpreter path`);
  const packages = plannedPackages(request.stack ? STACK_MODULES : [], where.defaultPackages);

  if (request.manager === "venv") {
    if (!toolchain.uv) throw new Error(UV_MISSING);
    const root = request.location === "project" ? path.join(where.projectRoot, ".venv") : where.telarVenv;
    if (request.location === "project" && fs.existsSync(root)) throw new Error(".venv already exists in this project — use it from the list instead");
    if (request.location === "telar" && telarVenvPython(root)) throw new Error("Telar already has an environment for this project — use it from the list, or remove it first");
    const python = path.join(root, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
    const steps: JobStep[] = [
      { title: `Creating a venv on Python ${request.python}`, file: toolchain.uv.path, args: ["venv", "--python", request.python, root], cwd: where.projectRoot },
    ];
    if (packages.length) steps.push({ title: `Installing ${packages.join(", ")}`, file: toolchain.uv.path, args: ["pip", "install", "--python", python, ...packages] });
    if (request.location === "telar") steps.push({ title: "Installing the kernel bridge", file: toolchain.uv.path, args: ["pip", "install", "--python", python, ...BRIDGE_MODULES] });
    return { steps, root, python };
  }

  if (!toolchain.conda) throw new Error("conda is not installed — install Miniforge from the Data science settings");
  if (!CONDA_NAME.test(request.name)) throw new Error("a conda environment name is letters, digits, dots, dashes and underscores");
  if (path.isAbsolute(request.python)) throw new Error("conda builds on a Python VERSION (like 3.12), not on an interpreter path");
  const root = condaEnvRoot(toolchain.conda.path, request.name);
  if (fs.existsSync(root)) throw new Error(`a conda environment named ${request.name} already exists`);
  const python = path.join(root, "bin", "python");
  const steps: JobStep[] = [
    { title: `Creating conda env ${request.name} on Python ${request.python}`, file: toolchain.conda.path, args: ["create", "-n", request.name, "-y", `python=${request.python}`, ...packages] },
  ];
  return { steps, root, python };
}

export function condaEnvRoot(condaBinary: string, name: string): string {
  const prefix = path.dirname(path.dirname(condaBinary));
  const envsDir = fs.existsSync(path.join(prefix, "envs")) ? path.join(prefix, "envs") : path.join(os.homedir(), ".conda", "envs");
  return path.join(envsDir, name);
}

export type BootstrapRequest =
  | { what: "uv" }
  | { what: "python"; version: string }
  | { what: "conda" };

export function planBootstrap(request: BootstrapRequest, toolchain: Toolchain): { steps: JobStep[]; expectBinary?: string } {
  switch (request.what) {
    case "uv": {
      if (toolchain.uv) throw new Error(`uv ${toolchain.uv.version} is already installed`);
      if (toolchain.brew) return { steps: [{ title: "Installing uv with Homebrew", file: toolchain.brew.path, args: ["install", "uv"] }], expectBinary: "uv" };
      const script = path.join(os.tmpdir(), `telar-uv-install-${process.pid}.sh`);
      return {
        steps: [
          { title: "Downloading the uv installer", file: "curl", args: ["-LsSf", "-o", script, "https://astral.sh/uv/install.sh"] },
          { title: "Running the uv installer", file: "sh", args: [script], env: { UV_NO_MODIFY_PATH: "1" } },
        ],
        expectBinary: "uv",
      };
    }
    case "python": {
      if (!toolchain.uv) throw new Error(UV_MISSING);
      if (!PY_VERSION.test(request.version)) throw new Error(`"${request.version}" is not a Python version like 3.13`);
      return { steps: [{ title: `Installing Python ${request.version}`, file: toolchain.uv.path, args: ["python", "install", request.version] }] };
    }
    case "conda": {
      if (toolchain.conda) throw new Error(`${toolchain.conda.flavour} ${toolchain.conda.version} is already installed`);
      if (toolchain.brew) return { steps: [{ title: "Installing Miniforge with Homebrew", file: toolchain.brew.path, args: ["install", "--cask", "miniforge"] }], expectBinary: "conda" };
      const script = path.join(os.tmpdir(), `telar-miniforge-${process.pid}.sh`);
      const system = process.platform === "darwin" ? "MacOSX" : "Linux";
      const arch = process.arch === "arm64" ? "arm64" : "x86_64";
      const target = path.join(os.homedir(), "miniforge3");
      return {
        steps: [
          { title: "Downloading Miniforge", file: "curl", args: ["-LsSf", "-o", script, `https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-${system}-${arch}.sh`] },
          { title: `Installing Miniforge into ${target}`, file: "bash", args: [script, "-b", "-p", target] },
        ],
        expectBinary: "conda",
      };
    }
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop() ?? "";
}
