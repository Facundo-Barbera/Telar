// Cut U4-B — storage + launch (docs/plans/ultra-harness.md §5). Temp
// TELAR_HOME (never the real ~/.telar, same idiom as ultra-resume.test.ts /
// looms.test.ts), a fake agent() runner (DI seam, no live SDK). Exercises:
// manifest.json/events.ndjson/agents/<ordinal>.ndjson round-trip; launchUltra
// returns {runId} immediately and the run finishes in the background;
// spend/state roll up onto manifest.json as agents settle; stop/resume
// through the storage layer; the registry survives a "hot reload" (a fresh
// require of storage.ts within the same process still sees the same
// globalThis-backed live run).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentOpts } from "../src/engine";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ultra-storage-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin before every test (looms.test.ts idiom).
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const {
  launchUltra,
  resumeUltraRun,
  stopUltraRun,
  getUltraManifest,
  listUltraRuns,
  readUltraEvents,
  readUltraAgentTranscript,
  readUltraScript,
  getLiveUltraRun,
  readJournal,
  hashCall,
  runDir,
  pendingUltraWakes,
} = await import("../src/ultra");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

type Fake = (prompt: string, opts: AgentOpts<any>) => Promise<any>;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abortErr = () => {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
};
const META = `export const meta = { name: "t", description: "d", phases: [] };`;

// A fake that reports cost/turns via onEvent, like the real runner does —
// so the spend rollup has something to accumulate.
const costedFake = (cost: number): Fake => async (p, o) => {
  o.onEvent?.({ type: "result", subtype: "success", costUsd: cost, turns: 1 });
  return { text: p };
};

describe("Ultra storage — launchUltra returns {runId} immediately, non-blocking (doc §4)", () => {
  test("the manifest is seeded `running` before the (slow) agent settles, and `done` once the run finishes", async () => {
    // A deliberately slow fake (macrotask delay, so it settles strictly AFTER
    // every microtask launchUltra's own return needs) makes the "seeded
    // before any agent settles" ordering deterministic to assert, rather than
    // a same-microtask-queue race between launchUltra's resolution and the
    // agent's own continuation.
    const slowCostedFake: Fake = async (p, o) => {
      await delay(20);
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.01, turns: 1 });
      return { text: p };
    };
    const script = `${META}\nexport default async function ({ agent }) { const a = await agent("p0", { model: "sonnet" }); return a; }`;
    const res = await launchUltra({ script, agent: slowCostedFake });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    // Seeded synchronously by launch() before it returns — the agent is
    // still mid-flight (its 20ms delay hasn't elapsed yet).
    const seeded = getUltraManifest(res.runId);
    expect(seeded?.state).toBe("running");
    expect(seeded?.spend).toBe(0);

    // The run itself is NOT awaited by launchUltra — wait for it out-of-band.
    const live = getLiveUltraRun(res.runId);
    expect(live).toBeDefined();
    const result = await live!.finished;
    expect(result.state).toBe("done");

    const final = getUltraManifest(res.runId);
    expect(final?.state).toBe("done");
    expect(final?.spend).toBeCloseTo(0.01);
  });

  test("a compile-reject script returns {ok:false} and persists NOTHING to disk", async () => {
    const script = `${META}\nexport default async function (s) { return require("fs"); }`;
    // A forced runId (test-only, LaunchUltraOpts.runId) so we can check the
    // filesystem directly — a real launch never hands back a runId on
    // reject, which is exactly the bug: without this, nothing could ever
    // prove a directory wasn't silently left behind.
    const runId = "u-compile-reject-test";
    const res = await launchUltra({ script, runId, agent: (async () => null) as any });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("require");
    // The run directory must never be created for a compile reject — no
    // manifest.json is ever written, so a leftover dir would be a permanent,
    // un-reapable orphan (listUltraRuns/getUltraManifest only ever discover a
    // runId through its manifest.json).
    expect(fs.existsSync(runDir(runId))).toBe(false);
    expect(getUltraManifest(runId)).toBeNull();
    expect(listUltraRuns().some((m) => m.runId === runId)).toBe(false);
  });
});

describe("Ultra storage — spend rolls up per settled agent, not just at the end", () => {
  test("manifest.spend reflects each agent's cost as it settles, in issue order", async () => {
    const script = `${META}\nexport default async function ({ agent }) {\n  await agent("a", { model: "sonnet" });\n  await agent("b", { model: "sonnet" });\n  return "done";\n}`;
    let call = 0;
    const fake: Fake = async (p, o) => {
      call++;
      o.onEvent?.({ type: "result", subtype: "success", costUsd: call === 1 ? 0.1 : 0.25, turns: call });
      return { text: p };
    };
    const res = await launchUltra({ script, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    const live = getLiveUltraRun(res.runId)!;
    await live.finished;
    const final = getUltraManifest(res.runId);
    expect(final?.spend).toBeCloseTo(0.35);
  });
});

describe("Ultra storage — manifest.result carries the terminal outcome (doc §5)", () => {
  test("a `done` run persists the script's return value onto the manifest", async () => {
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  return { summary: a };\n}`;
    const res = await launchUltra({ script, agent: costedFake(0.01) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    const m = getUltraManifest(res.runId);
    expect(m?.state).toBe("done");
    expect(m?.result).toEqual({ summary: { text: "p0" } });
  });

  test("a `failed` run (MissingModel) carries `error`, never a stale/undefined `result`", async () => {
    // An empty model string passes the PRE-RUN static lint (it has a literal
    // `model:` key) but still trips the RUNTIME MissingModel check
    // (executor.ts) — the case the static lint can't see through.
    const script = `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "" }); }`;
    const res = await launchUltra({ script, agent: (async () => null) as Fake });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    const m = getUltraManifest(res.runId);
    expect(m?.state).toBe("failed");
    expect(m?.error).toBeTruthy();
    expect(m?.result).toBeUndefined();
  });
});

describe("Ultra storage — events.ndjson tails phase/agent-start/log/agent/state in order", () => {
  test("readUltraEvents returns everything from offset 0, then only new lines after", async () => {
    const script = `${META}\nexport default async function ({ agent, phase, log }) {\n  phase("Phase 1");\n  await agent("p", { model: "sonnet" });\n  log("done");\n  return 1;\n}`;
    const res = await launchUltra({ script, agent: costedFake(0.02) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;

    const { events, nextLine } = readUltraEvents(res.runId, 0);
    const types = events.map((e) => e.type);
    // THIS EXPECTATION CHANGED IN STORY 4.2, and so did this describe's title.
    // It was `["phase", "agent", "log", "state"]`, and that was RIGHT for its
    // story: before 4.2 an agent emitted NOTHING until it settled, so an
    // ordinal was literally invisible on this stream while it worked. It is
    // wrong now because that invisibility was the defect — the frozen session-UI
    // contract's per-agent LIVE row had no data source, and 4.2's `agent-start`
    // is the one additive engine change that gives it one.
    //
    // KEPT AS AN ORDERED `toEqual` DELIBERATELY. Weakening it to `toContain`, or
    // making `agent-start` conditional to preserve the old array, would discard
    // the only claim that matters: that `agent-start` PRECEDES its own `agent`.
    // An unordered assertion cannot say that, and that ordering is the whole
    // reason the event exists.
    expect(types).toEqual(["phase", "agent-start", "agent", "log", "state"]);
    expect(events.every((e) => typeof e.ts === "number")).toBe(true);

    const tail = readUltraEvents(res.runId, nextLine);
    expect(tail.events).toEqual([]);
  });
});

describe("Ultra storage — agents/<ordinal>.ndjson per-agent transcript", () => {
  test("the ordinal's EngineEvent stream is captured, tagged with attempt", async () => {
    const script = `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`;
    const fake: Fake = async (_p, o) => {
      o.onEvent?.({ type: "text", text: "hello" });
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.01, turns: 1 });
      return { text: "ok" };
    };
    const res = await launchUltra({ script, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;

    const transcript = readUltraAgentTranscript(res.runId, 0);
    expect(transcript.map((e) => e.type)).toEqual(["text", "result"]);
    expect(transcript.every((e) => e.attempt === 1)).toBe(true);
  });
});

// ── story 4.2 / AC3 — the "which ordinals have BEGUN" reader ───────────────
//
// THE BARREL IS PROVED, NOT ASSUMED (task B4). `packages/core/src/ultra/index.ts`
// is a list of `export * from "./…"` lines including `"./storage"`, and
// `packages/core/src/index.ts` re-exports `./ultra`, so a new `export function`
// in storage.ts reaches `@telar/core` with NO barrel change. This import is via
// the PACKAGE SPECIFIER rather than the relative path every other symbol in this
// file uses, precisely so that claim is executable: if either barrel stopped
// re-exporting, this line would fail to resolve and the suite would go red
// instead of the web app discovering it at build time.
const { listUltraAgentOrdinals } = await import("@telar/core");

describe("Ultra storage — listUltraAgentOrdinals sees an ordinal BEFORE it settles (4.2 AC3)", () => {
  test("an in-flight ordinal that has streamed but not settled is listed, and `agent-start` precedes its `agent`", async () => {
    // The fake streams one engine event (which is what creates
    // `agents/0.ndjson`) and then blocks, so the run is observed at a moment
    // when ordinal 0 has BEGUN and has NOT SETTLED. Before story 4.2 that
    // moment was unobservable from outside the executor's own process, which is
    // the entire reason the executor was opened for a UI story.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake: Fake = async (_p, o) => {
      o.onEvent?.({ type: "text", text: "working…" });
      await gate;
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.01, turns: 1 });
      return { text: "ok" };
    };
    const script = `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet", effort: "high" }); }`;
    const res = await launchUltra({ script, agent: fake });
    if (!res.ok) throw new Error("unreachable");

    // Wait for the transcript file to exist rather than sleeping a guessed
    // interval — a fixed delay is a flake waiting for a slower machine.
    for (let i = 0; i < 200 && listUltraAgentOrdinals(res.runId).length === 0; i++) {
      await delay(5);
    }

    // THE LEG THAT PROVES THE ENGINE CHANGE LANDED rather than merely compiled.
    expect(listUltraAgentOrdinals(res.runId)).toEqual([0]);
    // ...and it is genuinely NOT settled yet: settlement IS the `agent`
    // UltraEvent, which is exactly why `agent-start` had to be added.
    const mid = readUltraEvents(res.runId, 0).events;
    expect(mid.some((e) => e.type === "agent-start" && e.ordinal === 0)).toBe(true);
    expect(mid.some((e) => e.type === "agent")).toBe(false);
    // `effort` rides the event (AC11 proof 1) — the first reader it has ever had.
    const start = mid.find((e) => e.type === "agent-start");
    expect(start && "effort" in start ? start.effort : undefined).toBe("high");

    release();
    await getLiveUltraRun(res.runId)!.finished;

    const after = readUltraEvents(res.runId, 0).events.map((e) => e.type);
    expect(after.indexOf("agent-start")).toBeLessThan(after.indexOf("agent"));
    expect(listUltraAgentOrdinals(res.runId)).toEqual([0]);
  });

  test("a run that has spawned nothing lists no ordinals, and an unknown runId is empty rather than a throw", async () => {
    const script = `${META}\nexport default async function () { return 1; }`;
    const res = await launchUltra({ script, agent: costedFake(0) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    // The anti-vacuity direction: a reader that returned [0] for everything
    // would pass the test above and be useless.
    expect(listUltraAgentOrdinals(res.runId)).toEqual([]);
    expect(listUltraAgentOrdinals("u-does-not-exist")).toEqual([]);
  });

  test("ordinals come back numerically sorted, not lexicographically", async () => {
    // `readdirSync` yields "10.ndjson" before "2.ndjson"; a reader that forgot
    // to sort numerically would mis-order every run with ten or more agents,
    // and no run in any other test here has that many.
    const script =
      `${META}\nexport default async function ({ agent }) {\n` +
      `  const out = [];\n` +
      `  for (let i = 0; i < 12; i++) out.push(await agent("p" + i, { model: "sonnet" }));\n` +
      `  return out.length;\n}`;
    const fake: Fake = async (_p, o) => {
      o.onEvent?.({ type: "text", text: "t" });
      return { text: "ok" };
    };
    const res = await launchUltra({ script, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    expect(listUltraAgentOrdinals(res.runId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe("Ultra storage — script.js persistence + bare resume round-trip (doc §3)", () => {
  test("a bare resume (no script in the request) replays via the persisted script text", async () => {
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a, b];\n}`;
    const res = await launchUltra({ script, agent: costedFake(0.01) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    expect(readUltraScript(res.runId)).toBe(script);

    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — full prefix should be cache-served");
    };
    const resumed = await resumeUltraRun(res.runId, { agent: throwingFake });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("unreachable");
    const result = await getLiveUltraRun(resumed.runId)!.finished;
    expect(result.state).toBe("done");
    expect(liveCalls).toBe(0); // fully cache-served
  });

  test("resuming with an edited script overwrites the persisted copy", async () => {
    const original = `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`;
    const res = await launchUltra({ script: original, agent: costedFake(0) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;

    const edited = `${META}\nexport default async function ({ agent }) { return agent("p0-EDITED", { model: "sonnet" }); }`;
    const seen: string[] = [];
    const trackingFake: Fake = async (p) => {
      seen.push(p);
      return { text: p };
    };
    const resumed = await resumeUltraRun(res.runId, { script: edited, agent: trackingFake });
    expect(resumed.ok).toBe(true);
    await getLiveUltraRun(res.runId)!.finished;
    expect(seen).toEqual(["p0-EDITED"]);
    expect(readUltraScript(res.runId)).toBe(edited);
  });

  test("resuming a malformed/traversal runId fails cleanly, never throws", async () => {
    const resumed = await resumeUltraRun("../../etc", { script: "malicious" });
    expect(resumed.ok).toBe(false);
    if (resumed.ok) throw new Error("unreachable");
    expect(resumed.error).toContain("invalid ultra runId");
  });

  test("resuming an unknown runId with no persisted script fails cleanly", async () => {
    const resumed = await resumeUltraRun("u-does-not-exist", {});
    expect(resumed.ok).toBe(false);
    if (resumed.ok) throw new Error("unreachable");
    expect(resumed.error).toContain("not found");
  });

  test("resuming a still-running run is refused (never two live tasks against one journal)", async () => {
    const script = `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`;
    const hangingFake: Fake = (_p, o) =>
      new Promise((_res, rej) => {
        o.abort!.signal.addEventListener("abort", () => rej(abortErr()), { once: true });
      });
    const res = await launchUltra({ script, agent: hangingFake });
    if (!res.ok) throw new Error("unreachable");
    await delay(5);
    const resumed = await resumeUltraRun(res.runId, {});
    expect(resumed.ok).toBe(false);
    if (resumed.ok) throw new Error("unreachable");
    expect(resumed.error).toContain("already running");
    stopUltraRun(res.runId); // clean up the hung task
    await getLiveUltraRun(res.runId)!.finished;
  });
});

describe("Ultra storage — stopUltraRun", () => {
  test("stops a live run; returns false for an unknown or already-terminal run", async () => {
    const script = `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`;
    const hangingFake: Fake = (_p, o) =>
      new Promise((_res, rej) => {
        o.abort!.signal.addEventListener("abort", () => rej(abortErr()), { once: true });
      });
    const res = await launchUltra({ script, agent: hangingFake });
    if (!res.ok) throw new Error("unreachable");
    await delay(5);
    expect(stopUltraRun(res.runId)).toBe(true);
    const result = await getLiveUltraRun(res.runId)!.finished;
    expect(result.state).toBe("stopped");

    expect(stopUltraRun(res.runId)).toBe(false); // already terminal
    expect(stopUltraRun("u-not-a-real-run")).toBe(false);
  });
});

// ── The terminal write path, opened deliberately ────────────────────────────
//
// Both bugs below were RECORDED and re-deferred three times (deferred-work.md
// L143/L172/L186, story 4.1's completion note 17, story 4.2's scope-fence
// table), each time to "whichever story next opens ultra's terminal write path
// deliberately". These tests are the close-out.
//
// The fs-failure class is reproduced WITHOUT mocking fs: saveManifest writes
// `manifest.json.tmp` then renames it, so making that exact path a DIRECTORY
// makes writeFileSync throw EISDIR — deterministic, platform-independent, and it
// leaves every other write in the run alone.
const blockManifestWrite = (runId: string) =>
  fs.mkdirSync(path.join(runDir(runId), "manifest.json.tmp"), { recursive: true });

describe("Ultra storage — an unserializable return value is a tombstone, never a stranded run", () => {
  test("a BigInt return value settles `done` on disk with a tombstone result", async () => {
    // BigInt(1) rather than a `1n` literal: this workspace's tsconfig target
    // rejects the literal form (ultra-wake.test.ts notes the same for the same
    // reason), and the sandbox's deterministic globals include BigInt.
    const script = `${META}\nexport default async function () { return { n: BigInt(1) }; }`;
    const res = await launchUltra({ script, agent: costedFake(0) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    const m = getUltraManifest(res.runId);
    expect(m?.state).toBe("done"); // NOT "running", NOT "stopped"
    expect(typeof m?.result).toBe("string");
    expect(m?.result as string).toContain("could not be serialized");
  });

  test("a circular return value settles `done` the same way", async () => {
    const script = `${META}\nexport default async function () { const o = {}; o.self = o; return o; }`;
    const res = await launchUltra({ script, agent: costedFake(0) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    const m = getUltraManifest(res.runId);
    expect(m?.state).toBe("done");
    expect(m?.result as string).toContain("could not be serialized");
  });
});

describe("Ultra storage — a terminal write that CANNOT land releases the run instead of stranding it", () => {
  test("the wake becomes REACHABLE (it is not accurate): the handle is released and the next read says `stopped`", async () => {
    const runId = "u-terminal-write-blocked";
    const sessionId = "sess-terminal-blocked";
    const script = `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`;
    // Block from INSIDE the agent: after launch()'s own manifest write, before
    // the terminal one.
    const blockingFake: Fake = async (p, o) => {
      blockManifestWrite(runId);
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.01, turns: 1 });
      return { text: p };
    };
    const res = await launchUltra({ runId, script, sessionId, agent: blockingFake });
    if (!res.ok) throw new Error("unreachable");
    const live = getLiveUltraRun(runId)!;
    const finished = await live.finished;
    // The RUN itself finished normally — a bookkeeping write never fails a run.
    expect(finished.state).toBe("done");
    await delay(5); // let the fire-and-forget terminal .then() run

    const { events } = readUltraEvents(runId, 0);
    const logs = events.filter((e) => e.type === "log").map((e) => (e as { msg: string }).msg);
    expect(logs.some((m) => m.startsWith("terminal-manifest-write-failed"))).toBe(true);

    // THE RECOVERY. The handle is gone, so getUltraManifest's self-heal — which
    // is gated on exactly that — can finally fire.
    expect(getLiveUltraRun(runId)).toBeUndefined();
    const m = getUltraManifest(runId);
    expect(m?.state).toBe("stopped"); // never "running"

    // …and THAT is what makes the completion wake reachable, which is the AC.
    expect(pendingUltraWakes(sessionId).map((w) => w.runId)).toContain(runId);
  });

  test("the SETTLE write is contained too — a second agent still runs and the script still returns", async () => {
    const runId = "u-settle-write-blocked";
    const script = `${META}\nexport default async function ({ agent }) {\n  await agent("a", { model: "sonnet" });\n  await agent("b", { model: "sonnet" });\n  return "finished anyway";\n}`;
    let call = 0;
    const blockingFake: Fake = async (p, o) => {
      if (++call === 1) blockManifestWrite(runId);
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.01, turns: 1 });
      return { text: p };
    };
    const res = await launchUltra({ runId, script, agent: blockingFake });
    if (!res.ok) throw new Error("unreachable");
    const finished = await getLiveUltraRun(runId)!.finished;
    expect(finished.state).toBe("done");
    expect(finished.result).toBe("finished anyway");
    expect(call).toBe(2); // the second agent really did run

    const { events } = readUltraEvents(runId, 0);
    const logs = events.filter((e) => e.type === "log").map((e) => (e as { msg: string }).msg);
    expect(logs.some((m) => m.startsWith("settle-manifest-write-failed ordinal=0"))).toBe(true);
  });
});

describe("Ultra storage — the self-heal write can no longer throw on a READ path", () => {
  // getUltraManifest is called by listUltraRuns for EVERY run directory, and
  // pendingUltraWakes calls that on every chat POST for every session — so one
  // bad manifest anywhere used to 500 every chat turn in the app, including
  // sessions that had never touched Ultra. Both escapes below are reproductions
  // of the two apps/web/app/api/chat/route.ts's own comment names.
  test("a stale `running` manifest whose heal cannot be PERSISTED is still healed for the reader", async () => {
    const runId = "u-selfheal-blocked";
    const dir = runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ runId, meta: {}, state: "running", spend: 0, startedAt: 1, updatedAt: 1 }),
    );
    blockManifestWrite(runId);
    const read = getUltraManifest(runId);
    expect(read?.state).toBe("stopped");
    // Nothing was persisted — the RETURN is the contract, the write is an
    // optimisation, and the same condition re-heals identically next read.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(onDisk.state).toBe("running");
    expect(getUltraManifest(runId)?.state).toBe("stopped");
  });

  test("a `running` manifest with NO runId key heals instead of throwing `invalid ultra runId: undefined`", async () => {
    const runId = "u-selfheal-no-runid";
    const dir = runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ meta: {}, state: "running", spend: 0, startedAt: 1, updatedAt: 1 }),
    );
    expect(() => getUltraManifest(runId)).not.toThrow();
    expect(getUltraManifest(runId)?.state).toBe("stopped");
    // …and the whole-directory scan every chat turn performs survives it.
    expect(() => listUltraRuns()).not.toThrow();
  });

  test("ANTI-VACUITY — an ordinary stale `running` manifest still gets its heal PERSISTED", async () => {
    // The fix must not degrade into "never persist the heal".
    const runId = "u-selfheal-persists";
    const dir = runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ runId, meta: {}, state: "running", spend: 0, startedAt: 1, updatedAt: 1 }),
    );
    expect(getUltraManifest(runId)?.state).toBe("stopped");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(onDisk.state).toBe("stopped");
  });
});

describe("Ultra storage — listUltraRuns + self-healing manifest read (doc §3 startup reconciliation)", () => {
  test("a `running` manifest with no live registry entry self-heals to `stopped` on read", async () => {
    // Simulate a process restart: a manifest claims `running` but this
    // process's registry never held it (write it directly, bypassing launch).
    const runId = "u-orphaned-manifest";
    const dir = runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        runId,
        meta: {},
        state: "running",
        spend: 0,
        startedAt: 1,
        updatedAt: 1,
      }),
    );
    const read = getUltraManifest(runId);
    expect(read?.state).toBe("stopped");

    const listed = listUltraRuns().find((m) => m.runId === runId);
    expect(listed?.state).toBe("stopped");
  });

  test("listUltraRuns is newest-first by startedAt", async () => {
    const script = `${META}\nexport default async function () { return 1; }`;
    const first = await launchUltra({ script, agent: costedFake(0) });
    if (!first.ok) throw new Error("unreachable");
    await getLiveUltraRun(first.runId)!.finished;
    await delay(2);
    const second = await launchUltra({ script, agent: costedFake(0) });
    if (!second.ok) throw new Error("unreachable");
    await getLiveUltraRun(second.runId)!.finished;

    const ids = listUltraRuns().map((m) => m.runId);
    expect(ids.indexOf(second.runId)).toBeLessThan(ids.indexOf(first.runId));
  });
});

describe("Ultra storage — sessionId/messageId/account linkage (doc §5)", () => {
  test("manifest carries the launch-time session/message/account link", async () => {
    const script = `${META}\nexport default async function () { return 1; }`;
    const res = await launchUltra({
      script,
      agent: costedFake(0),
      sessionId: "sess-1",
      messageId: "msg-1",
      account: { name: "personal" },
    });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    const m = getUltraManifest(res.runId);
    expect(m?.sessionId).toBe("sess-1");
    expect(m?.messageId).toBe("msg-1");
    expect(m?.account).toBe("personal");
  });

  test("manifest carries the launch-time project root; a resume with no override inherits it", async () => {
    const script = `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`;
    const seenCwd: (string | undefined)[] = [];
    const fake: Fake = async (p, o) => {
      seenCwd.push(o.cwd);
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0, turns: 1 });
      return { text: p };
    };
    const res = await launchUltra({ script, agent: fake, project: "/tmp/my-project", account: { name: "personal" } });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    expect(getUltraManifest(res.runId)?.project).toBe("/tmp/my-project");
    expect(seenCwd).toEqual(["/tmp/my-project"]);

    // Resume with an EDITED script (forces a live call past the journal
    // cache, doc §3) and NO project/account override — both should be
    // re-resolved from the original manifest (project verbatim, account via
    // getAccount), never silently falling back to this process's own cwd.
    const edited = script.replace("p0", "p0-edited");
    const resumed = await resumeUltraRun(res.runId, { script: edited, agent: fake });
    if (!resumed.ok) throw new Error("unreachable");
    await getLiveUltraRun(resumed.runId)!.finished;
    expect(seenCwd).toEqual(["/tmp/my-project", "/tmp/my-project"]);
    expect(getUltraManifest(resumed.runId)?.account).toBe("personal");
  });

  // ── Story 4.1 / AC5 — the ledger row learns which chat TURN owns it ────────

  test("4.1 the ledger row on disk carries messageId, and it is the launching turn's id", async () => {
    // FR-UW-5's attribution, read back off the file rather than inferred from a
    // projection — the row is where the claim lives, so the row is what is read.
    const script = `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`;
    const res = await launchUltra({
      script,
      agent: costedFake(0.5),
      sessionId: "sess-4-1",
      messageId: "turn-4-1",
      account: { name: "personal" },
    });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    const lines = ultraLinesFor(res.runId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.messageId).toBe("turn-4-1");
    expect(lines[0]!.sessionId).toBe("sess-4-1");
    expect(lines[0]!.ownerKind).toBe("ultra");
    expect(lines[0]!.ownerId).toBe(res.runId);
    // NO NEW CALL SITE: this is a field on the row storage.ts already wrote, so
    // the fold's own answer for this run is unchanged in value.
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: res.runId })).toBeCloseTo(0.5);
  });

  test("4.1 a run launched with NO messageId writes no messageId key at all", async () => {
    // Additive and defaulted (AD-7): an un-attributed row must stay
    // byte-identical to one written before the field existed, so the key is
    // omitted rather than serialized as "".
    const script = `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`;
    const res = await launchUltra({ script, agent: costedFake(0.25), sessionId: "sess-4-1-b" });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    const [row] = ultraLinesFor(res.runId);
    expect(Object.keys(row!)).not.toContain("messageId");
    expect(row!.sessionId).toBe("sess-4-1-b");
  });
});

// ── Story 4.1 / AC4 — the terminal publish ──────────────────────────────────

describe("Ultra storage — the terminal write publishes ultra:run-completed (AC4)", () => {
  test("the publish fires ONCE, after the durable manifest write, carrying the manifest's own fields", async () => {
    const { resetBus, subscribe } = await import("../src/event-bus");
    const { ultraEvents, ULTRA_RUN_COMPLETED } = await import("../src/ultra");
    resetBus();
    // Subscribe on the ORDINARY channel: this test is about the publish site,
    // not about the wake channel (which packages/core/test/ultra-wake.test.ts
    // owns). Installing the declaration first is what the accessor is for.
    ultraEvents();
    const seen: any[] = [];
    const off = subscribe(ULTRA_RUN_COMPLETED, (p) => seen.push(p));
    try {
      const script = `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`;
      const res = await launchUltra({
        script,
        agent: costedFake(1.5),
        sessionId: "sess-pub",
        messageId: "turn-pub",
      });
      if (!res.ok) throw new Error("unreachable");
      await getLiveUltraRun(res.runId)!.finished;
      // The .then() runs on a microtask after `finished` settles — yield once so
      // the assertion is about the publish rather than about the scheduler.
      await delay(5);
      expect(seen).toHaveLength(1);
      const m = getUltraManifest(res.runId)!;
      expect(seen[0]).toMatchObject({
        runId: res.runId,
        sessionId: "sess-pub",
        messageId: "turn-pub",
        state: "done",
        name: "t", // META's `export const meta = { name: "t", … }`
        spendUsd: m.spend,
        terminalAt: m.updatedAt,
      });
      // ORDER: the manifest is already terminal and already carries the spend
      // the payload states, so if only one of the two survived it is the
      // durable one.
      expect(m.state).toBe("done");
      expect(m.spend).toBeCloseTo(1.5);
    } finally {
      off();
      resetBus();
    }
  });

  test("a SUBSCRIBER that throws never fails the run — the terminal manifest still lands", async () => {
    const { resetBus, subscribe } = await import("../src/event-bus");
    const { ultraEvents, ULTRA_RUN_COMPLETED } = await import("../src/ultra");
    resetBus();
    ultraEvents();
    // NAMED FOR WHAT THE FIXTURE ACTUALLY DOES. This test read "a publish that
    // THROWS" until the story-4.1 code review (NH-2), and it never made the
    // publish throw: a throwing SUBSCRIBER is caught by `publish` by design and
    // reported as a failed delivery, so the publish call itself returns
    // normally. The property is real and worth pinning; the old title claimed a
    // second one, and someone hardening this path could have read it as licence
    // to remove the storage-side try/catch around `publish` ITSELF — the guard
    // that covers an undeclared name after a stray resetBus or a payload the
    // schema refuses, and the one that is genuinely still untested here.
    const off = subscribe(ULTRA_RUN_COMPLETED, () => {
      throw new Error("subscriber exploded");
    });
    try {
      const script = `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`;
      const res = await launchUltra({ script, agent: costedFake(0.75), sessionId: "sess-pub-boom" });
      if (!res.ok) throw new Error("unreachable");
      await getLiveUltraRun(res.runId)!.finished;
      await delay(5);
      const m = getUltraManifest(res.runId)!;
      expect(m.state).toBe("done");
      expect(m.spend).toBeCloseTo(0.75);
    } finally {
      off();
      resetBus();
    }
  });
});

// ── CAP-2 / AC6(b): manifest.spend is a PROJECTION over usage.ndjson ─────────
// Not a closure counter. Each test below moves the ledger through a path a
// `spend +=` accumulator cannot observe, then asserts the manifest moved.
const { ledgerSpendUsd } = await import("../src/usage-ledger");

const ledgerFile = () => path.join(process.env.TELAR_HOME!, "usage.ndjson");
const ultraLinesFor = (runId: string): Record<string, unknown>[] => {
  let text = "";
  try {
    text = fs.readFileSync(ledgerFile(), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.ownerKind === "ultra" && e.ownerId === runId);
};

// The rows AS THE FOLD COUNTS THEM: first occurrence of each non-empty
// entryKey, plus every un-keyed row. The ledger's write path never suppresses a
// row (usage-ledger.ts: idempotence enforced by suppressing a write "leaves no
// row anywhere… a duplicate row is visible and arguable; a missing row is
// silent"), so a settle that is RE-PRESENTED — every cache replay is one —
// appends another row carrying the SAME key. That is the audit trail, not a
// double-count: what must not move is the TOTAL, and the fold is what holds it
// still. Tests below assert the money through this, and assert the raw row
// count separately where the point is that the trail was kept.
const foldedUltraCosts = (runId: string): number[] => {
  const byKey = new Map<string, number>();
  const unkeyed: number[] = [];
  for (const l of ultraLinesFor(runId)) {
    const key = String(l.entryKey ?? "");
    if (!key) unkeyed.push(l.costUsd as number);
    else if (!byKey.has(key)) byKey.set(key, l.costUsd as number);
  }
  return [...byKey.values(), ...unkeyed];
};

describe("Ultra storage — manifest.spend is a projection over the usage ledger (AD-18)", () => {
  test("manifest.spend equals ledgerSpendUsd for owner ultra/<runId>", async () => {
    const script = `${META}\nexport default async function ({ agent }) {\n  await agent("a", { model: "sonnet" });\n  await agent("b", { model: "sonnet" });\n  return "done";\n}`;
    let call = 0;
    const fake: Fake = async (p, o) => {
      call++;
      o.onEvent?.({ type: "result", subtype: "success", costUsd: call === 1 ? 0.2 : 0.3, turns: 1 });
      return { text: p };
    };
    const res = await launchUltra({ script, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;

    const manifest = getUltraManifest(res.runId);
    expect(manifest?.spend).toBeCloseTo(0.5);
    expect(manifest?.spend).toBeCloseTo(ledgerSpendUsd({ ownerKind: "ultra", ownerId: res.runId }));
    // Exactly two ultra-owned lines — one per live settle, no new ledger file.
    expect(ultraLinesFor(res.runId)).toHaveLength(2);
  });

  test("a ledger line appended out-of-band for the run raises the next saved manifest's spend", async () => {
    // Decisive: a `spend +=` closure cannot see a line it did not add itself.
    const script = `${META}\nexport default async function ({ agent }) {\n  await agent("a", { model: "sonnet" });\n  await agent("b", { model: "sonnet" });\n  return "done";\n}`;
    const runId = "u-oob-projection-test";
    let call = 0;
    const fake: Fake = async (p, o) => {
      call++;
      if (call === 1) {
        // Between the first and second settle, a third party appends spend
        // attributed to this run.
        fs.appendFileSync(
          ledgerFile(),
          JSON.stringify({
            ts: Date.now(),
            account: "personal",
            model: "sonnet",
            sessionId: "",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            costUsd: 4,
            ownerKind: "ultra",
            ownerId: runId,
          }) + "\n",
        );
      }
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.1, turns: 1 });
      return { text: p };
    };
    const res = await launchUltra({ script, runId, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    // 0.1 + 0.1 from the two settles, plus the 4 nobody told the closure about.
    expect(getUltraManifest(runId)?.spend).toBeCloseTo(4.2);
  });

  test("resuming a run with a fully cached prefix does not double-count its spend", async () => {
    // A cache-hit replay re-emits the agent event WITH its cost but never
    // re-makes the call. storage.ts now RE-ATTEMPTS the ledger write on that
    // replay (so an ordinal whose live write failed gets repaired — see the
    // repair test below); what keeps the total identical is the entryKey
    // `ultra:<runId>:<ordinal>:<settleId>`, which the replay re-presents
    // VERBATIM — the id the settle it is replaying MINTED, read back off that
    // settle's journal record, never a fresh one — and which usage-ledger.ts
    // folds AT MOST ONCE. The write path never dedupes, so the replay DOES
    // append one row per replayed settle (asserted below); the total is the
    // thing that must not move.
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a, b];\n}`;
    const res = await launchUltra({ script, agent: costedFake(0.25) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;

    const firstRunSpend = getUltraManifest(res.runId)!.spend;
    expect(firstRunSpend).toBeCloseTo(0.5);
    const linesAfterFirstRun = ultraLinesFor(res.runId).length;
    expect(linesAfterFirstRun).toBe(2);

    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — full prefix should be cache-served");
    };
    const resumed = await resumeUltraRun(res.runId, { agent: throwingFake });
    if (!resumed.ok) throw new Error("unreachable");
    await getLiveUltraRun(resumed.runId)!.finished;

    expect(liveCalls).toBe(0); // fully cache-served
    // Each replayed ordinal RE-RECORDS its row — the write path suppresses
    // nothing — so the file grows by one row per replayed settle, and every one
    // of those rows repeats a key that is already there. The total is what must
    // not move: not ~2x, which is what re-presenting them under FRESH keys
    // would produce.
    expect(ultraLinesFor(res.runId)).toHaveLength(linesAfterFirstRun * 2);
    expect(new Set(ultraLinesFor(res.runId).map((l) => String(l.entryKey))).size).toBe(linesAfterFirstRun);
    expect(foldedUltraCosts(res.runId)).toEqual([0.25, 0.25]);
    expect(getUltraManifest(res.runId)!.spend).toBeCloseTo(firstRunSpend);
  });

  test("a resumed run's manifest spend starts from the persisted prefix, not zero", async () => {
    // The intended behavior change: on a FRESH launch the seeded spend is
    // still 0 (nothing is in the ledger for a brand-new runId), but a RESUME
    // reflects the prefix immediately, because spend is a projection.
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a, b];\n}`;
    const res = await launchUltra({ script, agent: costedFake(0.75) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;
    expect(getUltraManifest(res.runId)!.spend).toBeCloseTo(1.5);

    const resumed = await resumeUltraRun(res.runId, { agent: costedFake(0.75) });
    if (!resumed.ok) throw new Error("unreachable");
    await getLiveUltraRun(resumed.runId)!.finished;
    expect(getUltraManifest(res.runId)!.spend).toBeCloseTo(1.5);
  });
});

// ── The ultra spend RECOVERY contract ───────────────────────────────────────
// The ledger row is the only record that ultra money was spent, and it is
// written inside onEvent — AFTER executor.ts has already journaled the ordinal
// (executor.ts:285-297). The two tests below pin both halves of what that
// ordering buys: a write that fails never costs the run, and the next resume
// repairs the gap without re-billing anything that already landed.

// Fails ONLY the usage-ledger append whose payload carries `match`. Deliberately
// narrow: the run's own events.ndjson / agents/<n>.ndjson writes go through the
// SAME fs.appendFileSync, and they must stay healthy so the test reproduces the
// finding (an accounting row lost while the run itself is fine) rather than a
// generally broken filesystem.
function failLedgerWrite(match: string): () => void {
  const real = fs.appendFileSync;
  (fs as any).appendFileSync = (file: any, data: any, ...rest: any[]) => {
    if (String(file).endsWith("usage.ndjson") && String(data).includes(match)) {
      throw new Error("EROFS: read-only file system, open 'usage.ndjson'");
    }
    return (real as any)(file, data, ...rest);
  };
  return () => {
    (fs as any).appendFileSync = real;
  };
}

const waitUntil = async (pred: () => boolean, ms = 2000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await delay(2);
  }
  return pred();
};

// The failure is narrated onto events.ndjson as a `log` line (storage.ts keeps
// executor.ts's UltraEvent union closed), so it is greppable by its prefix.
const spendFailures = (runId: string): string[] => {
  const out: string[] = [];
  for (const e of readUltraEvents(runId, 0).events) {
    if (e.type === "log" && e.msg.startsWith("spend-record-failed")) out.push(e.msg);
  }
  return out;
};

// Same idea, for the other two ways this leg narrates a miss. Every accounting
// defect on the ultra leg is a `log` line with a stable prefix, so each is
// greppable without widening executor.ts's UltraEvent union.
const logLinesPrefixed = (runId: string, prefix: string): string[] => {
  const out: string[] = [];
  for (const e of readUltraEvents(runId, 0).events) {
    if (e.type === "log" && e.msg.startsWith(prefix)) out.push(e.msg);
  }
  return out;
};

describe("Ultra storage — a failed ledger write never fails the run", () => {
  test("the run still settles `done`, the manifest keeps being saved, and the miss lands in the run journal", async () => {
    const runId = "u-ledger-write-fails";
    // Two GATED agents, so the run is provably still live at the moment the
    // failing write happens — a manifest read taken in that window can only
    // have been produced by the saveManifest that sits AFTER the logUsage call.
    const script = `${META}\nexport default async function ({ agent }) {\n  await agent("a", { model: "sonnet" });\n  await agent("b", { model: "sonnet" });\n  return "ok";\n}`;
    let releaseA = () => {};
    let releaseB = () => {};
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));
    let call = 0;
    const fake: Fake = async (p, o) => {
      const n = ++call;
      await (n === 1 ? gateA : gateB);
      o.onEvent?.({ type: "result", subtype: "success", costUsd: n === 1 ? 0.5 : 0.25, turns: 1 });
      return { text: p };
    };

    const res = await launchUltra({ script, runId, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    expect(getUltraManifest(runId)?.spend).toBe(0); // both agents still gated

    // An out-of-band row for this run, appended BEFORE the fs patch. This is
    // the OBSERVABLE for "saveManifest still ran": the seeded manifest above
    // read 0, so only a manifest write issued after the throwing logUsage can
    // report 9.
    fs.appendFileSync(
      ledgerFile(),
      JSON.stringify({
        ts: Date.now(),
        account: "personal",
        model: "sonnet",
        sessionId: "",
        costUsd: 9,
        ownerKind: "ultra",
        ownerId: runId,
      }) + "\n",
    );

    const restore = failLedgerWrite(`ultra:${runId}:0`);
    try {
      releaseA();
      expect(await waitUntil(() => getUltraManifest(runId)?.spend === 9)).toBe(true);
      // Still `running`, not `failed` — the throw never reached the script's
      // own `await agent()`, which is what the old unguarded call would have
      // done to a run that had already been billed.
      expect(getUltraManifest(runId)?.state).toBe("running");
    } finally {
      restore();
    }

    // Not swallowed: the miss is on the run's durable event log, naming the ordinal.
    const failures = spendFailures(runId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("ordinal=0");

    releaseB();
    const result = await getLiveUltraRun(runId)!.finished;
    expect(result.state).toBe("done");

    // Ordinal 0's row is the only casualty: the out-of-band 9 and ordinal 1's
    // 0.25 both landed. Repairing ordinal 0 is the next test's job.
    expect(getUltraManifest(runId)?.spend).toBeCloseTo(9.25);
    expect(ultraLinesFor(runId)).toHaveLength(2);
  });
});

describe("Ultra storage — a resume REPAIRS an ordinal whose ledger write failed", () => {
  test("the failed ordinal's row lands on the cached replay, and the ordinals that already have rows do not double", async () => {
    const runId = "u-ledger-repair-on-resume";
    const script = `${META}\nexport default async function ({ agent }) {\n  await agent("a", { model: "sonnet" });\n  await agent("b", { model: "sonnet" });\n  await agent("c", { model: "sonnet" });\n  return "ok";\n}`;
    // Distinct powers of two, so any wrong total names the wrong ordinal
    // unambiguously rather than merely being "off".
    const costs = [1, 2, 4];
    let call = 0;
    const fake: Fake = async (p, o) => {
      o.onEvent?.({ type: "result", subtype: "success", costUsd: costs[call++], turns: 1 });
      return { text: p };
    };

    // Only ordinal 1's ledger row fails. appendJournal already ran, so the
    // journal holds that ordinal WITH its cost — which is exactly what makes
    // the gap repairable rather than lost.
    const restore = failLedgerWrite(`ultra:${runId}:1`);
    try {
      const res = await launchUltra({ script, runId, agent: fake });
      if (!res.ok) throw new Error("unreachable");
      expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    } finally {
      restore();
    }

    // 1 + 4. The middle $2 is real, journaled, spent — and not in the ledger.
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(5);
    expect(ultraLinesFor(runId)).toHaveLength(2);
    expect(spendFailures(runId).some((m) => m.includes("ordinal=1"))).toBe(true);

    // Resume with a fake that throws if it is ever called: the whole prefix is
    // cache-served, so no agent call is re-made and no NEW money is spent.
    // Under the old `!e.cached` guard this replay wrote nothing at all and the
    // gap was permanent — that is the finding, and this is the repair.
    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — full prefix should be cache-served");
    };
    const resumed = await resumeUltraRun(runId, { agent: throwingFake });
    if (!resumed.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    expect(liveCalls).toBe(0);

    // All three replays re-record; only ordinal 1's row is new MONEY. Ordinals
    // 0 and 2 come back under the entryKey they already hold and so cost
    // nothing — the dedupe is a property of the ledger fold, not of this
    // process's memory — while their duplicate rows stay on the file as the
    // audit trail of the replay.
    const lines = ultraLinesFor(runId);
    expect(lines).toHaveLength(5); // 2 from the first run + 3 re-presented
    expect(new Set(lines.map((l) => String(l.entryKey))).size).toBe(3);
    expect(foldedUltraCosts(runId).sort((a, b) => a - b)).toEqual([1, 2, 4]);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(7);
    expect(getUltraManifest(runId)?.spend).toBeCloseTo(7);
  });
});

// ── A COST THE LEDGER CANNOT ACCEPT IS REPORTED, NEVER DROPPED ──────────────
// `typeof e.costUsd === "number"` is a TYPE check, and `typeof NaN` is
// "number". A provider-reported NaN therefore reached logUsage, failed
// UsageEntry's z.number() (which rejects NaN), and came back as `false` — NOT a
// throw — so the try/catch beside the call could not fire and the settle was
// missing from usage.ndjson, from manifest.spend AND from events.ndjson at
// once, with a console line as its only trace. weave.ts's recordSpend has
// guarded exactly this anomaly with `spend-record-skipped` since the patch
// round; the asymmetry between the two legs was the finding.
describe("Ultra storage — a non-finite settle cost is REPORTED, never silently dropped", () => {
  test("a NaN costUsd writes no ledger row and lands a spend-record-skipped line on the run's own log", async () => {
    const runId = "u-nan-cost";
    const script = `${META}\nexport default async function ({ agent }) {\n  await agent("a", { model: "sonnet" });\n  return "ok";\n}`;
    const fake: Fake = async (p, o) => {
      // What an upstream SDK anomaly looks like from here: a settle that
      // reports a cost field which is not a number's worth of money.
      o.onEvent?.({ type: "result", subtype: "success", costUsd: Number.NaN, turns: 1 });
      return { text: p };
    };

    const res = await launchUltra({ script, runId, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

    // Nothing billable landed — a NaN dollar is not a dollar, and the ledger is
    // right to refuse it.
    expect(ultraLinesFor(runId)).toHaveLength(0);
    // ...but the refusal is on the RUN'S OWN durable log, naming the ordinal,
    // so a human tailing the run sees money that never reached the ledger. This
    // is the whole difference between a defect and a silent one.
    const skipped = logLinesPrefixed(runId, "spend-record-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("ordinal=0");
    // The run itself is untouched: accounting is best-effort, the work is not.
    expect(getUltraManifest(runId)?.state).toBe("done");
  });
});

// ── AN UNREADABLE LEDGER IS NOT A $0 LEDGER ─────────────────────────────────
// manifest.spend is a projection, and ledgerSpendUsd answers 0 both to "no line
// was ever written for this run" (true) and to "the ledger could not be read
// right now" (meaningless). buildManifest took that 0 at face value and wrote
// it — on every agent settle AND on the once-only terminal save, which is what
// makes a transient failure a PERMANENT wrong number. weave.ts's budget read
// has consulted ledgerReadUnavailable() since the repair round; this is the
// sibling leg getting the same rule, with the difference that ultra's spend is
// a readout rather than a cap, so it holds the best figure it has instead of
// failing the run.
describe("Ultra storage — an unreadable ledger never rewrites manifest.spend to 0", () => {
  test("a resume whose ledger read fails holds the persisted figure, and says so on the run's log", async () => {
    const runId = "u-spend-read-unavailable";
    const script = `${META}\nexport default async function ({ agent }) {\n  await agent("a", { model: "sonnet" });\n  await agent("b", { model: "sonnet" });\n  return "ok";\n}`;
    const res = await launchUltra({ script, runId, agent: costedFake(3.75) });
    if (!res.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    const persisted = getUltraManifest(runId)!;
    expect(persisted.spend).toBeCloseTo(7.5);

    // Reproduce what a FRESH process meets, in-process: the port's fold cache is
    // keyed on (file, dev, ino), so ROTATING the ledger — a rename plus a new
    // file at the same path — leaves it holding no fold that describes the file
    // on disk, exactly as a process that has never read it holds none. Then deny
    // the read. Rotation rather than rm+rewrite because a rename guarantees a
    // different inode (the old one is still occupied), where a delete may hand
    // the same number straight back.
    const ledger = ledgerFile();
    const rotated = `${ledger}.rotated`;
    fs.renameSync(ledger, rotated);
    fs.copyFileSync(rotated, ledger);
    fs.chmodSync(ledger, 0o000);
    try {
      // An assertion that stops reproducing its own condition is worthless.
      expect(() => fs.readFileSync(ledger)).toThrow();
      expect(fs.statSync(ledger).ino).not.toBe(fs.statSync(rotated).ino);

      const resumed = await resumeUltraRun(runId, { agent: costedFake(3.75) });
      if (!resumed.ok) throw new Error("unreachable");
      expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

      const after = getUltraManifest(runId)!;
      // THE ASSERTION. $7.50 is the last figure anyone could actually read; 0 is
      // what an unread ledger looks like to a caller that does not ask whether
      // the read happened.
      expect(after.spend).toBeCloseTo(7.5);
      // ...and the manifest really was REWRITTEN in that window, so this is the
      // fallback holding rather than the file simply never being touched.
      expect(after.updatedAt).toBeGreaterThan(persisted.updatedAt);
      // Never silent, and one-shot per run rather than one line per settle.
      const notes = logLinesPrefixed(runId, "spend-read-unavailable");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("7.5");
    } finally {
      fs.chmodSync(ledger, 0o600);
      fs.rmSync(rotated, { force: true });
    }

    // With the ledger readable again the projection resumes on its own — the
    // fallback installed no counter. The resume was fully cache-served, so the
    // honest total is still 7.5.
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(7.5);
  });
});

// ── A KEY MUST NAME A BILLABLE EVENT, NOT A SLOT ────────────────────────────
// The two ways a resume RE-RUNS an ordinal LIVE — the human rewrote that call,
// and the `cacheValid` latch re-running every ordinal after the first miss.
// Both are genuinely re-billed by the provider, and under the (runId, ordinal)
// key both were silently folded away: the second billing's row repeats a key
// the fold has already consumed, which is indistinguishable from an honest
// re-presentation of one settle, so no total moves, no `spend-record-failed`
// event fires and no log line is written. Each test below asserts the fold
// against the total the fake runner itself reports having billed, so the
// number cannot drift into agreement with a wrong implementation.
//
// A fake that RECORDS what it bills. Only a live call ever reaches it — a
// cache-replayed ordinal never re-enters the runner — so `billed` is, by
// construction, the provider-billed truth the ledger has to match.
function billingFake(costFor: (prompt: string, call: number) => number | null) {
  const billed: number[] = [];
  let call = 0;
  const fake: Fake = async (p, o) => {
    const cost = costFor(p, ++call);
    if (cost === null) throw new Error("the provider blew up before this call settled");
    billed.push(cost);
    o.onEvent?.({ type: "result", subtype: "success", costUsd: cost, turns: 1 });
    return { text: p };
  };
  const total = () => billed.reduce((a, b) => a + b, 0);
  return { fake, billed, total };
}

describe("Ultra storage — an ordinal that RE-RUNS LIVE on a resume is billed again", () => {
  test("stop → edit → resume: the discarded call and the rewritten call are BOTH on the ledger", async () => {
    // storage.ts's own name for this is "the standard Stop → edit → resume
    // surgery". Ordinal 0 costs $1, the human rewrites exactly that call, and
    // the rewritten call costs $50. The provider billed $51 — the $1 bought a
    // result that was thrown away, but the money left the account.
    const runId = "u-key-names-the-call-edit";
    const script = `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`;
    const { fake, total } = billingFake((p) => (p === "p0" ? 1 : 50));

    const res = await launchUltra({ script, runId, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(1);

    const edited = script.replace("p0", "p0-REWRITTEN");
    const resumed = await resumeUltraRun(runId, { script: edited, agent: fake });
    if (!resumed.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

    // The journal is repaired — two records for ordinal 0, the last one the
    // rewritten call's. The ledger must be repaired the same way: the first
    // record's money did not un-spend itself when the record was superseded.
    expect(readJournal(runId).filter((r) => r.ordinal === 0).map((r) => r.costUsd)).toEqual([1, 50]);

    expect(total()).toBe(51); // what the provider actually billed
    expect(ultraLinesFor(runId).map((l) => l.costUsd)).toEqual([1, 50]);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(total());
    expect(getUltraManifest(runId)?.spend).toBeCloseTo(51);

    // …and the rewritten call is still billed exactly ONCE however many bare
    // resumes replay it (property (b), now under the new key): a replay
    // re-presents the id of the settle it replays, never a fresh one.
    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — the edited prefix should be cache-served");
    };
    for (const _ of [1, 2]) {
      const again = await resumeUltraRun(runId, { agent: throwingFake });
      if (!again.ok) throw new Error("unreachable");
      expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    }
    expect(liveCalls).toBe(0);
    // Two more rows (one re-presentation per bare resume), still exactly two
    // distinct keys, still $51 — the replays re-present, they never re-bill.
    expect(ultraLinesFor(runId)).toHaveLength(4);
    expect(new Set(ultraLinesFor(runId).map((l) => String(l.entryKey))).size).toBe(2);
    expect(foldedUltraCosts(runId)).toEqual([1, 50]);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(51);
  });

  test("retry after a failed ordinal: the ordinals the latch re-runs live are billed again", async () => {
    // NO EDIT ANYWHERE — the plainest resume there is. Ordinal 0 throws in run
    // 1 (so it is never journaled) while ordinal 1 settles live at $10. On the
    // resume ordinal 0 misses, which latches `cacheValid` false, so ordinal 1
    // re-runs LIVE too and is really re-billed — same prompt, same opts, same
    // hash as the $10 that already folded.
    const runId = "u-key-names-the-call-retry";
    const script = [
      META,
      `export default async function ({ agent }) {`,
      `  try { await agent("a", { model: "sonnet" }); } catch (e) { /* dead call, the script carries on */ }`,
      `  await agent("b", { model: "sonnet" });`,
      `  return "ok";`,
      `}`,
    ].join("\n");
    // Call 1 (ordinal 0 of run 1) throws before settling: nothing journaled,
    // nothing billed. Then "a" is $20 and "b" is $10 wherever they run.
    const { fake, billed, total } = billingFake((p, call) => (call === 1 ? null : p === "a" ? 20 : 10));

    const res = await launchUltra({ script, runId, agent: fake });
    if (!res.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    expect(readJournal(runId).map((r) => r.ordinal)).toEqual([1]); // ordinal 0 never settled
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(10);

    const resumed = await resumeUltraRun(runId, { agent: fake });
    if (!resumed.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

    // Three live calls actually reached the provider, in this order.
    expect(billed).toEqual([10, 20, 10]);
    expect(total()).toBe(40);
    // Ordinal 1 has TWO journal records now — it really ran twice.
    expect(readJournal(runId).map((r) => r.ordinal)).toEqual([1, 0, 1]);
    expect(ultraLinesFor(runId).map((l) => l.costUsd)).toEqual([10, 20, 10]);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(total());
    expect(getUltraManifest(runId)?.spend).toBeCloseTo(40);

    // The second run's settles dedupe on a third, fully-cached resume — the
    // re-billing above is charged once, not once per resume.
    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — the whole prefix should be cache-served");
    };
    const again = await resumeUltraRun(runId, { agent: throwingFake });
    if (!again.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    expect(liveCalls).toBe(0);
    // The two replayed ordinals re-record under the keys they already hold: two
    // more rows, still three distinct keys, still $40.
    expect(ultraLinesFor(runId)).toHaveLength(5);
    expect(new Set(ultraLinesFor(runId).map((l) => String(l.entryKey))).size).toBe(3);
    expect(foldedUltraCosts(runId).sort((a, b) => a - b)).toEqual([10, 10, 20]);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(40);
  });
});

// ── …AND THAT KEY IS MINTED, NEVER COUNTED ──────────────────────────────────
// The obvious way to name "which live settle of this ordinal" is to number
// them off the journal — one record per live settle, so the count IS the seq.
// It is wrong for the same reason the ordinal was: a count is a POSITION, and a
// position is only an identity while nothing disturbs the sequence. The two
// probes below disturb it in the two ways this system genuinely allows — a
// journal line skipped by the corruption tolerance journal.ts advertises, and
// two processes resuming one runId — and a counted key silently drops a real
// billing in both. Both are scored against the fake runner's own record of what
// it billed, the one number that is not an artifact of the code under test.
const singleAgentScript = (prompt: string) =>
  `${META}\nexport default async function ({ agent }) { return agent(${JSON.stringify(prompt)}, { model: "sonnet" }); }`;

describe("Ultra storage — the billing key is minted at settle time, never counted", () => {
  test("ATTACK: a journal line lost to mid-file corruption never drops a later live settle", async () => {
    const runId = "u-attack-journal-corruption";
    // ONE ordinal, three LIVE settles (edit → resume, twice): $1, $10, $200.
    // Distinct magnitudes, so a wrong total names the settle that went missing
    // rather than merely being "off".
    const { fake, total } = billingFake((p) => (p === "p0" ? 1 : p === "p0-B" ? 10 : 200));

    const first = await launchUltra({ runId, script: singleAgentScript("p0"), agent: fake });
    if (!first.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

    const second = await resumeUltraRun(runId, { script: singleAgentScript("p0-B"), agent: fake });
    if (!second.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    expect(ultraLinesFor(runId).map((l) => l.costUsd)).toEqual([1, 10]);

    // Tear the FIRST journal line mid-file — not the tail. journal.ts skips a
    // malformed line ON PURPOSE ("so one corrupt record doesn't blind resume to
    // every record after it"), so ordinal 0's record COUNT drops from 2 to 1
    // while the surviving record, and the $10 already billed against it, stay.
    // A tally that can move backwards is not an identity.
    const journalPath = path.join(runDir(runId), "journal.jsonl");
    const journalLines = fs.readFileSync(journalPath, "utf8").split("\n");
    journalLines[0] = "{ this line lost its tail to a bad sector";
    fs.writeFileSync(journalPath, journalLines.join("\n"));
    expect(readJournal(runId).map((r) => r.costUsd)).toEqual([10]); // the count regressed

    const third = await resumeUltraRun(runId, { script: singleAgentScript("p0-C"), agent: fake });
    if (!third.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

    // A COUNTED key claims `…:0:2` here — the key the $10 settle already holds
    // — so the $200 row lands looking exactly like a re-presentation of the $10
    // and the fold drops it, with no log line and no event. A MINTED key was
    // never on the ledger, so its money counts.
    expect(total()).toBe(211); // what the provider actually billed
    expect(ultraLinesFor(runId).map((l) => l.costUsd)).toEqual([1, 10, 200]);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(total());
    expect(getUltraManifest(runId)?.spend).toBeCloseTo(211);
  });

  test("ATTACK: two resumes of one runId racing on the same journal bill all three settles", async () => {
    // TWO PROCESSES, modeled honestly inside one. resumeUltraRun's "already
    // running" refusal is a PER-PROCESS registry check; a second process
    // resuming the same runId has its own registry and walks straight past it,
    // which is precisely the race resumeUltraRun's own comment names ("two
    // concurrent tasks against one journal.jsonl would race its appends").
    // launchUltra with a forced runId is the SAME start/resume code path
    // (startUltra scans whatever journal the id already has) minus that
    // process-local guard, so two of them in flight is the cross-process race:
    // both scan BEFORE either appends, so both read the same record count.
    const runId = "u-attack-concurrent-resume";
    const opened = billingFake(() => 1);
    const first = await launchUltra({ runId, script: singleAgentScript("p0"), agent: opened.fake });
    if (!first.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

    // Both racers hold at one gate until BOTH have started, so the interleaving
    // under test is forced rather than hoped for.
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const raceBilled: number[] = [];
    const racer = (cost: number): Fake => async (p, o) => {
      await gate;
      raceBilled.push(cost);
      o.onEvent?.({ type: "result", subtype: "success", costUsd: cost, turns: 1 });
      return { text: p };
    };

    const edited = singleAgentScript("p0-RESUMED");
    const a = await launchUltra({ runId, script: edited, agent: racer(50) });
    if (!a.ok) throw new Error("unreachable");
    const runA = getLiveUltraRun(runId)!;
    const b = await launchUltra({ runId, script: edited, agent: racer(50) });
    if (!b.ok) throw new Error("unreachable");
    const runB = getLiveUltraRun(runId)!;
    expect(runA).not.toBe(runB); // two independent tasks over one journal
    release();
    expect((await runA.finished).state).toBe("done");
    expect((await runB.finished).state).toBe("done");

    // Two real calls reached the provider and two were really billed. A COUNTED
    // key gives both of them `…:0:2` — two rows the fold reads as one settle
    // re-presented, $50 gone in silence. A MINTED key needs no coordination
    // between the two writers to stay distinct.
    expect(raceBilled).toEqual([50, 50]);
    const billedTotal = opened.total() + 100;
    expect(billedTotal).toBe(101);
    expect(ultraLinesFor(runId).map((l) => l.costUsd)).toEqual([1, 50, 50]);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(billedTotal);
    expect(getUltraManifest(runId)?.spend).toBeCloseTo(101);
  });

  test("each live settle mints its OWN journal id, and its ledger row carries that id verbatim", async () => {
    const runId = "u-minted-settle-id";
    const { fake } = billingFake((p) => (p === "p0" ? 3 : 5));
    const first = await launchUltra({ runId, script: singleAgentScript("p0"), agent: fake });
    if (!first.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");
    const second = await resumeUltraRun(runId, { script: singleAgentScript("p0-B"), agent: fake });
    if (!second.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

    // Two records for ONE ordinal, each with its own minted id — the id is a
    // property of the settle, never of the slot it settled in.
    const ids = readJournal(runId)
      .filter((r) => r.ordinal === 0)
      .map((r) => r.settleId);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id!))).toBe(true);
    expect(new Set(ids).size).toBe(2);
    // …and the ledger keys are those ids, in settle order — nothing derives a
    // key from the record's position in the file.
    expect(ultraLinesFor(runId).map((l) => l.entryKey)).toEqual(ids.map((id) => `ultra:${runId}:0:${id}`));
  });

  test("a journal record from before settleId existed still parses, still replays, and still dedupes", async () => {
    // The additive-field contract, from the only angle that matters for money:
    // an on-disk journal written by the older code has no id to read back, so
    // that record — and only that record — falls back to the count-derived key
    // its live settle actually wrote, and its already-billed row is not billed
    // twice. Built as the older code would have left it: a record with no
    // settleId, plus its ledger row under `ultra:<runId>:<ordinal>:<count>`.
    const runId = "u-legacy-journal-record";
    const prompt = "p-legacy";
    fs.mkdirSync(runDir(runId), { recursive: true });
    fs.appendFileSync(
      path.join(runDir(runId), "journal.jsonl"),
      JSON.stringify({
        ordinal: 0,
        hash: hashCall(prompt, { model: "sonnet" }),
        result: { text: prompt },
        costUsd: 7,
      }) + "\n",
    );
    fs.appendFileSync(
      ledgerFile(),
      JSON.stringify({
        ts: Date.now(),
        account: "personal",
        model: "sonnet",
        sessionId: "",
        costUsd: 7,
        ownerKind: "ultra",
        ownerId: runId,
        entryKey: `ultra:${runId}:0:1`,
      }) + "\n",
    );

    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — the legacy record should be cache-served");
    };
    const resumed = await resumeUltraRun(runId, { script: singleAgentScript(prompt), agent: throwingFake });
    if (!resumed.ok) throw new Error("unreachable");
    expect((await getLiveUltraRun(runId)!.finished).state).toBe("done");

    expect(liveCalls).toBe(0); // parsed, hash-matched, replayed
    // The replay re-records, as every replay does — under the key the OLD code
    // wrote, which is the whole point: two rows, ONE key, and the $7 is still
    // $7 rather than $14.
    const legacyLines = ultraLinesFor(runId);
    expect(legacyLines).toHaveLength(2);
    expect(new Set(legacyLines.map((l) => String(l.entryKey)))).toEqual(new Set([`ultra:${runId}:0:1`]));
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: runId })).toBeCloseTo(7);
  });
});
