// M5 ensureRunner — injected spawnFn/fetchFn/fs prove the spawn branch fires
// ONLY on spawn-bin/spawn-dev and NEVER on reuse/connect (so tests never spawn
// a real process), and that a spawned runner is polled to health.
import { describe, expect, test } from "bun:test";
import { ensureRunner } from "../src/runner/ensure";
import type { RunnerFs } from "../src/runner/runner-json";
import type { FetchFn } from "../src/runner/http-transport";

// A minimal in-memory fs implementing the RunnerFs slice. readFileSync throws
// (ENOENT-style) when the path is absent — exactly what readRunnerJson catches.
function fakeFs(initial: Record<string, string> = {}): RunnerFs & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    mkdirSync: (() => undefined) as RunnerFs["mkdirSync"],
    writeFileSync: ((p: string, data: string) => {
      store.set(String(p), String(data));
    }) as RunnerFs["writeFileSync"],
    readFileSync: ((p: string) => {
      const v = store.get(String(p));
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    }) as RunnerFs["readFileSync"],
    unlinkSync: ((p: string) => {
      store.delete(String(p));
    }) as RunnerFs["unlinkSync"],
  };
}

const okFetch: FetchFn = async () => ({ ok: true, status: 200 }) as unknown as Response;
const runnerJson = (port: number, token: string) => JSON.stringify({ pid: 1, port, token });

describe("ensureRunner resolution", () => {
  test("connect (TELAR_RUNNER_URL) never spawns", async () => {
    let spawned = 0;
    const t = await ensureRunner({
      telarDir: "/tel",
      runnerUrl: "http://127.0.0.1:9000",
      fs: fakeFs(),
      fetchFn: okFetch,
      spawnFn: () => spawned++,
    });
    expect(spawned).toBe(0);
    expect(typeof t.health).toBe("function");
  });

  test("reuse (healthy runner.json) never spawns", async () => {
    let spawned = 0;
    const fs = fakeFs({ "/tel/runner.json": runnerJson(51000, "tok") });
    const t = await ensureRunner({
      telarDir: "/tel",
      fs,
      fetchFn: okFetch, // /health returns ok → healthOk true → reuse
      spawnFn: () => spawned++,
    });
    expect(spawned).toBe(0);
    expect(typeof t.getActive).toBe("function");
  });

  test("spawn-dev: no url / no healthy runner.json → spawnFn fires, then polls to health", async () => {
    let spawned = 0;
    const fs = fakeFs(); // no runner.json yet
    const t = await ensureRunner({
      telarDir: "/tel",
      fs,
      // The spawned runner "publishes" itself: writing runner.json makes the
      // poll's readRunnerJson succeed on the next iteration.
      spawnFn: () => {
        spawned++;
        fs.store.set("/tel/runner.json", runnerJson(51500, "spawned-tok"));
      },
      fetchFn: okFetch,
      pollIntervalMs: 0,
    });
    expect(spawned).toBe(1);
    expect(typeof t.start).toBe("function");
  });

  test("spawn-bin: TELAR_RUNNER_BIN set spawns the bin path", async () => {
    let spawnedBin: string | null = "unset";
    const fs = fakeFs();
    await ensureRunner({
      telarDir: "/tel",
      runnerBin: "/bin/telar-runner",
      fs,
      spawnFn: (bin) => {
        spawnedBin = bin;
        fs.store.set("/tel/runner.json", runnerJson(52000, "t"));
      },
      fetchFn: okFetch,
      pollIntervalMs: 0,
    });
    expect(spawnedBin).toBe("/bin/telar-runner");
  });

  test("spawn branch requires a spawnFn", async () => {
    await expect(ensureRunner({ telarDir: "/tel", fs: fakeFs(), fetchFn: okFetch })).rejects.toThrow(/spawnFn required/);
  });
});
