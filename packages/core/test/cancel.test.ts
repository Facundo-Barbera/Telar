// Cancel must always stop a loom, even a paused one (charter-review, queued,
// ready, blocked, needs-review) with no live AbortController.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cancel-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { cancelLoom } = await import("../src/dispatcher");
const { createLoom, getLoom, readEvents, saveLoom } = await import("../src/looms");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("cancelLoom (no live AbortController)", () => {
  test("a loom paused in charter-review is halted", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "charter-review";
    saveLoom(loom);

    expect(cancelLoom(loom.id)).toBe(true);

    const loaded = getLoom(loom.id)!;
    expect(loaded.state).toBe("halted");
    expect(loaded.error).toBe("Cancelled by user.");

    const { events } = readEvents(loom.id);
    const stateEvents = events.filter((e) => e.type === "state");
    expect(stateEvents.length).toBe(1);
    expect(stateEvents[0]!.state).toBe("halted");
  });

  test("a loom already in a terminal state ('done') is left unchanged", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "done";
    saveLoom(loom);

    expect(cancelLoom(loom.id)).toBe(false);
    expect(getLoom(loom.id)!.state).toBe("done");
  });

  test("a non-existent loom id returns false", () => {
    expect(cancelLoom("loom_nope")).toBe(false);
  });
});
