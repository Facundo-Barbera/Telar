/**
 * The `sessions` toolkit's WIRING — the two seams between the wall and a real
 * turn, neither of which `sessions-tools.test.ts` can reach.
 *
 *   1. THE DRIVER SEAM. That the seven tools reach a model at all, under the
 *      one `telar` server like every other Telar capability, and that a turn
 *      carrying no capability gets NO sessions tools rather than empty ones —
 *      a model handed a `sessions_list` that answers "nothing is live" for an
 *      engine it cannot see would report that as the truth.
 *   2. THE WORKER SEAM, which is the deployment an actual session runs in. The
 *      worker holds no store handle: it builds the capability out of
 *      `EngineClient` calls, so every rule has to survive a round trip over
 *      loopback rather than being enforced in the same process. The one that
 *      matters most is `origin: "session"` — it is declared by the worker's own
 *      code, and without it the store's budget counts nothing and the cap is a
 *      formality.
 *
 * NOTHING HERE SPENDS ANYTHING. The SDK is a fake with a `tool` factory that
 * remembers names, and the turn driver is a fake that calls the capability it
 * was handed and returns. No provider is loaded, no CLI is resolved.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type Session } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { createClaudeDriver, type SessionsCapability, type TurnDriver } from "../src/driver";
import { EngineWorker } from "../src/worker";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const workers: EngineWorker[] = [];

const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.stop();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * THE EXECUTABLE RESOLVER IS FAKED, exactly as `driver.test.ts` fakes it.
 *
 * The real one probes the machine's own Claude Code and refuses a turn when
 * there is none, which is correct behaviour and the wrong thing to depend on
 * here: left to it, the driver-seam test below would pass on a laptop with
 * Claude Code installed and fail in CI, on an assertion about tool
 * REGISTRATION that has nothing to do with resolution.
 */
const claudeDriver: typeof createClaudeDriver = (loadSdk, options = {}) =>
  createClaudeDriver(loadSdk, { resolveExecutable: () => "/fake/bin/claude", ...options });

/** A throwaway repository with one commit — the house idiom. */
function repo(): string {
  const root = tmp("telar-sessions-wiring-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

// ── 1. the driver seam ──────────────────────────────────────────────────────

test("the sessions toolkit registers under the SAME one server, and only when the turn carries one", async () => {
  // THE SEAM, not the toolkit — `sessions-tools.test.ts` owns what the seven
  // tools do. What this pins is that they reach the model, under `telar`, and
  // that their absence is an absence rather than a stub.
  const seen: { serverKeys?: string[] } = {};
  const names: string[] = [];
  const sdk = async () => ({
    tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<{ content: unknown[] }>) => {
      names.push(name);
      return { name, handler };
    },
    createSdkMcpServer: (input: { tools: { name: string }[] }) => input,
    async *query(input: { options: { mcpServers?: Record<string, { tools: { name: string }[] }> } }) {
      seen.serverKeys = Object.keys(input.options.mcpServers ?? {});
      yield { type: "result", subtype: "success" };
    },
  });

  // A capability that ANSWERS EMPTILY rather than succeeding at everything: the
  // seam under test is registration, and a stub that pretended to create
  // sessions would be asserting something this file does not check.
  const sessions: SessionsCapability = {
    list: async () => ({ sessions: [], projects: [] }),
    create: async () => {
      throw new Error("this test does not create sessions");
    },
    send: async () => {
      throw new Error("this test does not send");
    },
    read: async () => [],
    status: async () => {
      throw new Error("this test does not read status");
    },
    stop: async () => ({ stopped: false }),
    diff: async () => {
      throw new Error("this test does not diff");
    },
  };

  await claudeDriver(sdk).run({
    prompt: "prompt",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
    sessions,
  });
  expect(seen.serverKeys).toEqual(["telar"]);
  expect(names).toEqual([
    "sessions_list",
    "sessions_create",
    "sessions_send",
    "sessions_read",
    "sessions_status",
    "sessions_stop",
    "sessions_diff",
    "warp",
  ]);

  // …and without one the sessions tools are GONE while `warp` stays — it is
  // unconditional by design, which is also what keeps this from passing for the
  // trivial reason that nothing registers at all.
  names.length = 0;
  await claudeDriver(sdk).run({
    prompt: "prompt",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => undefined,
  });
  expect(names).toEqual(["warp"]);
});

// ── 2. the worker seam ──────────────────────────────────────────────────────

/**
 * Run one turn against a driver that does whatever `body` says with the
 * `sessions` capability the worker handed it. The turn is real: a real daemon,
 * a real worker, a real claim, and a capability made of real HTTP calls.
 */
async function turnWith(
  body: (sessions: SessionsCapability) => Promise<void>,
  options: { sessionsBudget?: number } = {},
): Promise<{ client: EngineClient; hostId: string; projectId: string; sawCapability: boolean }> {
  const daemon = await startEngine({
    engineRoot: tmp("telar-sessions-wiring-"),
    workerLeaseMs: 1_000,
    ...(options.sessionsBudget === undefined ? {} : { sessionsBudget: options.sessionsBudget }),
  });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const { project } = await client.registerProject({ name: "aurora", root: repo() });
  const { session } = await client.createSession({ projectId: project.id, title: "the one doing the asking" });

  let sawCapability = false;
  let failed: unknown;
  const driver: TurnDriver = {
    async run({ sessions }) {
      sawCapability = sessions !== undefined;
      if (sessions) {
        try {
          await body(sessions);
        } catch (error) {
          failed = error;
        }
      }
      return { text: "done" };
    },
  };
  const worker = new EngineWorker({ client, workerId: "worker_one", driver, pollMs: 60_000 });
  workers.push(worker);
  await worker.start();
  await client.submitTurn(session.id, { runId: "run_one", input: "go" });
  await worker.tick();
  // `tick` CLAIMS; it does not await the execution — `void this.execute(claim)`
  // is deliberate there, so the turn settling is what this waits on. The house
  // idiom (see `worker.test.ts`).
  for (let attempt = 0; attempt < 200; attempt++) {
    const turn = (await client.session(session.id)).turns[0];
    if (turn && turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running") break;
    await Bun.sleep(5);
  }
  // A throw inside the driver body is this test's failure, not the turn's —
  // surfaced rather than swallowed into a failed turn nobody reads.
  if (failed) throw failed;
  return { client, hostId: session.id, projectId: project.id, sawCapability };
}

test("a running turn is handed the toolkit, and what it creates is stamped as an agent's", async () => {
  let made: Session | undefined;
  let listed: { sessions: Session[]; projects: Array<{ id: string; name: string }> } | undefined;
  const { client, hostId, sawCapability } = await turnWith(async (sessions) => {
    const { projects } = await sessions.list();
    made = await sessions.create({ projectId: projects[0]!.id, title: "made mid-turn", envMode: "worktree" });
    listed = await sessions.list();
  });

  expect(sawCapability).toBe(true);
  expect(made).toBeDefined();
  // THE STAMP, over a real round trip. Declared by the WORKER's own code — no
  // tool shape carries it — and it is what the store's budget counts.
  expect(made!.origin).toBe("session");
  expect(made!.envMode).toBe("worktree");
  expect(fs.existsSync(path.join(made!.workspace.path, "README.md"))).toBe(true);

  // The engine agrees, read back through the ordinary API.
  const { session } = await client.session(made!.id);
  expect(session.origin).toBe("session");
  // The list the turn saw held both, as peers — the session doing the asking is
  // on it exactly as the one it made is, with nothing linking them.
  expect(listed!.sessions.map((each) => each.id).sort()).toEqual([hostId, made!.id].sort());
  expect(JSON.stringify(session)).not.toContain(hostId);
});

test("the budget refuses the worker's own path, over HTTP, in the store's sentence", async () => {
  // The mirror of the in-process assertion: the guard is the STORE's, so it
  // cannot be walked past by reaching it through the client instead.
  let refusal = "";
  await turnWith(
    async (sessions) => {
      const { projects } = await sessions.list();
      await sessions.create({ projectId: projects[0]!.id, envMode: "local" });
      try {
        await sessions.create({ projectId: projects[0]!.id, envMode: "local" });
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    },
    { sessionsBudget: 1 },
  );
  expect(refusal).toContain("1 of a maximum 1");
  expect(refusal).toContain("Archive or delete one");
});

test("the worker cannot archive, delete or accept anything — the client it holds has no such reach", async () => {
  // The Pick in `WorkerClient` is the structural half of "this wall lands
  // nothing": a handler that tried would not compile. Asserted at runtime too,
  // because a Pick widened by accident is exactly the change nobody notices.
  const { sawCapability } = await turnWith(async (sessions) => {
    const surface = Object.keys(sessions).sort();
    expect(surface).toEqual(["create", "diff", "list", "read", "send", "status", "stop"]);
    for (const forbidden of ["archive", "delete", "accept", "merge", "commit"]) {
      expect(surface).not.toContain(forbidden);
    }
  });
  expect(sawCapability).toBe(true);
});
