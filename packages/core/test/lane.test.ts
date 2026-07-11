// Unit 2 — startLane (§4–§6): hermetic tests. Same seam discipline as
// run-server.test.ts: every test injects a fake spawnFn (a FakeChild
// EventEmitter), a scripted fetchImpl, a scripted runCommand, and a
// deterministic findPort — nothing here spawns a real process or hits the
// network.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { startLane, type CommandResult, type RunCommand } from "../src/run-server";
import { ServersConfig } from "../src/schemas";

// --- fakes ------------------------------------------------------------------

class FakeChild extends EventEmitter {
  pid = 100_000 + Math.floor(Math.random() * 50_000); // never a real group
  exitCode: number | null = null;
  killed = false;
  constructor(
    public label: string,
    private killLog?: string[],
  ) {
    super();
  }
  kill(_signal?: string): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.killLog?.push(this.label);
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

type SpawnCall = { command: string; cwd: string; env: NodeJS.ProcessEnv; child: FakeChild };

function recordingSpawn(killLog?: string[]) {
  const calls: SpawnCall[] = [];
  const spawnFn = (command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess => {
    const child = new FakeChild(command, killLog);
    calls.push({ command, cwd, env, child });
    return child as unknown as ChildProcess;
  };
  return { spawnFn, calls };
}

// A fetch that returns each status in turn, repeating the last one.
function scriptedFetch(statuses: number[]) {
  const urls: string[] = [];
  let i = 0;
  const impl = (async (url: string | URL) => {
    urls.push(String(url));
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return { status } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls, count: () => i };
}

// A runCommand that returns each exit code in turn, repeating the last one.
function scriptedRun(exitCodes: number[]) {
  const calls: Array<{ cmd: string; cwd: string; env: NodeJS.ProcessEnv }> = [];
  let i = 0;
  const impl: RunCommand = async (cmd, cwd, env): Promise<CommandResult> => {
    calls.push({ cmd, cwd, env });
    const exitCode = exitCodes[Math.min(i, exitCodes.length - 1)];
    i++;
    return { exitCode };
  };
  return { impl, calls, count: () => i };
}

function counterPort(start = 5000) {
  let n = start;
  return async () => n++;
}

function cfg(services: Record<string, unknown>): ServersConfig {
  return ServersConfig.parse({ driver: "host-process", services });
}

const okCommandCheck = { kind: "command", run: "check" };

// --- tests ------------------------------------------------------------------

describe("startLane — no-op back-compat", () => {
  test("driver:none → empty no-op lane", async () => {
    const lane = await startLane(ServersConfig.parse({}), "/tmp/x");
    expect(lane.services).toEqual({});
    await lane.stopAll(); // must not throw
  });

  test("empty services → empty no-op lane (no spawn)", async () => {
    const { spawnFn, calls } = recordingSpawn();
    const lane = await startLane(cfg({}), "/tmp/x", { spawnFn });
    expect(lane.services).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("startLane — dynamic port injection", () => {
  test("env: sets the injected env var to the chosen port", async () => {
    const { spawnFn, calls } = recordingSpawn();
    const run = scriptedRun([0]);
    const lane = await startLane(
      cfg({ api: { command: "run api", portStrategy: "dynamic", portInject: { env: "PORT" }, readyCheck: okCommandCheck } }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, findPort: counterPort(5000), env: {} },
    );
    expect(lane.services.api.port).toBe(5000);
    expect(lane.services.api.url).toBe("http://localhost:5000");
    expect(calls[0].env.PORT).toBe("5000");
    await lane.stopAll();
  });

  test("arg: appends the templated arg to the command", async () => {
    const { spawnFn, calls } = recordingSpawn();
    const run = scriptedRun([0]);
    await startLane(
      cfg({ api: { command: "run api", portStrategy: "dynamic", portInject: { arg: "--port {port}" }, readyCheck: okCommandCheck } }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, findPort: counterPort(6100), env: {} },
    );
    expect(calls[0].command).toBe("run api --port 6100");
  });

  test("file: writes the resolved template to a file before spawn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-lane-"));
    const { spawnFn } = recordingSpawn();
    const run = scriptedRun([0]);
    await startLane(
      cfg({
        api: {
          command: "run api",
          portStrategy: "dynamic",
          portInject: { file: ".env.port", template: "PORT={port}" },
          readyCheck: okCommandCheck,
        },
      }),
      root,
      { spawnFn, runCommand: run.impl, findPort: counterPort(7200), env: {} },
    );
    expect(fs.readFileSync(path.join(root, ".env.port"), "utf8")).toBe("PORT=7200");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("no implicit PORT — env is only injected when portInject.env says so", async () => {
    const { spawnFn, calls } = recordingSpawn();
    const run = scriptedRun([0]);
    await startLane(
      cfg({ api: { command: "run api", portStrategy: "dynamic", portInject: { arg: "--port {port}" }, readyCheck: okCommandCheck } }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, findPort: counterPort(8000), env: {} },
    );
    expect(calls[0].env.PORT).toBeUndefined();
  });
});

describe("startLane — fixed ports", () => {
  test("keeps the declared fixed port (never reassigns)", async () => {
    const { spawnFn } = recordingSpawn();
    const run = scriptedRun([0]);
    const findPort = () => {
      throw new Error("findPort must not be called for a fixed service");
    };
    const lane = await startLane(
      cfg({ db: { command: "run db", portStrategy: "fixed", port: 54321, readyCheck: okCommandCheck } }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, findPort, env: {} },
    );
    expect(lane.services.db.port).toBe(54321);
    expect(lane.services.db.url).toBe("http://localhost:54321");
  });

  test("fixed with no declared port exposes port:null/url:null", async () => {
    const { spawnFn } = recordingSpawn();
    const run = scriptedRun([0]);
    const lane = await startLane(
      cfg({ worker: { command: "run worker", portStrategy: "fixed", readyCheck: okCommandCheck } }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, env: {} },
    );
    expect(lane.services.worker.port).toBeNull();
    expect(lane.services.worker.url).toBeNull();
  });
});

describe("startLane — readyCheck runner", () => {
  test("http: polls until the declared status (503 → 200)", async () => {
    const { spawnFn } = recordingSpawn();
    const f = scriptedFetch([503, 200]);
    const lane = await startLane(
      cfg({ web: { command: "run web", portStrategy: "dynamic", portInject: { env: "PORT" }, readyCheck: { kind: "http", path: "/healthz" } } }),
      "/tmp/proj",
      { spawnFn, fetchImpl: f.impl, findPort: counterPort(4000), env: {}, timeoutMs: 5000 },
    );
    expect(lane.services.web.port).toBe(4000);
    expect(f.urls[0]).toBe("http://localhost:4000/healthz");
    expect(f.count()).toBe(2); // 503 rejected, 200 accepted
    await lane.stopAll();
  });

  test("http: a non-200 declared status is honored", async () => {
    const { spawnFn } = recordingSpawn();
    const f = scriptedFetch([200, 204]);
    await startLane(
      cfg({ web: { command: "run web", portStrategy: "dynamic", portInject: { env: "PORT" }, readyCheck: { kind: "http", path: "/", status: 204 } } }),
      "/tmp/proj",
      { spawnFn, fetchImpl: f.impl, findPort: counterPort(4200), env: {}, timeoutMs: 5000 },
    );
    expect(f.count()).toBe(2); // 200 rejected (wanted 204), 204 accepted
  });

  test("command: waits for exit 0", async () => {
    const { spawnFn } = recordingSpawn();
    const run = scriptedRun([1, 0]);
    await startLane(
      cfg({ db: { command: "run db", portStrategy: "fixed", port: 54322, readyCheck: { kind: "command", run: "status" } } }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, env: {}, timeoutMs: 5000 },
    );
    expect(run.count()).toBe(2); // exit 1 rejected, exit 0 accepted
    expect(run.calls[0].cmd).toBe("status");
  });
});

describe("startLane — ordering & templating", () => {
  test("starts services in dependsOn (topological) order", async () => {
    const { spawnFn, calls } = recordingSpawn();
    const run = scriptedRun([0]);
    await startLane(
      cfg({
        worker: { command: "run worker", portStrategy: "dynamic", portInject: { env: "PORT" }, dependsOn: ["api"], readyCheck: okCommandCheck },
        api: { command: "run api", portStrategy: "dynamic", portInject: { env: "PORT" }, readyCheck: okCommandCheck },
      }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, findPort: counterPort(5000), env: {} },
    );
    expect(calls.map((c) => c.command)).toEqual(["run api", "run worker"]);
  });

  test("resolves {peer.port} and {peer.url} in env from a resolved dependency", async () => {
    const { spawnFn, calls } = recordingSpawn();
    const run = scriptedRun([0]);
    await startLane(
      cfg({
        db: { command: "run db", portStrategy: "dynamic", portInject: { env: "PGPORT" }, readyCheck: okCommandCheck },
        api: {
          command: "run api",
          portStrategy: "dynamic",
          portInject: { env: "PORT" },
          dependsOn: ["db"],
          env: { DATABASE_URL: "postgres://localhost:{db.port}/app", DB_URL: "{db.url}", SELF: "http://localhost:{port}" },
          readyCheck: okCommandCheck,
        },
      }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, findPort: counterPort(5000), env: {} },
    );
    const apiEnv = calls.find((c) => c.command === "run api")!.env;
    expect(apiEnv.DATABASE_URL).toBe("postgres://localhost:5000/app");
    expect(apiEnv.DB_URL).toBe("http://localhost:5000");
    expect(apiEnv.SELF).toBe("http://localhost:5001");
  });

  test("unknown template token throws", async () => {
    const { spawnFn } = recordingSpawn();
    const run = scriptedRun([0]);
    await expect(
      startLane(
        cfg({ api: { command: "run api", portStrategy: "dynamic", portInject: { env: "PORT" }, env: { BAD: "{garbage}" }, readyCheck: okCommandCheck } }),
        "/tmp/proj",
        { spawnFn, runCommand: run.impl, findPort: counterPort(5000), env: {} },
      ),
    ).rejects.toThrow(/unknown template token/);
  });

  test("referencing a non-dependency peer throws (forces honest dependsOn)", async () => {
    const { spawnFn } = recordingSpawn();
    const run = scriptedRun([0]);
    await expect(
      startLane(
        cfg({
          db: { command: "run db", portStrategy: "dynamic", portInject: { env: "PORT" }, readyCheck: okCommandCheck },
          api: { command: "run api", portStrategy: "dynamic", portInject: { env: "PORT" }, env: { X: "{db.url}" }, readyCheck: okCommandCheck },
        }),
        "/tmp/proj",
        { spawnFn, runCommand: run.impl, findPort: counterPort(5000), env: {} },
      ),
    ).rejects.toThrow(/does not depend on "db"/);
  });

  test("unknown dependency name throws", async () => {
    const { spawnFn } = recordingSpawn();
    await expect(
      startLane(
        cfg({ api: { command: "run api", portStrategy: "dynamic", portInject: { env: "PORT" }, dependsOn: ["ghost"], readyCheck: okCommandCheck } }),
        "/tmp/proj",
        { spawnFn },
      ),
    ).rejects.toThrow(/depends on unknown service "ghost"/);
  });
});

describe("startLane — teardown", () => {
  test("a failing service tears down already-started peers", async () => {
    const killLog: string[] = [];
    const { spawnFn, calls } = recordingSpawn(killLog);
    const run = scriptedRun([0]); // service a → ready
    const f = scriptedFetch([500]); // service b → never the wanted 200
    await expect(
      startLane(
        cfg({
          a: { command: "run a", portStrategy: "dynamic", portInject: { env: "PORT" }, readyCheck: okCommandCheck },
          b: { command: "run b", portStrategy: "dynamic", portInject: { env: "PORT" }, dependsOn: ["a"], readyCheck: { kind: "http", path: "/" } },
        }),
        "/tmp/proj",
        { spawnFn, runCommand: run.impl, fetchImpl: f.impl, findPort: counterPort(5000), env: {}, timeoutMs: 300 },
      ),
    ).rejects.toThrow(/service "b" not ready/);
    const childA = calls.find((c) => c.command === "run a")!.child;
    expect(childA.killed).toBe(true); // peer a was torn down
  });

  test("stopAll tears down in reverse order and is idempotent", async () => {
    const killLog: string[] = [];
    const { spawnFn, calls } = recordingSpawn(killLog);
    const run = scriptedRun([0]);
    const lane = await startLane(
      cfg({
        a: { command: "run a", portStrategy: "dynamic", portInject: { env: "PORT" }, readyCheck: okCommandCheck },
        b: { command: "run b", portStrategy: "dynamic", portInject: { env: "PORT" }, dependsOn: ["a"], readyCheck: okCommandCheck },
        c: { command: "run c", portStrategy: "dynamic", portInject: { env: "PORT" }, dependsOn: ["b"], readyCheck: okCommandCheck },
      }),
      "/tmp/proj",
      { spawnFn, runCommand: run.impl, findPort: counterPort(5000), env: {} },
    );

    await lane.stopAll();
    expect(killLog).toEqual(["run c", "run b", "run a"]); // reverse start order
    expect(calls.every((c) => c.child.killed)).toBe(true);

    // Idempotent: a second stopAll kills nothing more.
    killLog.length = 0;
    for (const c of calls) c.child.killed = false;
    await lane.stopAll();
    expect(killLog).toEqual([]);
    expect(calls.every((c) => c.child.killed)).toBe(false);
  });
});
