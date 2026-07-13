// M5 dispatch transport. The in-process fake is the flag-off byte-identity
// guarantee expressed as code: every verb delegates to the injected dispatcher
// function, carrying `deps` verbatim. A real-dispatcher round-trip proves state
// flows through the transport verb; no HTTP is ever touched.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeInProcessTransport, type DispatcherFacade } from "../src/runner/transport";
import type { DispatcherDeps, StartLoomInput } from "../src/dispatcher";
import type { Loom } from "../src/looms";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-transport-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const dispatcher = await import("../src/dispatcher");
const { createProject } = await import("../src/manifest");
const { getLoom } = await import("../src/looms");

function fakeLoom(id: string): Loom {
  return {
    id,
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    state: "queued",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
  };
}

describe("in-process transport — delegation + deps carried (byte-identity)", () => {
  test("every verb calls the injected dispatcher fn with deps carried verbatim", async () => {
    const calls: { verb: string; args: unknown[] }[] = [];
    const deps = { accounts: {}, policy: undefined } as DispatcherDeps;
    const started = fakeLoom("L1");
    const facade: DispatcherFacade = {
      startLoom: (...a) => (calls.push({ verb: "startLoom", args: a }), started),
      startLoomFromBundle: async (...a) => (calls.push({ verb: "startLoomFromBundle", args: a }), fakeLoom("L2")),
      approveCharter: async (...a) => (calls.push({ verb: "approveCharter", args: a }), true),
      steerLoom: async (...a) => (calls.push({ verb: "steerLoom", args: a }), fakeLoom("L3")),
      rejectLoom: async (...a) => (calls.push({ verb: "rejectLoom", args: a }), fakeLoom("L4")),
      resumeLoom: (...a) => (calls.push({ verb: "resumeLoom", args: a }), fakeLoom("L5")),
      cancelLoom: (...a) => (calls.push({ verb: "cancelLoom", args: a }), true),
      activeLoomIds: () => ["A", "B"],
    };
    const t = makeInProcessTransport(facade, deps, { pid: 7, version: "vX" });

    const input: StartLoomInput = { project: "p", kind: "custom", title: "t", prompt: "x" };
    expect(await t.start(input)).toBe(started);
    expect(await t.startFromBundle("b1", "alice", { maxAttempts: 2 })).toEqual(fakeLoom("L2"));
    expect(await t.approveCharter("c1", "bob")).toBe(true);
    await t.steer("s1", "go", "carol");
    await t.reject("r1", "nope", "dave");
    await t.resume("z1");
    expect(await t.cancel("k1")).toBe(true);
    expect(await t.getActive()).toEqual(["A", "B"]);
    expect(await t.health()).toEqual({ pid: 7, version: "vX", ok: true });

    // deps threaded through on every verb that takes it.
    expect(calls.find((c) => c.verb === "startLoom")!.args).toEqual([input, deps]);
    expect(calls.find((c) => c.verb === "startLoomFromBundle")!.args).toEqual(["b1", "alice", deps, { maxAttempts: 2 }]);
    expect(calls.find((c) => c.verb === "approveCharter")!.args).toEqual(["c1", "bob", deps]);
    expect(calls.find((c) => c.verb === "steerLoom")!.args).toEqual(["s1", "go", "carol", deps]);
    expect(calls.find((c) => c.verb === "rejectLoom")!.args).toEqual(["r1", "nope", "dave", deps]);
    expect(calls.find((c) => c.verb === "resumeLoom")!.args).toEqual(["z1", deps]);
    expect(calls.find((c) => c.verb === "cancelLoom")!.args).toEqual(["k1"]);
  });
});

describe("in-process transport — real dispatcher round-trip", () => {
  test("transport.start drives the real dispatcher to a persisted, verified loom", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-transport-proj-"));
    // A real git repo + a deterministic verifyCommand so the now-unconditional
    // top gate settles hermetically: the frozen-lane verify forks the pinned base,
    // the test-gate strategy establishes the synthesized live-critic slice as a
    // `true` gate (no dev-server lane spun, no auto-repair triggered), and the
    // dispatch chain resolves — so the loom rolls up to ready AND drops out of the
    // active set (both the round-trip assertions below).
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
    const manifest = createProject(root, { name: "transport-proj", verifyCommand: "true" });

    // Fake runLoomFn so no real agent runs — the child just reports done.
    const deps: DispatcherDeps = {
      accounts: {},
      runLoomFn: async (child) => ({ ...child, state: "done" }),
    };
    const facade: DispatcherFacade = {
      startLoom: dispatcher.startLoom,
      startLoomFromBundle: dispatcher.startLoomFromBundle,
      approveCharter: dispatcher.approveCharter,
      steerLoom: dispatcher.steerLoom,
      rejectLoom: dispatcher.rejectLoom,
      resumeLoom: dispatcher.resumeLoom,
      cancelLoom: dispatcher.cancelLoom,
      activeLoomIds: dispatcher.activeLoomIds,
    };
    const t = makeInProcessTransport(facade, deps);

    // acceptanceCriteria present -> the FAST PATH (weave-of-one), no scoping LLM:
    // the whole round-trip is hermetic (the faked runLoomFn is the only executor),
    // so it passes in isolation, not just by suite ordering.
    const loom = await t.start({
      project: manifest.name,
      kind: "custom",
      title: "t",
      prompt: "do a thing",
      acceptanceCriteria: ["the thing is done"],
    });
    expect(loom.id).toBeTruthy();

    // The weave-of-one rolls up to "ready" (never "done" — the moat).
    // Wait for the loom to reach ready AND drop out of the active set — the
    // dispatch chain clears activeLoomIds in a finally that resolves just after
    // the ready state persists (the unconditional top-gate adds async work
    // between the two), so poll on both rather than racing the removal.
    const start = Date.now();
    while (
      (getLoom(loom.id)?.state !== "ready" || (await t.getActive()).includes(loom.id)) &&
      Date.now() - start < 3000
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const final = getLoom(loom.id)!;
    expect(final.state).toBe("ready");

    // getActive mirrors activeLoomIds — after settle the loom is gone from it.
    expect(await t.getActive()).not.toContain(loom.id);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
