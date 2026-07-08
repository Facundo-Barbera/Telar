import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-runs-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { appendEvent, createRun, getRun, listRuns, readEvents, saveRun } = await import("../src/runs");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("runs", () => {
  test("createRun persists a queued run and getRun roundtrips it", () => {
    const run = createRun({ project: "p", kind: "quickfix", title: "t", prompt: "do it", account: "personal" });
    expect(run.id).toStartWith("run_");
    expect(run.state).toBe("queued");
    expect(getRun(run.id)).toEqual(run);
  });

  test("saveRun bumps updatedAt atomically", async () => {
    const run = createRun({ project: "p", kind: "story", title: "t2", prompt: "x", account: "personal" });
    const before = run.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    run.state = "running";
    saveRun(run);
    const loaded = getRun(run.id)!;
    expect(loaded.state).toBe("running");
    expect(loaded.updatedAt).toBeGreaterThan(before);
  });

  test("getRun returns null for unknown id", () => {
    expect(getRun("run_nope")).toBeNull();
  });

  test("listRuns sorts by updatedAt desc and skips corrupt dirs", () => {
    fs.mkdirSync(path.join(home, "runs", "corrupt"), { recursive: true });
    fs.writeFileSync(path.join(home, "runs", "corrupt", "run.json"), "{not json");
    const runs = listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i - 1]!.updatedAt).toBeGreaterThanOrEqual(runs[i]!.updatedAt);
    }
    expect(runs.find((r) => r.id === "corrupt")).toBeUndefined();
  });

  test("appendEvent stamps ts and readEvents tails incrementally", () => {
    const run = createRun({ project: "p", kind: "custom", title: "t3", prompt: "x", account: "personal" });
    appendEvent(run.id, { type: "state", state: "running", ts: 1 }); // caller ts must not win
    appendEvent(run.id, { type: "text", text: "hi" });

    const first = readEvents(run.id);
    expect(first.events.map((e) => e.type)).toEqual(["state", "text"]);
    expect(first.events[0]!.ts).toBeGreaterThan(1);
    expect(first.nextLine).toBe(2);

    appendEvent(run.id, { type: "gate", result: { name: "g" } });
    const second = readEvents(run.id, first.nextLine);
    expect(second.events.map((e) => e.type)).toEqual(["gate"]);
    expect(second.nextLine).toBe(3);

    expect(readEvents(run.id, second.nextLine).events).toEqual([]);
  });

  test("readEvents tolerates a trailing partial line", () => {
    const run = createRun({ project: "p", kind: "custom", title: "t4", prompt: "x", account: "personal" });
    appendEvent(run.id, { type: "a" });
    const file = path.join(home, "runs", run.id, "events.ndjson");
    fs.appendFileSync(file, '{"type":"partial"'); // no newline — mid-append
    const { events, nextLine } = readEvents(run.id);
    expect(events.map((e) => e.type)).toEqual(["a"]);
    expect(nextLine).toBe(1);
  });

  test("readEvents on a run with no events", () => {
    const run = createRun({ project: "p", kind: "custom", title: "t5", prompt: "x", account: "personal" });
    expect(readEvents(run.id)).toEqual({ events: [], nextLine: 0 });
  });
});
