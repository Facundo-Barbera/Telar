import { afterEach, expect, test } from "bun:test";
import { hydrateHostPath, loginShellCandidates, mergePathEntries, resetHostPathHydration, valueBetweenMarkers } from "./host-path";

afterEach(() => resetHostPathHydration());

test("the login shell is tried before the account's, and the platform default last", () => {
  expect(loginShellCandidates("darwin", "/opt/homebrew/bin/fish", "/bin/zsh")).toEqual(["/opt/homebrew/bin/fish", "/bin/zsh"]);
  expect(loginShellCandidates("darwin", undefined, "/bin/bash")).toEqual(["/bin/bash", "/bin/zsh"]);
  expect(loginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash"]);
  expect(loginShellCandidates("darwin", "/bin/zsh", "/bin/zsh")).toEqual(["/bin/zsh"]);
});

test("the value is read from between the markers, not from the noise around it", () => {
  const noisy = ["Now using node v22.11.0", "__TELAR_ENV_PATH_START__", "/opt/homebrew/bin:/usr/bin", "__TELAR_ENV_PATH_END__", "direnv: export +FOO"].join(
    "\n",
  );
  expect(valueBetweenMarkers(noisy, "PATH")).toBe("/opt/homebrew/bin:/usr/bin");
  expect(valueBetweenMarkers("__TELAR_ENV_PATH_START__\n\n__TELAR_ENV_PATH_END__", "PATH")).toBeUndefined();
  expect(valueBetweenMarkers("command not found", "PATH")).toBeUndefined();
  expect(valueBetweenMarkers("__TELAR_ENV_PATH_START__\n/usr/bin", "PATH")).toBeUndefined();
});

test("the login shell wins the order, and every directory appears once", () => {
  expect(mergePathEntries("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", "darwin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  expect(mergePathEntries(undefined, "/usr/bin:/bin", "darwin")).toBe("/usr/bin:/bin");
  expect(mergePathEntries("/usr/bin", undefined, "darwin")).toBe("/usr/bin");
  expect(mergePathEntries(undefined, undefined, "darwin")).toBeUndefined();
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
  expect(warnings.some((line) => line.includes("boom"))).toBe(true);
});

test("TELAR_NO_SHELL_PATH leaves the environment alone", () => {
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
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  hydrateHostPath(env, { platform: "darwin", readEnv: () => ({}), readLaunchctl: () => undefined });
  expect(env.HOME).toBeTruthy();
});
