/**
 * Proving a Python works, and the path rules for storing one.
 *
 * PREFLIGHT IS A SUBPROCESS, NOT A GUESS. The only honest way to know whether
 * `pandas` imports under an interpreter is to ask that interpreter. The probe
 * script is tiny, prints one JSON line, and never imports anything the caller
 * did not name — so a broken optional library reports as missing rather than
 * taking the probe down with it.
 *
 * Finding interpreters is `environments.ts`'s job; this file is what every
 * finder calls on each one it finds.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The libraries the `ds_*` tools gate on. Probed, never assumed. */
export const STACK_MODULES = ["pandas", "matplotlib", "duckdb", "pyarrow"] as const;
export type StackModule = (typeof STACK_MODULES)[number];

/** What the bridge needs; lives in Telar's venv, never installed into the project's. */
export const BRIDGE_MODULES = ["ipykernel", "jupyter_client"] as const;

export type PythonPreflight = {
  ok: boolean;
  path: string;
  version?: string;
  /** `[major, minor]` — the ABI a compiled wheel is locked to. */
  versionInfo?: [number, number];
  sitePackages?: string[];
  modules?: Record<string, boolean>;
  reason?: string;
};

const PROBE = `
import json, sys, importlib.util
mods = sys.argv[1].split(",") if len(sys.argv) > 1 and sys.argv[1] else []
try:
    import site
    sp = [p for p in site.getsitepackages()] if hasattr(site, "getsitepackages") else []
    usp = site.getusersitepackages() if hasattr(site, "getusersitepackages") else None
    if usp and usp not in sp: sp.append(usp)
except Exception:
    sp = []
print(json.dumps({
    "version": sys.version.split()[0],
    "versionInfo": [sys.version_info[0], sys.version_info[1]],
    "sitePackages": sp,
    "modules": {m: importlib.util.find_spec(m) is not None for m in mods},
}))
`.trim();

export type Exec = (file: string, args: string[], options: { cwd?: string; timeoutMs: number }) =>
  Promise<{ status: number; stdout: string; stderr: string }>;

export const defaultExec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const status = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ status, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Marker files whose presence says "this project has a Python environment story". */
const ENV_SIGNALS = ["uv.lock", "pyproject.toml", "poetry.lock", "Pipfile.lock", "requirements.txt", "environment.yml"] as const;

export function projectEnvSignals(root: string): string[] {
  return ENV_SIGNALS.filter((name) => fs.existsSync(path.join(root, name)));
}

/** Ask an interpreter what it is and which of `modules` it can import. */
export async function preflightPython(
  pythonPath: string,
  modules: readonly string[] = [...STACK_MODULES],
  exec: Exec = defaultExec,
): Promise<PythonPreflight> {
  if (!isExecutable(pythonPath)) return { ok: false, path: pythonPath, reason: "not an executable file" };
  const result = await exec(pythonPath, ["-I", "-c", PROBE, modules.join(",")], { timeoutMs: 15_000 }).catch(
    (error: unknown) => ({ status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }),
  );
  if (result.status !== 0) {
    return { ok: false, path: pythonPath, reason: result.stderr.trim().split("\n").pop() || `exited ${result.status}` };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as {
      version: string; versionInfo: [number, number]; sitePackages: string[]; modules: Record<string, boolean>;
    };
    return { ok: true, path: pythonPath, version: parsed.version, versionInfo: parsed.versionInfo, sitePackages: parsed.sitePackages, modules: parsed.modules };
  } catch {
    return { ok: false, path: pythonPath, reason: "probe printed something that was not JSON" };
  }
}

/**
 * Store a path relative to the project root when it lives inside it — so a
 * worktree resolves `.venv/bin/python` against its own tree — and absolute
 * otherwise. `resolvePythonPath` is the inverse.
 */
export function relativisePythonPath(root: string, pythonPath: string): string {
  const relative = path.relative(root, pythonPath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return pythonPath;
}

export function resolvePythonPath(root: string, stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(root, stored);
}
