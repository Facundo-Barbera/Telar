/**
 * The tools a Python environment is made with — uv, conda, Homebrew — and the
 * Pythons uv knows about, installed or downloadable.
 *
 * FOUND, NEVER ASSUMED. A Finder-launched engine has whatever PATH
 * `hydrateHostPath` recovered from the login shell, which is usually right and
 * occasionally bare. So every binary is looked for on PATH first and then in
 * the handful of places installers put it — the same courtesy
 * `cli-resolution.ts` extends to `gh` and `bun`. A tool installed a minute ago
 * by one of our own bootstrap jobs is found the same way, before any restart.
 *
 * `uv python list --output-format json` is the source of truth for Pythons: it
 * names the ones on disk (Homebrew's, pyenv's, its own) AND the ones it can
 * fetch, which is what lets "install Python 3.13" be a button rather than a
 * documentation link.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultExec, type Exec } from "./python-env";

export type ToolInfo = { path: string; version: string };
export type CondaInfo = ToolInfo & { flavour: "conda" | "mamba" | "micromamba" };

export type PythonVersion = {
  /** "3.13.2" */
  version: string;
  /** "3.13" — what `uv venv --python` and `conda create python=` take. */
  minor: string;
  /** Absolute interpreter when installed; absent when uv can only download it. */
  path?: string;
  installed: boolean;
  prerelease: boolean;
};

export type Toolchain = {
  uv?: ToolInfo;
  conda?: CondaInfo;
  brew?: ToolInfo;
  pythons: PythonVersion[];
};

const home = () => os.homedir();

/** Where installers put a binary when it is not on PATH yet. */
const FALLBACK_DIRS: Record<string, () => string[]> = {
  uv: () => [path.join(home(), ".local", "bin"), path.join(home(), ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"],
  brew: () => ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"],
  conda: () => [
    path.join(home(), "miniforge3", "bin"),
    path.join(home(), "miniconda3", "bin"),
    path.join(home(), "anaconda3", "bin"),
    path.join(home(), "mambaforge", "bin"),
    "/opt/homebrew/Caskroom/miniforge/base/bin",
    "/opt/homebrew/Caskroom/miniconda/base/bin",
    "/opt/miniconda3/bin",
    "/opt/anaconda3/bin",
    "/usr/local/Caskroom/miniforge/base/bin",
  ],
  micromamba: () => [path.join(home(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"],
};

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** PATH first, then the fallbacks for `name`. */
export function findBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (executable(candidate)) return candidate;
  }
  for (const dir of FALLBACK_DIRS[name]?.() ?? []) {
    const candidate = path.join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

async function version(exec: Exec, file: string, args: string[] = ["--version"]): Promise<string | undefined> {
  const result = await exec(file, args, { timeoutMs: 10_000 }).catch(() => undefined);
  if (!result || result.status !== 0) return undefined;
  // "uv 0.12.5 (Homebrew ...)", "conda 24.11.0", "Homebrew 4.4.0", "1.5.8" (micromamba)
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout || result.stderr);
  return match?.[1];
}

export async function findUv(exec: Exec = defaultExec, env = process.env): Promise<ToolInfo | undefined> {
  const file = findBinary("uv", env);
  if (!file) return undefined;
  const found = await version(exec, file);
  return found ? { path: file, version: found } : undefined;
}

export async function findBrew(exec: Exec = defaultExec, env = process.env): Promise<ToolInfo | undefined> {
  const file = findBinary("brew", env);
  if (!file) return undefined;
  const found = await version(exec, file);
  return found ? { path: file, version: found } : undefined;
}

/** conda, else mamba, else micromamba — all speak the `env list --json` / `create` / `install` dialect we use. */
export async function findConda(exec: Exec = defaultExec, env = process.env): Promise<CondaInfo | undefined> {
  for (const flavour of ["conda", "mamba", "micromamba"] as const) {
    const file = findBinary(flavour, env);
    if (!file) continue;
    const found = await version(exec, file);
    if (found) return { path: file, version: found, flavour };
  }
  return undefined;
}

type UvPythonRow = {
  key: string;
  version: string;
  path: string | null;
  variant?: string;
  implementation?: string;
};

/**
 * Every CPython uv can see or fetch, newest first, one row per patch version.
 * An installed row wins over a downloadable one of the same version; free-
 * threaded and PyPy builds are left out because the analysis stack's wheels
 * are built for the default variant.
 */
export async function listPythons(uv: string, exec: Exec = defaultExec): Promise<PythonVersion[]> {
  const result = await exec(uv, ["python", "list", "--output-format", "json"], { timeoutMs: 30_000 }).catch(() => undefined);
  if (!result || result.status !== 0) return [];
  let rows: UvPythonRow[];
  try {
    rows = JSON.parse(result.stdout) as UvPythonRow[];
  } catch {
    return [];
  }
  const byVersion = new Map<string, PythonVersion>();
  for (const row of rows) {
    if ((row.variant && row.variant !== "default") || (row.implementation && row.implementation !== "cpython")) continue;
    const minor = row.version.split(".").slice(0, 2).join(".");
    const entry: PythonVersion = {
      version: row.version,
      minor,
      installed: row.path !== null,
      prerelease: /[a-z]/i.test(row.version),
      ...(row.path ? { path: row.path } : {}),
    };
    const existing = byVersion.get(row.version);
    if (!existing || (!existing.installed && entry.installed)) byVersion.set(row.version, entry);
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** Without uv: whatever `python3.X` binaries PATH offers. Installed only. */
export function scanPathPythons(env: NodeJS.ProcessEnv = process.env): PythonVersion[] {
  const found = new Map<string, PythonVersion>();
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^python(3\.\d+)$/.exec(name);
      if (!match || !executable(path.join(dir, name))) continue;
      const minor = match[1]!;
      if (!found.has(minor)) found.set(minor, { version: minor, minor, path: path.join(dir, name), installed: true, prerelease: false });
    }
  }
  return [...found.values()].sort((a, b) => compareVersions(b.version, a.version));
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((p) => Number.parseInt(p, 10));
  const pb = b.split(/[.\-+]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    if (x !== y) return x - y;
  }
  return 0;
}

/** One probe of the whole toolchain. Spawns up to four processes; call from a page, not a poll. */
export async function toolchainStatus(exec: Exec = defaultExec, env = process.env): Promise<Toolchain> {
  const [uv, conda, brew] = await Promise.all([findUv(exec, env), findConda(exec, env), findBrew(exec, env)]);
  const pythons = uv ? await listPythons(uv.path, exec) : scanPathPythons(env);
  return { ...(uv ? { uv } : {}), ...(conda ? { conda } : {}), ...(brew ? { brew } : {}), pythons };
}

/**
 * After a bootstrap job installs a tool, its directory joins PATH for this
 * process so the kernel host and every later `exec("uv", …)` find it without
 * a restart. Idempotent.
 */
export function adoptBinaryDir(file: string, env: NodeJS.ProcessEnv = process.env): void {
  const dir = path.dirname(file);
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (entries.includes(dir)) return;
  env.PATH = [dir, ...entries].join(path.delimiter);
}
