/**
 * THE PATH THIS MACHINE ACTUALLY HAS, not the one this process was handed.
 *
 * A Finder-launched app inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
 * else. Every version manager anyone uses — nvm, fnm, mise, asdf, volta, bun,
 * pnpm — puts its shims somewhere that only exists in an interactive login
 * shell's environment, so from inside a packaged app those installs are simply
 * invisible. So the shell is asked once, at boot, and `process.env.PATH` is
 * repaired before anything tries to resolve a binary.
 *
 * PORTED FROM T3 Code's `src/os-jank.ts` and the capture half of
 * `packages/shared/src/shell.ts`. This is the piece that lets the donor resolve
 * every CLI by bare name against PATH and never enumerate an install directory
 * anywhere — which is the design `cli-resolution.ts` now follows too.
 *
 * WHY IT LIVES IN THE ENGINE AND NOT THE SHELL. `apps/desktop/main.js` has done
 * a version of this for a while, which is why the packaged app worked at all.
 * But that only helps a launch that goes through Electron: an engine started by
 * launchd, by a service manager, or by anything else got nothing. Repairing it
 * where the resolving happens makes it true however the process was started.
 *
 * THE SENTINELS ARE NOT DECORATION. A login shell prints whatever its rc files
 * print — version-manager banners, direnv notices, a fortune. Parsing `env`
 * output line-by-line (which the desktop shell does) picks up any of it that
 * happens to contain an `=`. Bracketing the one value being read is what makes
 * the answer trustworthy.
 */

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** Only ever asked for names this module controls, but validated anyway — the
 *  name is interpolated into a shell command. */
const ENV_NAME = /^[A-Z0-9_]+$/;

/** The rc files of a real developer's shell can be slow (nvm and conda are the
 *  usual suspects). Long enough for a heavy profile, short enough that a shell
 *  waiting on input cannot hold the engine's boot for ever. */
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

/**
 * Which shells to try, in order, dropping duplicates.
 *
 * `$SHELL` first because it is what the user last chose, then the account's
 * registered shell, then the platform default — a Finder launch often has no
 * `$SHELL` at all, which is exactly when this matters most.
 */
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
      // `|| true` so an unset variable does not fail the whole command and cost
      // us the other names in the same capture.
      return [`printf '%s\\n' '${startMarker(name)}'`, `printenv ${name} || true`, `printf '%s\\n' '${endMarker(name)}'`].join("; ");
    })
    .join("; ");
}

/** The value between this name's markers, or nothing. One leading and one
 *  trailing newline are the `printf`s' own and are removed; anything else
 *  inside the brackets is the value. */
export function valueBetweenMarkers(output: string, name: string): string | undefined {
  const start = output.indexOf(startMarker(name));
  if (start === -1) return undefined;
  const from = start + startMarker(name).length;
  const end = output.indexOf(endMarker(name), from);
  if (end === -1) return undefined;
  const value = output.slice(from, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return value.length > 0 ? value : undefined;
}

/** `-ilc`: interactive AND login, because the two source different files and
 *  the version managers are split across both. */
export function readEnvFromLoginShell(
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

/** macOS's own idea of the user PATH, for when no login shell would answer —
 *  a shell whose rc exits non-zero, or an account with a login shell that is
 *  not really a shell. */
export function readPathFromLaunchctl(execFile: ExecFileLike = execFileSync as unknown as ExecFileLike): string | undefined {
  try {
    return trimmed(execFile("/bin/launchctl", ["getenv", "PATH"], { encoding: "utf8", timeout: LAUNCHCTL_TIMEOUT_MS }));
  } catch {
    return undefined;
  }
}

/**
 * Both PATHs, preferred entries first, each directory once.
 *
 * THE LOGIN SHELL WINS THE ORDER, which is the whole point: in a packaged app
 * the inherited PATH is the four-entry stub, and putting it first would leave
 * `/usr/bin/…` shadowing the user's real toolchain. It does mean a PATH
 * deliberately prepended for one launch is demoted below the login shell's own
 * entries — use `CLAUDE_CODE_EXECUTABLE`, `CODEX_BIN` or a login's binary path
 * to pin a specific binary, which are the supported ways to say that.
 */
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

/** Repaired once per process. Both worker deployments and the daemon call this,
 *  and the second caller must not pay for another interactive shell. */
let hydrated = false;

/** For tests, which need to hydrate more than one fake environment. */
export function resetHostPathHydration(): void {
  hydrated = false;
}

/**
 * Repair `env.PATH` (and `HOME`, if this process has none) in place.
 *
 * NEVER THROWS. Every failure here is one this app must survive: the whole
 * point is to run on someone else's machine, and a shell profile that errors is
 * a reason to fall back, not a reason the engine does not start. The inherited
 * PATH is left exactly as it was in that case, and `cli-resolution.ts` still
 * has its last-resort directories.
 *
 * `TELAR_NO_SHELL_PATH=1` skips it entirely — a deviation from the donor, which
 * has no such switch. Spawning an interactive shell at boot is the one thing
 * here that can hang for its whole timeout, and a machine where that happens
 * needs a way out that is not "downgrade Telar".
 */
export function hydrateHostPath(env: NodeJS.ProcessEnv = process.env, deps: HostPathDeps = {}): void {
  if (hydrated) return;
  hydrated = true;

  const platform = deps.platform ?? process.platform;
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`[telar] ${message}\n`));
  if (env.TELAR_NO_SHELL_PATH === "1") return;
  if (platform !== "darwin" && platform !== "linux") return;

  // A Finder-launched app can arrive without HOME, and everything downstream —
  // the config directories, `~` expansion, the CLIs' own state — is derived
  // from it.
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
