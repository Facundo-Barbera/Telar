/**
 * Every Python ENVIRONMENT a project could run on — not every interpreter.
 *
 * The distinction is the whole feature. A person thinks in environments the
 * way PyCharm and Anaconda Navigator show them: "the project's .venv", "my
 * conda env ds-3.12", "Homebrew's Python 3.14" — each with a manager that
 * knows how to install into it. An interpreter path is what the kernel needs;
 * an environment is what a person picks and what a package manager acts on.
 *
 * Discovery is a LIST, NEVER A CHOICE (see python-env.ts). The order is the
 * order a person would guess: what is in the checkout, then conda envs, then
 * bare interpreters, then Telar's own.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultExec, preflightPython, projectEnvSignals, type Exec, type PythonPreflight } from "./python-env";
import type { Toolchain } from "./toolchain";
import { telarVenvPython } from "./telar-venv";

export type EnvManager = "venv" | "conda" | "system" | "telar";

export type PythonEnvironment = {
  /** Stable across probes: a digest of the environment's root. */
  id: string;
  manager: EnvManager;
  /** ".venv", "ds-3.12", "Python 3.14 (Homebrew)". */
  name: string;
  /** The env directory; for a bare interpreter, its bin directory. */
  root: string;
  /** Absolute interpreter. */
  python: string;
  location: "project" | "user" | "telar";
  reason: string;
  preflight: PythonPreflight;
};

/** Sans preflight — what discovery finds before it asks each interpreter. */
type Found = Omit<PythonEnvironment, "id" | "preflight">;

export function environmentId(root: string): string {
  return createHash("sha256").update(path.normalize(root)).digest("hex").slice(0, 16);
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function venvPython(dir: string): string | undefined {
  for (const candidate of [path.join(dir, "bin", "python"), path.join(dir, "Scripts", "python.exe")]) {
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/** A venv's `pyvenv.cfg` is the one file that says "this is an environment, not a Python". */
export function isVenv(dir: string): boolean {
  return fs.existsSync(path.join(dir, "pyvenv.cfg"));
}

/** A conda env carries `conda-meta/`; a base install carries it too. */
export function isCondaEnv(dir: string): boolean {
  return fs.existsSync(path.join(dir, "conda-meta"));
}

/** Env dir for a python path when it is a venv or conda env, else undefined. */
export function environmentRootOf(python: string): { root: string; manager: "venv" | "conda" } | undefined {
  const bin = path.dirname(python);
  const root = path.basename(bin) === "bin" || path.basename(bin) === "Scripts" ? path.dirname(bin) : bin;
  if (isCondaEnv(root)) return { root, manager: "conda" };
  if (isVenv(root)) return { root, manager: "venv" };
  return undefined;
}

export type DiscoverOptions = {
  exec?: Exec;
  toolchain: Toolchain;
  /** Telar's managed venv for this project, if any. */
  telarVenv?: string;
  /** Test seam: the user's conda registry file. */
  condaEnvironmentsFile?: string;
};

export async function listCondaEnvs(conda: string, exec: Exec, environmentsFile?: string): Promise<string[]> {
  const roots = new Set<string>();
  const result = await exec(conda, ["env", "list", "--json"], { timeoutMs: 20_000 }).catch(() => undefined);
  if (result && result.status === 0) {
    try {
      for (const env of (JSON.parse(result.stdout) as { envs?: string[] }).envs ?? []) roots.add(env);
    } catch { /* fall through to the registry file */ }
  }
  const registry = environmentsFile ?? path.join(os.homedir(), ".conda", "environments.txt");
  try {
    for (const line of fs.readFileSync(registry, "utf8").split("\n")) if (line.trim()) roots.add(line.trim());
  } catch { /* no registry */ }
  return [...roots].filter((root) => isCondaEnv(root));
}

/**
 * Everything, most specific first, deduped by the interpreter's bin directory
 * (a venv's `python` and `python3.12` are one environment; a venv and the
 * Python it was built from are two — see python-env.ts).
 */
export async function discoverEnvironments(projectRoot: string, options: DiscoverOptions): Promise<PythonEnvironment[]> {
  const exec = options.exec ?? defaultExec;
  const found: Found[] = [];
  const seen = new Set<string>();
  const add = (env: Found) => {
    const key = path.dirname(path.normalize(env.python));
    if (seen.has(key)) return;
    seen.add(key);
    found.push(env);
  };

  for (const name of [".venv", "venv", "env"]) {
    const dir = path.join(projectRoot, name);
    const python = venvPython(dir);
    if (!python) continue;
    add({ manager: isCondaEnv(dir) ? "conda" : "venv", name, root: dir, python, location: "project", reason: `found ${name}/ in the checkout` });
  }

  if (options.toolchain.uv) {
    const signals = projectEnvSignals(projectRoot);
    const uv = await exec(options.toolchain.uv.path, ["python", "find"], { cwd: projectRoot, timeoutMs: 10_000 }).catch(() => undefined);
    if (uv && uv.status === 0 && uv.stdout.trim()) {
      const python = uv.stdout.trim();
      const env = environmentRootOf(python);
      const inProject = !path.relative(projectRoot, python).startsWith("..");
      add(env
        ? { manager: env.manager, name: path.basename(env.root), root: env.root, python, location: inProject ? "project" : "user", reason: signals.length ? `uv's pick, honouring ${signals.join(", ")}` : "uv's pick for this project" }
        : { manager: "system", name: `Python ${versionFromPath(python)}`, root: path.dirname(python), python, location: "user", reason: signals.length ? `uv's pick, honouring ${signals.join(", ")}` : "uv's pick for this project" });
    }
  }

  if (options.toolchain.conda) {
    for (const root of await listCondaEnvs(options.toolchain.conda.path, exec, options.condaEnvironmentsFile)) {
      const python = venvPython(root);
      if (!python) continue;
      const isBase = fs.existsSync(path.join(root, "condabin")) || path.basename(path.dirname(root)) !== "envs";
      add({ manager: "conda", name: isBase ? `base (${path.basename(root)})` : path.basename(root), root, python, location: "user", reason: isBase ? "conda's base environment" : "a conda environment" });
    }
  }

  for (const version of options.toolchain.pythons) {
    if (!version.installed || !version.path) continue;
    add({ manager: "system", name: `Python ${version.version}`, root: path.dirname(version.path), python: version.path, location: "user", reason: describeSystemPython(version.path) });
  }

  if (options.telarVenv) {
    const python = telarVenvPython(options.telarVenv);
    if (python) add({ manager: "telar", name: "Telar's environment", root: options.telarVenv, python, location: "telar", reason: "built by Telar for this project" });
  }

  return Promise.all(found.map(async (env) => ({ ...env, id: environmentId(env.root), preflight: await preflightPython(env.python, undefined, exec) })));
}

function versionFromPath(python: string): string {
  return /python(\d+\.\d+)/.exec(python)?.[1] ?? "";
}

function describeSystemPython(python: string): string {
  if (python.includes("/Cellar/") || python.startsWith("/opt/homebrew/")) return "Homebrew";
  if (python.includes("/.local/share/uv/python/")) return "installed by uv";
  if (python.includes("/.pyenv/")) return "pyenv";
  if (python.startsWith("/usr/bin/") || python.startsWith("/Library/Developer/")) return "the system's";
  if (python.includes("/Library/Frameworks/Python.framework/")) return "python.org installer";
  return "on this machine";
}
