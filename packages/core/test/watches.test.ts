import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-watches-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
  fs.rmSync(path.join(home, "watches.json"), { force: true });
});

const { addWatch, listWatches, cancelWatch, DEFAULT_TRIGGER_STATES } = await import(
  "../src/watches"
);

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("watches", () => {
  test("add + list roundtrip", () => {
    const w = addWatch({ loomId: "loom_a", sessionId: "sess_1" });
    expect(w.status).toBe("active");
    expect(w.loomId).toBe("loom_a");
    expect(w.sessionId).toBe("sess_1");
    expect(listWatches()).toEqual([w]);
  });

  test("default trigger states applied when omitted", () => {
    const w = addWatch({ loomId: "loom_a", sessionId: "sess_1" });
    expect(w.triggerStates).toEqual(DEFAULT_TRIGGER_STATES);
    const custom = addWatch({ loomId: "loom_b", sessionId: "sess_1", triggerStates: ["done"] });
    expect(custom.triggerStates).toEqual(["done"]);
  });

  test("addWatch replaces the active watch for the same (session, loom)", () => {
    const first = addWatch({ loomId: "loom_a", sessionId: "sess_1" });
    const second = addWatch({ loomId: "loom_a", sessionId: "sess_1", triggerStates: ["ready"] });
    const active = listWatches();
    expect(active).toEqual([second]);
    expect(active.map((w) => w.id)).not.toContain(first.id);
    // a different loom for the same session coexists
    const other = addWatch({ loomId: "loom_b", sessionId: "sess_1" });
    expect(listWatches().map((w) => w.id).sort()).toEqual([second.id, other.id].sort());
  });

  test("listWatches(sessionId) filters by session", () => {
    const a = addWatch({ loomId: "loom_a", sessionId: "sess_1" });
    const b = addWatch({ loomId: "loom_a", sessionId: "sess_2" });
    expect(listWatches("sess_1")).toEqual([a]);
    expect(listWatches("sess_2")).toEqual([b]);
    expect(listWatches().length).toBe(2);
  });

  test("cancelWatch flips status so it drops from listWatches", () => {
    const w = addWatch({ loomId: "loom_a", sessionId: "sess_1" });
    expect(cancelWatch(w.id)).toBe(true);
    expect(listWatches()).toEqual([]);
    // a cancelled watch does not block a fresh one for the same (session, loom)
    const fresh = addWatch({ loomId: "loom_a", sessionId: "sess_1" });
    expect(listWatches()).toEqual([fresh]);
    // cancelling an unknown id returns false
    expect(cancelWatch("watch_missing")).toBe(false);
  });

  test("missing file reads as empty", () => {
    expect(listWatches()).toEqual([]);
  });

  test("corrupt file reads as empty", () => {
    fs.writeFileSync(path.join(home, "watches.json"), "{ not valid json");
    expect(listWatches()).toEqual([]);
    // and a subsequent add still works (overwrites the garbage)
    const w = addWatch({ loomId: "loom_a", sessionId: "sess_1" });
    expect(listWatches()).toEqual([w]);
  });
});
