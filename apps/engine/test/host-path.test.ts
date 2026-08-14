/**
 * REPAIRING THE PATH A PACKAGED APP WAS HANDED.
 *
 * This is the piece that lets `cli-resolution.ts` trust PATH instead of
 * enumerating install directories, so its failure mode is the whole class of
 * bug that design is meant to remove: a version-managed CLI that the user's
 * terminal finds and Telar does not.
 */
import { afterEach, expect, test } from "bun:test";
import { hydrateHostPath, loginShellCandidates, mergePathEntries, resetHostPathHydration, valueBetweenMarkers } from "../src/host-path";

afterEach(() => resetHostPathHydration());

test("the login shell is tried before the account's, and the platform default last", () => {
  expect(loginShellCandidates("darwin", "/opt/homebrew/bin/fish", "/bin/zsh")).toEqual(["/opt/homebrew/bin/fish", "/bin/zsh"]);
  // A Finder launch often has no $SHELL at all, which is exactly when this runs.
  expect(loginShellCandidates("darwin", undefined, "/bin/bash")).toEqual(["/bin/bash", "/bin/zsh"]);
  // `""` rather than `undefined`, which would fall through to this machine's
  // own account shell — the parameter's default, and what production wants.
  expect(loginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash"]);
  // Duplicates collapse rather than costing a second interactive shell.
  expect(loginShellCandidates("darwin", "/bin/zsh", "/bin/zsh")).toEqual(["/bin/zsh"]);
});

test("the value is read from between the markers, not from the noise around it", () => {
  /**
   * THE REASON THE MARKERS EXIST. A login shell prints whatever its rc files
   * print — a version-manager banner, a direnv notice, somebody's fortune — and
   * `apps/desktop/main.js` parses `env` line by line, so any of that containing
   * an `=` becomes a variable. Bracketing the one value being read is what makes
   * the answer trustworthy.
   */
  const noisy = ["Now using node v22.11.0", "__TELAR_ENV_PATH_START__", "/opt/homebrew/bin:/usr/bin", "__TELAR_ENV_PATH_END__", "direnv: export +FOO"].join(
    "\n",
  );
  expect(valueBetweenMarkers(noisy, "PATH")).toBe("/opt/homebrew/bin:/usr/bin");
  // An unset variable prints nothing between its markers, which is not a value.
  expect(valueBetweenMarkers("__TELAR_ENV_PATH_START__\n\n__TELAR_ENV_PATH_END__", "PATH")).toBeUndefined();
  // A shell that died before printing anything is silence, not a wrong answer.
  expect(valueBetweenMarkers("command not found", "PATH")).toBeUndefined();
  expect(valueBetweenMarkers("__TELAR_ENV_PATH_START__\n/usr/bin", "PATH")).toBeUndefined();
});

test("the login shell wins the order, and every directory appears once", () => {
  // In a packaged app the inherited PATH is the four-entry stub, so putting it
  // first would leave /usr/bin shadowing the user's real toolchain.
  expect(mergePathEntries("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", "darwin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  expect(mergePathEntries(undefined, "/usr/bin:/bin", "darwin")).toBe("/usr/bin:/bin");
  expect(mergePathEntries("/usr/bin", undefined, "darwin")).toBe("/usr/bin");
  expect(mergePathEntries(undefined, undefined, "darwin")).toBeUndefined();
  // Blank segments — a trailing colon is extremely common — are not directories.
  expect(mergePathEntries("/a: :/b:", "/a:/c", "darwin")).toBe("/a:/b:/c");
});

test("a Finder-shaped environment ends up with the user's real toolchain on it", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/somebody" };
  hydrateHostPath(env, {
    platform: "darwin",
    readEnv: () => ({ PATH: "/Users/somebody/.bun/bin:/Users/somebody/.local/bin:/opt/homebrew/bin:/usr/bin" }),
  });
  expect(env.PATH).toBe("/Users/somebody/.bun/bin:/Users/somebody/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});

test("launchctl answers when no login shell will", () => {
  // A shell whose rc exits non-zero, or an account whose login shell is not
  // really a shell. macOS still knows the user PATH.
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  hydrateHostPath(env, {
    platform: "darwin",
    readEnv: () => {
      throw new Error("profile exited 1");
    },
    readLaunchctl: () => "/opt/homebrew/bin:/usr/bin",
    warn: () => {},
  });
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
});

test("a machine where nothing answers is left exactly as it was", () => {
  /**
   * NEVER THROWS, AND NEVER EMPTIES. This runs on someone else's machine at
   * boot; a broken shell profile is a reason to fall back, not a reason the
   * engine does not start — and an inherited PATH replaced with nothing would
   * be strictly worse than the PATH it was handed.
   */
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  const warnings: string[] = [];
  hydrateHostPath(env, {
    platform: "darwin",
    readEnv: () => {
      throw new Error("boom");
    },
    readLaunchctl: () => undefined,
    warn: (message) => warnings.push(message),
  });
  expect(env.PATH).toBe("/usr/bin:/bin");
  // And it says so, once, rather than failing silently.
  expect(warnings.some((line) => line.includes("boom"))).toBe(true);
});

test("TELAR_NO_SHELL_PATH leaves the environment alone", () => {
  // Spawning an interactive shell at boot is the one thing here that can hang
  // for its whole timeout, and a machine where that happens needs a way out
  // that is not "downgrade Telar".
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", TELAR_NO_SHELL_PATH: "1" };
  let asked = false;
  hydrateHostPath(env, {
    platform: "darwin",
    readEnv: () => {
      asked = true;
      return { PATH: "/opt/homebrew/bin" };
    },
  });
  expect(asked).toBe(false);
  expect(env.PATH).toBe("/usr/bin");
});

test("it runs once per process, however many entry points call it", () => {
  // The daemon and the worker both call this; the second must not pay for
  // another interactive shell.
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  let calls = 0;
  const deps = {
    platform: "darwin" as const,
    readEnv: () => {
      calls += 1;
      return { PATH: "/opt/homebrew/bin" };
    },
  };
  hydrateHostPath(env, deps);
  hydrateHostPath(env, deps);
  expect(calls).toBe(1);
});

test("a missing HOME is filled in, because everything downstream derives from it", () => {
  // A Finder-launched app can arrive without one, and then every `~` expansion,
  // config directory and credential location is wrong.
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  hydrateHostPath(env, { platform: "darwin", readEnv: () => ({}), readLaunchctl: () => undefined });
  expect(env.HOME).toBeTruthy();
});
