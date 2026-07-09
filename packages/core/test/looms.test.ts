import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-looms-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { appendEvent, createLoom, getLoom, listLooms, readEvents, saveLoom } = await import("../src/looms");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("looms", () => {
  test("createLoom persists a queued loom and getLoom roundtrips it", () => {
    const loom = createLoom({ project: "p", kind: "quickfix", title: "t", prompt: "do it", account: "personal" });
    expect(loom.id).toStartWith("loom_");
    expect(loom.state).toBe("queued");
    expect(getLoom(loom.id)).toEqual(loom);
  });

  test("saveLoom bumps updatedAt atomically", async () => {
    const loom = createLoom({ project: "p", kind: "story", title: "t2", prompt: "x", account: "personal" });
    const before = loom.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    loom.state = "running";
    saveLoom(loom);
    const loaded = getLoom(loom.id)!;
    expect(loaded.state).toBe("running");
    expect(loaded.updatedAt).toBeGreaterThan(before);
  });

  test("getLoom returns null for unknown id", () => {
    expect(getLoom("loom_nope")).toBeNull();
  });

  test("listLooms sorts by updatedAt desc and skips corrupt dirs", () => {
    fs.mkdirSync(path.join(home, "looms", "corrupt"), { recursive: true });
    fs.writeFileSync(path.join(home, "looms", "corrupt", "loom.json"), "{not json");
    const looms = listLooms();
    expect(looms.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < looms.length; i++) {
      expect(looms[i - 1]!.updatedAt).toBeGreaterThanOrEqual(looms[i]!.updatedAt);
    }
    expect(looms.find((r) => r.id === "corrupt")).toBeUndefined();
  });

  test("appendEvent stamps ts and readEvents tails incrementally", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t3", prompt: "x", account: "personal" });
    appendEvent(loom.id, { type: "state", state: "running", ts: 1 }); // caller ts must not win
    appendEvent(loom.id, { type: "text", text: "hi" });

    const first = readEvents(loom.id);
    expect(first.events.map((e) => e.type)).toEqual(["state", "text"]);
    expect(first.events[0]!.ts).toBeGreaterThan(1);
    expect(first.nextLine).toBe(2);

    appendEvent(loom.id, { type: "gate", result: { name: "g" } });
    const second = readEvents(loom.id, first.nextLine);
    expect(second.events.map((e) => e.type)).toEqual(["gate"]);
    expect(second.nextLine).toBe(3);

    expect(readEvents(loom.id, second.nextLine).events).toEqual([]);
  });

  test("readEvents tolerates a trailing partial line", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t4", prompt: "x", account: "personal" });
    appendEvent(loom.id, { type: "a" });
    const file = path.join(home, "looms", loom.id, "events.ndjson");
    fs.appendFileSync(file, '{"type":"partial"'); // no newline — mid-append
    const { events, nextLine } = readEvents(loom.id);
    expect(events.map((e) => e.type)).toEqual(["a"]);
    expect(nextLine).toBe(1);
  });

  test("readEvents on a loom with no events", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t5", prompt: "x", account: "personal" });
    expect(readEvents(loom.id)).toEqual({ events: [], nextLine: 0 });
  });
});
