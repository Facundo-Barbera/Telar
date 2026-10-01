import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { RunLauncher } from "../terminal";
import { tmp, removeTmp } from "../../../test/worktree-fixtures";
import { WorktreeSetups } from "./setup";

afterEach(removeTmp);

function heldLauncher() {
  const running = new Map<string, Parameters<RunLauncher["launch"]>[1]>();
  let launched: () => void = () => undefined;
  const launcher: RunLauncher = {
    kind: "pipes",
    launch: async (request, events) => {
      running.set(request.cwd ?? "", events);
      launched();
      return {
        pid: undefined,
        terminalId: request.cwd ?? "",
        close: async () => events.exited({ signal: "SIGTERM" }),
        signal: async () => undefined,
      };
    },
  };
  const nextLaunch = () => new Promise<void>((resolve) => (launched = resolve));
  return { launcher, running, nextLaunch };
}

function setups(launcher: RunLauncher) {
  const home = tmp("telar-setup-");
  const worktree = (name: string) => {
    const directory = path.join(home, "worktrees", name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  };
  const config = { setup: { command: "bun install" } };
  const runs = new WorktreeSetups({ directoryOf: (id) => path.join(home, "sessions", id), launcher });
  const start = (id: string) => runs.start(id, { checkout: home, worktree: worktree(id), config });
  return { home, runs, start };
}

test("a third setup waits until one of the first two finishes", async () => {
  const { launcher, running, nextLaunch } = heldLauncher();
  const { home, runs, start } = setups(launcher);

  await start("a");
  await start("b");
  const third = start("c");
  expect(running.size).toBe(2);
  expect(runs.isRunning("c")).toBe(true);

  const launchedThird = nextLaunch();
  running.get(path.join(home, "worktrees", "a"))!.exited({ exitCode: 0 });
  await launchedThird;
  await third;
  expect(running.has(path.join(home, "worktrees", "c"))).toBe(true);
  expect((await runs.wait("a"))?.state).toBe("succeeded");
});

test("stopping a waiting setup ends it without launching it", async () => {
  const { launcher, running } = heldLauncher();
  const { runs, start } = setups(launcher);

  await start("a");
  await start("b");
  const third = start("c");
  expect(runs.stop("c")).toBe(true);

  expect((await third)?.state).toBe("stopped");
  expect(running.size).toBe(2);
  expect(runs.output("c").lines.map((line) => line.text)).toContain("[telar] waiting for another setup to finish");
});

test("a finished setup's output is on disk once it is waited for", async () => {
  const { launcher, running } = heldLauncher();
  const { home, runs, start } = setups(launcher);

  await start("a");
  const events = running.get(path.join(home, "worktrees", "a"))!;
  events.output("stdout", "resolved 3 packages\n");
  events.exited({ exitCode: 0 });

  expect((await runs.wait("a"))?.state).toBe("succeeded");
  expect(fs.readFileSync(path.join(home, "sessions", "a", "setup.log"), "utf8")).toBe("$ bun install\nresolved 3 packages\n");
  expect(runs.output("a").lines.map((line) => line.text)).toEqual(["$ bun install", "resolved 3 packages"]);
});
