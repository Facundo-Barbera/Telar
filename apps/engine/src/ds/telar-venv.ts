/**
 * Making environments — Telar's own, the project's `.venv`, a conda env — and
 * the bootstrap that makes making them possible (uv, a Python, conda).
 *
 * TWO SHAPES OF WORK LIVE HERE. `ensureTelarVenv` is synchronous-and-awaited
 * because the kernel host calls it at first start and needs an answer; it is
 * a few seconds with uv. Everything a PERSON triggers — creating an env with a
 * downloaded Python, installing the stack, fetching Miniforge — is returned as
 * `JobStep[]` for the `JobRunner`, because it takes minutes and the page wants
 * the log as it happens.
 *
 * THE BRIDGE'S PACKAGES GO INTO TELAR'S VENV AND NOWHERE ELSE. The project's
 * environment is written to only on request (see packages.ts); ipykernel and
 * jupyter_client are Telar's concern and never appear in anyone's lockfile.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobStep } from "./jobs";
import { BRIDGE_MODULES, STACK_MODULES, defaultExec, type Exec } from "./python-env";
import type { Toolchain } from "./toolchain";

export function telarPythonRoot(engineRoot: string): string {
  return path.join(engineRoot, "python");
}

/** `<engine>/python/<projectId>` or `<engine>/python/<projectId>/wt-<name>`. */
export function telarVenvDir(engineRoot: string, projectId: string, worktree?: string): string {
  const base = path.join(telarPythonRoot(engineRoot), projectId);
  return worktree ? path.join(base, `wt-${worktree}`) : base;
}

export function telarVenvPython(dir: string): string | undefined {
  for (const candidate of [path.join(dir, "bin", "python"), path.join(dir, "Scripts", "python.exe")]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return undefined;
}

export type VenvOutcome =
  | { ok: true; python: string; installed: string[] }
  | { ok: false; reason: string };

export type EnsureVenvOptions = {
  /** The interpreter to build on. Determines the ABI; must be the project's. */
  basePython: string;
  /** Also install the optional analysis stack. */
  stack?: boolean;
  exec?: Exec;
  /** Where uv is; defaults to PATH. */
  uv?: string;
};

async function uvAvailable(exec: Exec, uv: string): Promise<boolean> {
  const result = await exec(uv, ["--version"], { timeoutMs: 5_000 }).catch(() => undefined);
  return Boolean(result && result.status === 0);
}

const UV_MISSING = "uv is not installed — install it from the Data science settings, or see https://docs.astral.sh/uv/getting-started/installation/";

/**
 * Create the venv if absent, then make sure the bridge (and optionally the
 * stack) is installed. Idempotent: `uv pip install` on an already-satisfied
 * set is a no-op measured in milliseconds.
 */
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

/**
 * What a person asks for on the "New environment" form. `python` is a version
 * ("3.13"), which uv or conda will fetch if it is not on disk, or an absolute
 * interpreter to build on.
 */
export type CreateEnvironmentRequest =
  | { manager: "venv"; location: "project" | "telar"; python: string; stack?: boolean }
  | { manager: "conda"; name: string; python: string; stack?: boolean };

export type CreateEnvironmentPlan = {
  steps: JobStep[];
  /** Where the environment will be once the steps finish. */
  root: string;
  python: string;
};

const CONDA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PY_VERSION = /^3\.\d{1,2}(\.\d{1,3})?([a-z]+\d*)?$/;

/**
 * The steps that make an environment, and where it lands. Refuses before any
 * step runs when the request cannot succeed — a `.venv` that already exists,
 * a conda name that is taken, a manager that is not installed.
 */
export function planEnvironment(request: CreateEnvironmentRequest, toolchain: Toolchain, where: { projectRoot: string; telarVenv: string }): CreateEnvironmentPlan {
  if (!PY_VERSION.test(request.python) && !path.isAbsolute(request.python)) throw new Error(`"${request.python}" is neither a Python version like 3.13 nor an interpreter path`);
  const stack = request.stack ? [...STACK_MODULES] : [];

  if (request.manager === "venv") {
    if (!toolchain.uv) throw new Error(UV_MISSING);
    const root = request.location === "project" ? path.join(where.projectRoot, ".venv") : where.telarVenv;
    if (request.location === "project" && fs.existsSync(root)) throw new Error(".venv already exists in this project — use it from the list instead");
    if (request.location === "telar" && telarVenvPython(root)) throw new Error("Telar already has an environment for this project — use it from the list, or remove it first");
    const python = path.join(root, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
    const steps: JobStep[] = [
      { title: `Creating a venv on Python ${request.python}`, file: toolchain.uv.path, args: ["venv", "--python", request.python, root], cwd: where.projectRoot },
    ];
    // The stack goes into the project's venv only when asked; the bridge never does.
    if (stack.length) steps.push({ title: `Installing ${stack.join(", ")}`, file: toolchain.uv.path, args: ["pip", "install", "--python", python, ...stack] });
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
    { title: `Creating conda env ${request.name} on Python ${request.python}`, file: toolchain.conda.path, args: ["create", "-n", request.name, "-y", `python=${request.python}`, ...stack] },
  ];
  return { steps, root, python };
}

/** Where conda will put a named env: `<prefix>/envs/<name>`, prefix being two above the binary. */
export function condaEnvRoot(condaBinary: string, name: string): string {
  const prefix = path.dirname(path.dirname(condaBinary));
  const envsDir = fs.existsSync(path.join(prefix, "envs")) ? path.join(prefix, "envs") : path.join(os.homedir(), ".conda", "envs");
  return path.join(envsDir, name);
}

export type BootstrapRequest =
  | { what: "uv" }
  | { what: "python"; version: string }
  | { what: "conda" };

/**
 * The steps that install a tool. Homebrew when it is there — it puts the
 * binary where PATH already looks — else the vendor's installer. Every
 * download goes to a fresh temp file and is run from there; nothing is piped
 * from the network straight into a shell.
 */
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
