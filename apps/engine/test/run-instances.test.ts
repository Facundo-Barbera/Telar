/**
 * "RUN = A NEW TERMINAL": what replaced the one-deployment-per-project slot.
 *
 * Every start opens a new terminal owned by the session that asked; none of
 * them blocks another; a busy port warns and never refuses; and a readiness
 * claim is still only ever about our own process.
 *
 * MOST OF THIS RUNS ON A LAUNCHER THAT STARTS NOTHING. The rules under test
 * are the manager's — numbering, ownership, warnings — and a fake host that
 * records what it was asked to open is a sharper witness to them than a real
 * process. The one test that needs real output uses the pipe fallback, and
 * stops what it started.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunHandle, RunLaunchEvents, RunLaunchRequest, RunLauncher } from "../src/run/launcher";
import { RunManager, type StartRunInput } from "../src/run/manager";
import type { RunConfiguration } from "../src/run/types";

const worktree = () => track(fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-tree-")));

const track = (dir: string): string => (tempDirs.push(dir), dir);
/**
 * NOTHING THIS FILE STARTS OUTLIVES IT, and nothing it writes stays on disk.
 * Managers are shut down after each test and the directories go at the end.
 */
const managers: RunManager[] = [];
const tempDirs: string[] = [];

function runManager(...args: ConstructorParameters<typeof RunManager>): RunManager {
  const manager = new RunManager(...args);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  while (managers.length) {
    try {
      await managers.pop()!.shutdown();
    } catch {
      /* a manager that already failed is not a second failure */
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const config = (command: string, extra: Partial<RunConfiguration> = {}): RunConfiguration => ({
  id: "runcfg_test",
  projectId: "proj_1",
  name: "web dev",
  command,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const input = (tree: string, cfg: RunConfiguration, extra: Partial<StartRunInput> = {}): StartRunInput => ({
  projectId: "proj_1",
  sessionId: "sess_a",
  config: cfg,
  worktreePath: tree,
  ...extra,
});

async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/**
 * A terminal host that opens nothing: it names each terminal, remembers what
 * it was asked for, and ends one when the test says so. Closing one reports
 * the exit the real host would — a hangup, and why it was closing.
 */
function fakeHost() {
  const opened: Array<{ id: string; request: RunLaunchRequest; events: RunLaunchEvents }> = [];
  const closed: string[] = [];
  let sequence = 0;
  const launcher: RunLauncher = {
    kind: "pty",
    async launch(request, events) {
      const id = `term_${(sequence += 1)}`;
      opened.push({ id, request, events });
      const handle: RunHandle = {
        pid: 50_000 + sequence,
        terminalId: id,
        async close() {
          closed.push(id);
          events.exited({ exitCode: 0, signal: "1", closed: "close" });
        },
        async signal() {},
        write: async () => true,
        resize: async () => true,
      };
      return handle;
    },
  };
  return { launcher, opened, closed };
}

// ── two presses, two terminals ───────────────────────────────────────────────

test("two starts of one configuration give two terminals, and neither blocks the other", async () => {
  const host = fakeHost();
  const manager = runManager({ launcher: host.launcher });
  const tree = worktree();

  const first = await manager.start(input(tree, config("bun run dev")));
  const second = await manager.start(input(tree, config("bun run dev")));

  expect(first.terminalId).not.toBe(second.terminalId);
  expect(first.status).toBe("running");
  expect(second.status).toBe("running");
  expect(first.title).toBe("web dev");
  expect(second.title).toBe("web dev #2");
  // THE HOST WAS TOLD — the session that owns each terminal, that it came from
  // a configuration, and what its tab says.
  expect(host.opened.map((entry) => [entry.request.sessionId, entry.request.origin, entry.request.title])).toEqual([
    ["sess_a", "run", "web dev"],
    ["sess_a", "run", "web dev #2"],
  ]);
  expect(manager.terminals("sess_a").map((run) => run.title).sort()).toEqual(["web dev", "web dev #2"]);
});

test("two presses in the same tick still get two different numbers", async () => {
  /**
   * THE TITLE IS TAKEN BEFORE THE FIRST AWAIT. Two starts racing through the
   * readiness baseline must not both come out "web dev".
   */
  const host = fakeHost();
  const manager = runManager({ launcher: host.launcher, probe: async () => ({ answered: false, serving: false }) });
  const tree = worktree();
  const cfg = config("bun run dev", { readinessUrl: "http://localhost:65010" });
  const both = await Promise.all([manager.start(input(tree, cfg)), manager.start(input(tree, cfg))]);
  expect(both.map((run) => run.title).sort()).toEqual(["web dev", "web dev #2"]);
});

test("a closed instance frees its number, and ended ones keep their record", async () => {
  const host = fakeHost();
  const manager = runManager({ launcher: host.launcher });
  const tree = worktree();
  const first = await manager.start(input(tree, config("bun run dev")));
  await manager.start(input(tree, config("bun run dev")));

  await manager.close(first.terminalId, "person");
  const third = await manager.start(input(tree, config("bun run dev")));
  expect(third.title).toBe("web dev");
  // The closed one is still listed, for its output, with who closed it.
  const closed = manager.run(first.terminalId);
  expect(closed.status).toBe("closed");
  expect(closed.closedBy).toBe("person");
  expect(manager.terminals("sess_a")).toHaveLength(3);
});

test("a terminal belongs to the session that opened it, and each session numbers its own", async () => {
  const host = fakeHost();
  const manager = runManager({ launcher: host.launcher });
  const tree = worktree();
  const mine = await manager.start(input(tree, config("bun run dev"), { sessionId: "sess_a" }));
  const theirs = await manager.start(input(tree, config("bun run dev"), { sessionId: "sess_b" }));

  expect(mine.title).toBe("web dev");
  expect(theirs.title).toBe("web dev");
  expect(manager.terminals("sess_a").map((run) => run.terminalId)).toEqual([mine.terminalId]);
  expect(manager.terminals("sess_b").map((run) => run.terminalId)).toEqual([theirs.terminalId]);
});

// ── a busy port warns ────────────────────────────────────────────────────────

test("a port that already answers warns on the terminal, and the terminal still opens", async () => {
  /**
   * THE OLD RULE BLOCKED; THIS ONE ONLY SAYS SO. Something already answering
   * the readiness URL is recorded as a warning a person can read, the launch
   * goes ahead, and — because a 200 afterwards would be about the stranger —
   * the terminal can never claim `ready`.
   */
  const host = fakeHost();
  const manager = runManager({ launcher: host.launcher, probe: async () => ({ answered: true, serving: true }), readyPollMs: 20 });
  const run = await manager.start(input(worktree(), config("bun run dev", { readinessUrl: "http://localhost:3000" })));

  expect(host.opened).toHaveLength(1);
  expect(run.status).toBe("running");
  expect(run.warning).toContain("port 3000 already answers");
  expect(run.readiness.kind).toBe("unattributable");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(manager.run(run.terminalId).status).toBe("running");
});

test("a silent port warns about nothing", async () => {
  const host = fakeHost();
  const manager = runManager({ launcher: host.launcher, probe: async () => ({ answered: false, serving: false }) });
  const run = await manager.start(input(worktree(), config("bun run dev", { readinessUrl: "https://localhost/app" })));
  expect(run.warning).toBeUndefined();
  expect(run.readiness.kind).toBe("pending");
});

// ── readiness is still about our own process ─────────────────────────────────

test("readiness is only claimed when the URL was silent before this terminal opened", async () => {
  let answers = false;
  const host = fakeHost();
  const manager = runManager({ launcher: host.launcher, probe: async () => ({ answered: answers, serving: answers }), readyPollMs: 20 });
  const run = await manager.start(input(worktree(), config("bun run dev", { readinessUrl: "http://localhost:65001" })));

  expect(manager.run(run.terminalId).readiness.kind).toBe("pending");
  expect(manager.run(run.terminalId).status).toBe("running");

  answers = true;
  expect(await until(() => manager.run(run.terminalId).status === "ready")).toBe(true);
  expect(manager.run(run.terminalId).readiness.kind).toBe("ready");
});

test("a terminal without a readiness check never claims ready, however long it lives", async () => {
  const host = fakeHost();
  const manager = runManager({ launcher: host.launcher, probe: async () => ({ answered: true, serving: true }), readyPollMs: 20 });
  const run = await manager.start(input(worktree(), config("bun run dev")));
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(manager.run(run.terminalId).status).toBe("running");
  expect(manager.run(run.terminalId).readiness).toEqual({ kind: "none" });
});

// ── output ───────────────────────────────────────────────────────────────────

test("output is a bounded window, and what it dropped is reported rather than hidden", async () => {
  const manager = runManager();
  const run = await manager.start(input(worktree(), config("i=0; while [ $i -lt 2500 ]; do echo line-$i; i=$((i+1)); done")));

  expect(await until(() => manager.run(run.terminalId).status === "exited", 20_000)).toBe(true);
  const output = manager.output(run.terminalId);
  expect(output.lines.length).toBeLessThanOrEqual(2000);
  expect(output.dropped).toBeGreaterThan(0);
  expect(output.lines.at(-1)?.text).toBe("line-2499");
  expect(output.cursor).toBe(output.dropped + output.lines.length);

  // A cursor from a previous read returns only what is newer.
  expect(manager.output(run.terminalId, output.cursor).lines).toHaveLength(0);
}, 30_000);
