import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmp, removeTmp } from "../../../test/worktree-fixtures";
import { agentEnv } from "../process/agent-env";
import { engineGitEnv, withoutFsmonitor } from "./env";

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", ...(env ? { env } : {}) });
const watched: string[] = [];

afterEach(() => {
  for (const checkout of watched.splice(0)) git(checkout, ["fsmonitor--daemon", "stop"]);
  removeTmp();
});

test("appends to config the caller already passes rather than replacing it", () => {
  expect(withoutFsmonitor({ PATH: "/bin" })).toEqual({ PATH: "/bin", GIT_CONFIG_PARAMETERS: "'core.fsmonitor=false' 'core.untrackedCache=false'" });
  expect(withoutFsmonitor({ GIT_CONFIG_PARAMETERS: "'user.name=Me'" }).GIT_CONFIG_PARAMETERS).toBe(
    "'user.name=Me' 'core.fsmonitor=false' 'core.untrackedCache=false'",
  );
});

test("git reads fsmonitor as off while config from the caller's env still applies", () => {
  const repo = tmp("telar-git-env-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "core.fsmonitor", "true"]);
  const env = withoutFsmonitor({ ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Kept", GIT_CONFIG_PARAMETERS: "'user.email=kept@example.com'" });
  expect(git(repo, ["config", "core.fsmonitor"], env).stdout.trim()).toBe("false");
  expect(git(repo, ["config", "user.name"], env).stdout.trim()).toBe("Kept");
  expect(git(repo, ["config", "user.email"], env).stdout.trim()).toBe("kept@example.com");
  expect(git(repo, ["config", "--local", "core.fsmonitor"]).stdout.trim()).toBe("true");
});

const daemonSupported = process.platform === "darwin" && git(".", ["version", "--build-options"]).stdout.includes("feature: fsmonitor--daemon");
const running = (repo: string) => git(repo, ["fsmonitor--daemon", "status"]).status === 0;

test.skipIf(!daemonSupported)("a status in a repo with fsmonitor on starts a daemon, but not through the engine's or an agent's env", () => {
  const repo = tmp("telar-git-env-daemon-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "core.fsmonitor", "true"]);
  watched.push(repo);

  git(repo, ["status", "--porcelain"], engineGitEnv());
  git(repo, ["status", "--porcelain"], agentEnv());
  expect(running(repo)).toBeFalse();

  git(repo, ["status", "--porcelain"]);
  expect(running(repo)).toBeTrue();
});
