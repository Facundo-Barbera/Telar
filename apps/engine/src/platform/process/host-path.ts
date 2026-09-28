import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const ENV_NAME = /^[A-Z0-9_]+$/;

const SHELL_TIMEOUT_MS = 5_000;
const LAUNCHCTL_TIMEOUT_MS = 2_000;

type ExecFileLike = (file: string, args: readonly string[], options: { encoding: "utf8"; timeout: number }) => string;

const trimmed = (value: string | null | undefined): string | undefined => {
  const clean = value?.trim();
  return clean ? clean : undefined;
};

function userLoginShell(): string | undefined {
  try {
    return trimmed(os.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function loginShellCandidates(platform: NodeJS.Platform, shell: string | undefined, account = userLoginShell()): string[] {
  const fallback = platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of [trimmed(shell), trimmed(account), fallback]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

const startMarker = (name: string): string => `__TELAR_ENV_${name}_START__`;
const endMarker = (name: string): string => `__TELAR_ENV_${name}_END__`;

function captureCommand(names: readonly string[]): string {
  return names
    .map((name) => {
      if (!ENV_NAME.test(name)) throw new Error(`unsupported environment variable name: ${name}`);
      return [`printf '%s\\n' '${startMarker(name)}'`, `printenv ${name} || true`, `printf '%s\\n' '${endMarker(name)}'`].join("; ");
    })
    .join("; ");
}

export function valueBetweenMarkers(output: string, name: string): string | undefined {
  const start = output.indexOf(startMarker(name));
  if (start === -1) return undefined;
  const from = start + startMarker(name).length;
  const end = output.indexOf(endMarker(name), from);
  if (end === -1) return undefined;
  const value = output.slice(from, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return value.length > 0 ? value : undefined;
}

function readEnvFromLoginShell(
  shell: string,
  names: readonly string[],
  execFile: ExecFileLike = execFileSync as unknown as ExecFileLike,
): Record<string, string | undefined> {
  if (names.length === 0) return {};
  const output = execFile(shell, ["-ilc", captureCommand(names)], { encoding: "utf8", timeout: SHELL_TIMEOUT_MS });
  const environment: Record<string, string | undefined> = {};
  for (const name of names) {
    const value = valueBetweenMarkers(output, name);
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function readPathFromLaunchctl(execFile: ExecFileLike = execFileSync as unknown as ExecFileLike): string | undefined {
  try {
    return trimmed(execFile("/bin/launchctl", ["getenv", "PATH"], { encoding: "utf8", timeout: LAUNCHCTL_TIMEOUT_MS }));
  } catch {
    return undefined;
  }
}

export function mergePathEntries(preferred: string | undefined, inherited: string | undefined, platform: NodeJS.Platform): string | undefined {
  const delimiter = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [preferred, inherited]) {
    if (!value) continue;
    for (const entry of value.split(delimiter)) {
      const directory = entry.trim();
      if (!directory || seen.has(directory)) continue;
      seen.add(directory);
      merged.push(directory);
    }
  }
  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

export type HostPathDeps = {
  platform?: NodeJS.Platform;
  readEnv?: typeof readEnvFromLoginShell;
  readLaunchctl?: typeof readPathFromLaunchctl;
  warn?: (message: string) => void;
};

let hydrated = false;

export function resetHostPathHydration(): void {
  hydrated = false;
}

export function hydrateHostPath(env: NodeJS.ProcessEnv = process.env, deps: HostPathDeps = {}): void {
  if (hydrated) return;
  hydrated = true;

  const platform = deps.platform ?? process.platform;
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`[telar] ${message}\n`));
  if (env.TELAR_NO_SHELL_PATH === "1") return;
  if (platform !== "darwin" && platform !== "linux") return;

  if (!trimmed(env.HOME)) {
    try {
      const home = os.userInfo().homedir;
      if (home) env.HOME = home;
    } catch (error) {
      warn(`could not read this account's home directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const readEnv = deps.readEnv ?? readEnvFromLoginShell;
  let shellPath: string | undefined;
  for (const shell of loginShellCandidates(platform, env.SHELL)) {
    try {
      shellPath = trimmed(readEnv(shell, ["PATH"]).PATH);
    } catch (error) {
      warn(`could not read PATH from the login shell ${shell}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (shellPath) break;
  }

  const readLaunchctl = deps.readLaunchctl ?? readPathFromLaunchctl;
  const fallback = platform === "darwin" && !shellPath ? readLaunchctl() : undefined;
  const merged = mergePathEntries(shellPath ?? fallback, env.PATH, platform);
  if (merged) env.PATH = merged;
}
