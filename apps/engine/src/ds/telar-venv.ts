/**
 * Telar's own Python environments — one per project, and one per worktree.
 *
 * THE PROJECT'S ENVIRONMENT IS NEVER WRITTEN TO. The kernel bridge needs
 * `ipykernel` and `jupyter_client`; putting them into somebody's `.venv` would
 * change their lockfile's truth without a commit saying so. So they go into a
 * venv Telar owns under its own home, created with `uv venv --python <theirs>`
 * — the same interpreter, so compiled wheels on the project's `site-packages`
 * match the ABI the bridge runs on — and the bridge puts THEIR site-packages on
 * its path rather than the other way round.
 *
 * `uv` IS THE ONLY TOOL USED HERE. It is fast enough that a venv is a
 * four-second affair, and it is the resolver the user named as their default.
 * A machine without it gets a refusal naming the install, not a fallback to
 * `python -m venv` that would then need `pip` and a different set of failures.
 */
import fs from "node:fs";
import path from "node:path";
import { BRIDGE_MODULES, STACK_MODULES, defaultExec, type Exec } from "./python-env";

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
};

async function uvAvailable(exec: Exec): Promise<boolean> {
  const result = await exec("uv", ["--version"], { timeoutMs: 5_000 }).catch(() => undefined);
  return Boolean(result && result.status === 0);
}

/**
 * Create the venv if absent, then make sure the bridge (and optionally the
 * stack) is installed. Idempotent: `uv pip install` on an already-satisfied
 * set is a no-op measured in milliseconds.
 */
export async function ensureTelarVenv(dir: string, options: EnsureVenvOptions): Promise<VenvOutcome> {
  const exec = options.exec ?? defaultExec;
  if (!(await uvAvailable(exec))) {
    return { ok: false, reason: "uv is not installed — see https://docs.astral.sh/uv/getting-started/installation/" };
  }
  if (!telarVenvPython(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const created = await exec("uv", ["venv", "--python", options.basePython, dir], { timeoutMs: 60_000 });
    if (created.status !== 0) return { ok: false, reason: lastLine(created.stderr) || "uv venv failed" };
  }
  const python = telarVenvPython(dir);
  if (!python) return { ok: false, reason: "venv was created but has no python executable" };
  const packages = [...BRIDGE_MODULES, ...(options.stack ? STACK_MODULES : [])];
  const installed = await exec("uv", ["pip", "install", "--python", python, ...packages], { timeoutMs: 300_000 });
  if (installed.status !== 0) return { ok: false, reason: lastLine(installed.stderr) || "uv pip install failed" };
  return { ok: true, python, installed: packages };
}

export function removeTelarVenv(dir: string): boolean {
  fs.rmSync(dir, { recursive: true, force: true });
  return !fs.existsSync(dir);
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop() ?? "";
}
