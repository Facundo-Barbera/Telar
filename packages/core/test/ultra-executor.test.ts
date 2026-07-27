import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentOpts, EngineEvent } from "../src/engine";
import {
  startUltra,
  resumeUltra,
  RUN_CONCURRENCY,
  LIFETIME_BACKSTOP,
  VALIDATE_RETRY_K,
  type UltraEvent,
} from "../src/ultra/executor";
import { readJournal } from "../src/ultra/journal";

// Never the real ~/.telar: every successful agent() call now journals through
// telarDir() (manifest.ts:17) — appendJournal on a live call, readJournalMap
// on every startUltra() (executor.ts). Same temp-TELAR_HOME idiom as
// ultra-resume.test.ts / looms.test.ts, re-pinned in beforeEach since bun test
// runs all files in one process.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ultra-executor-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// A fake matching `typeof agent` — the DI seam (executor.ts ExecuteOpts.run idiom).
type Fake = (prompt: string, opts: AgentOpts<any>) => Promise<any>;
const abortErr = () => {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const META = `export const meta = { name: "t", description: "d", phases: [] };`;

describe("Ultra executor — happy path + opts mapping", () => {
  test("a schema-less agent() gets a passthrough {text} schema and the run resolves `done`", async () => {
    const seen: AgentOpts<any>[] = [];
    const fake: Fake = async (_p, o) => {
      seen.push(o);
      return { text: "ok" };
    };
    const run = startUltra(`${META}\nexport default async function ({ agent }) { return agent("hi", { model: "sonnet", effort: "high" }); }`, {
      agent: fake as any,
    });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual({ text: "ok" });
    // Passthrough schema injected; model + shared abort passed; effort NOT sent to the engine.
    expect(seen[0]!.schema).toBeDefined();
    expect(seen[0]!.model).toBe("sonnet");
    expect(seen[0]!.abort).toBeInstanceOf(AbortController);
    expect("effort" in seen[0]!).toBe(false);
  });
});

describe("Ultra executor — MissingModel is a control signal, never a null result", () => {
  test("a model-less agent() ends the run `failed` without ever calling the engine", async () => {
    let called = false;
    const fake: Fake = async () => {
      called = true;
      return null;
    };
    const run = startUltra(`${META}\nexport default async function ({ agent }) { return agent("p", {}); }`, { agent: fake as any });
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("model");
    expect(called).toBe(false);
  });

  test("MissingModel thrown inside parallel() propagates past the barrier (not swallowed to null)", async () => {
    const fake: Fake = async () => ({ text: "ok" });
    const run = startUltra(
      `${META}\nexport default async function ({ agent, parallel }) { return parallel([() => agent("ok", { model: "sonnet" }), () => agent("bad", {})]); }`,
      { agent: fake as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("model");
  });
});

describe("Ultra executor — frozen surface", () => {
  test("mutating the injected surface throws (strict-mode frozen object)", async () => {
    const run = startUltra(
      `${META}\nexport default async function (s) { let threw = false; try { s.agent = null; } catch (e) { threw = true; } return { threw, stillFn: typeof s.agent === "function" }; }`,
      { agent: (async () => null) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual({ threw: true, stillFn: true });
  });
});

describe("Ultra executor — per-run concurrency cap", () => {
  test(`a burst of 9 thunks never exceeds ${RUN_CONCURRENCY} in-flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    const fake: Fake = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
      return { text: "ok" };
    };
    const run = startUltra(
      `${META}\nexport default async function ({ agent, parallel }) {\n  const thunks = [];\n  for (let i = 0; i < 9; i++) thunks.push(() => agent("p" + i, { model: "sonnet" }));\n  return parallel(thunks);\n}`,
      { agent: fake as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect((res.result as unknown[]).length).toBe(9);
    expect(peak).toBe(RUN_CONCURRENCY); // 9 > 3, so the cap is actually exercised
  });
});

describe("Ultra executor — abort → stopped", () => {
  test("Stop aborts in-flight children and the run ends `stopped`", async () => {
    let aborted = 0;
    // Fake never resolves on its own — it only settles when the shared abort fires.
    const fake: Fake = (_p, o) =>
      new Promise((_res, rej) => {
        o.abort!.signal.addEventListener(
          "abort",
          () => {
            aborted++;
            rej(abortErr());
          },
          { once: true },
        );
      });
    const run = startUltra(
      `${META}\nexport default async function ({ agent, parallel }) { return parallel([() => agent("a", { model: "sonnet" }), () => agent("b", { model: "sonnet" })]); }`,
      { agent: fake as any },
    );
    await delay(5); // let both children go in-flight
    expect(run.state()).toBe("running");
    run.stop();
    const res = await run.finished;
    expect(res.state).toBe("stopped");
    expect(aborted).toBeGreaterThan(0); // in-flight children were interrupted
  });
});

describe("Ultra executor — lifetime backstop", () => {
  test(`the ${LIFETIME_BACKSTOP + 1}th agent() throws and ends the run failed`, async () => {
    let calls = 0;
    // Must return a schema-VALID result (passthrough {text}) so each
    // script-level call succeeds on its first attempt — otherwise the U3
    // validate-and-retry loop would call the fake up to VALIDATE_RETRY_K times
    // per call, decoupling `calls` from the number of agent() invocations this
    // test means to count.
    const fake: Fake = async () => {
      calls++;
      return { text: "ok" };
    };
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { for (let i = 0; i < ${LIFETIME_BACKSTOP + 1}; i++) await agent("p", { model: "sonnet" }); return "unreached"; }`,
      { agent: fake as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("lifetime backstop");
    expect(calls).toBe(LIFETIME_BACKSTOP); // exactly the cap ran; the next was refused
  });
});

describe("Ultra executor — compile reject returns a failed run (non-blocking)", () => {
  test("a banned identifier yields a run already `failed`", async () => {
    const run = startUltra(`${META}\nexport default async function (s) { return require("fs"); }`, { agent: (async () => null) as any });
    expect(run.state()).toBe("failed");
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("require");
  });
});

describe("Ultra executor — per-ordinal transcript tap", () => {
  test("onAgentEvent receives the engine EngineEvent stream keyed by ordinal, tagged with attempt 1", async () => {
    const taps: Array<{ ordinal: number; e: EngineEvent; attempt: number }> = [];
    const fake: Fake = async (_p, o) => {
      o.onEvent?.({ type: "text", text: "hi" });
      return { text: "ok" };
    };
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { await agent("a", { model: "sonnet" }); return agent("b", { model: "sonnet" }); }`,
      { agent: fake as any, onAgentEvent: (ordinal, e, attempt) => taps.push({ ordinal, e, attempt }) },
    );
    await run.finished;
    expect(taps.map((t) => t.ordinal)).toEqual([0, 1]);
    expect(taps[0]!.e).toEqual({ type: "text", text: "hi" });
    expect(taps.map((t) => t.attempt)).toEqual([1, 1]);
  });

  // Regression: before the `attempt` tag, a retried ordinal's attempt-1 and
  // attempt-2 event streams (each with its own `result` event) landed in the
  // same ordinal bucket with no marker of where one attempt ends and the next
  // begins — a consumer treating the first `result` as terminal would render
  // the discarded, invalid attempt as the final transcript.
  test("a retried ordinal tags each attempt's events distinctly, with the surviving attempt last", async () => {
    const taps: Array<{ ordinal: number; e: EngineEvent; attempt: number }> = [];
    let calls = 0;
    const fake: Fake = async (_p, o) => {
      calls++;
      if (calls === 1) {
        o.onEvent?.({ type: "text", text: "attempt 1 text" });
        o.onEvent?.({ type: "result", subtype: "success" });
        return { text: 123 }; // wrong shape — fails schema, triggers retry
      }
      o.onEvent?.({ type: "text", text: "attempt 2 text" });
      o.onEvent?.({ type: "result", subtype: "success" });
      return { text: "ok" };
    };
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`,
      { agent: fake as any, onAgentEvent: (ordinal, e, attempt) => taps.push({ ordinal, e, attempt }) },
    );
    const res = await run.finished;
    expect(res.result).toEqual({ text: "ok" });
    expect(taps.every((t) => t.ordinal === 0)).toBe(true);
    expect(taps.map((t) => t.attempt)).toEqual([1, 1, 2, 2]);
    // Two distinct `result` events, unambiguously attributable by `attempt` —
    // the last one (attempt 2) is the one that decided the ordinal's outcome.
    const resultTaps = taps.filter((t) => t.e.type === "result");
    expect(resultTaps.map((t) => t.attempt)).toEqual([1, 2]);
  });
});

describe("Ultra executor — validate-and-retry (U3, doc §3/§7-U3)", () => {
  test("an invalid-shape result retries with the validation error appended to the original prompt, then succeeds", async () => {
    let calls = 0;
    const seenPrompts: string[] = [];
    const fake: Fake = async (p) => {
      calls++;
      seenPrompts.push(p);
      if (calls === 1) return { text: 123 }; // wrong type — fails the passthrough {text: string} schema
      return { text: "ok" };
    };
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`,
      { agent: fake as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual({ text: "ok" });
    expect(calls).toBe(2);
    expect(seenPrompts[0]).toBe("p");
    // The retry appends to the ORIGINAL prompt (never chains) and names the attempt.
    expect(seenPrompts[1]!.startsWith("p\n\n")).toBe(true);
    expect(seenPrompts[1]).toContain("retry 1/2");
  });

  test(`a result that never validates settles to null after ${VALIDATE_RETRY_K} attempts — an ordinary dead agent, not a run failure`, async () => {
    let calls = 0;
    const fake: Fake = async () => {
      calls++;
      return null; // engine's own "no emit = null" contract
    };
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { const r = await agent("p", { model: "sonnet" }); return { r }; }`,
      { agent: fake as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("done"); // exhausted retries never end the run — same as any dead agent
    expect(res.result).toEqual({ r: null });
    expect(calls).toBe(VALIDATE_RETRY_K);
  });

  test("a result that validates on the first attempt is never retried", async () => {
    let calls = 0;
    const fake: Fake = async () => {
      calls++;
      return { text: "ok" };
    };
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`,
      { agent: fake as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(calls).toBe(1);
  });
});

describe("Ultra executor — phase()/log() event emission", () => {
  test("phase/log narrator calls emit onEvent in script order, followed by the terminal state event", async () => {
    const events: UltraEvent[] = [];
    const run = startUltra(
      `${META}\nexport default async function ({ phase, log }) { phase("Phase 1"); log("hello"); phase("Phase 2"); log("world"); return "done"; }`,
      { agent: (async () => ({ text: "ok" })) as any, onEvent: (e) => events.push(e) },
    );
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(events).toEqual([
      { type: "phase", title: "Phase 1" },
      { type: "log", msg: "hello" },
      { type: "phase", title: "Phase 2" },
      { type: "log", msg: "world" },
      { type: "state", state: "done" },
    ]);
  });
});

// ── story 4.2 / AC3 + AC11 — the `agent-start` variant and `effort` ────────
describe("Ultra executor — agent-start is emitted once per LIVE ordinal, never on a cached replay (4.2)", () => {
  test("a live ordinal emits agent-start BEFORE its agent settle, carrying label/model/effort", async () => {
    const events: UltraEvent[] = [];
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("hi", { model: "sonnet", label: "scout", effort: "high" }); }`,
      { agent: (async () => ({ text: "ok" })) as any, onEvent: (e) => events.push(e) },
    );
    expect((await run.finished).state).toBe("done");

    const types = events.map((e) => e.type);
    // ORDERED, not `toContain`: the whole claim is that "begun" precedes
    // "settled". An unordered assertion cannot say it.
    expect(types).toEqual(["agent-start", "agent", "state"]);
    expect(events[0]).toEqual({
      type: "agent-start",
      ordinal: 0,
      label: "scout",
      model: "sonnet",
      effort: "high",
    });
    // It carries NO settleId, and must not: a settleId names A BILLING, minted
    // at the moment money is spent. Nothing has been spent when this fires, and
    // an id minted here would name a slot — the exact bug the settleId doc
    // records as repaired three times.
    expect("settleId" in events[0]!).toBe(false);
    // `effort` rides the settle event too, so a reader that joined the stream
    // mid-run (the anchor's SSE tail) still gets the chip.
    const settle = events[1]!;
    expect(settle.type === "agent" && settle.effort).toBe("high");
  });

  test("an agent() call with no effort emits no effort key at all — never an empty string", async () => {
    // AC11 proof 1's other direction: the rail renders `model·effort` when
    // effort is present and `model` alone when it is not, so "absent" has to be
    // genuinely absent rather than falsy.
    const events: UltraEvent[] = [];
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("hi", { model: "sonnet" }); }`,
      { agent: (async () => ({ text: "ok" })) as any, onEvent: (e) => events.push(e) },
    );
    await run.finished;
    expect(events[0]).toEqual({ type: "agent-start", ordinal: 0, model: "sonnet" });
    expect("effort" in events[0]!).toBe(false);
  });

  test("`effort` reaches the EVENT and still does not reach engineOpts — the pin, re-asserted beside the new claim", async () => {
    // The pre-existing pin (`Ultra executor — happy path + opts mapping`) is
    // re-made HERE, in the same test as the new positive claim, because the two
    // together are the actual contract: story 4.2 emits `effort` on the event,
    // NOT into the engine call. Breaking the second half changes the child
    // posture NFR-UW-4 fixes, and a pin two hundred lines away is a pin the next
    // editor of this feature will not read.
    const seen: AgentOpts<any>[] = [];
    const events: UltraEvent[] = [];
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("hi", { model: "sonnet", effort: "low" }); }`,
      {
        agent: (async (_p: string, o: AgentOpts<any>) => {
          seen.push(o);
          return { text: "ok" };
        }) as any,
        onEvent: (e) => events.push(e),
      },
    );
    await run.finished;
    expect("effort" in seen[0]!).toBe(false);
    expect(events[0]).toEqual({ type: "agent-start", ordinal: 0, model: "sonnet", effort: "low" });
  });

  test("a resume whose whole prefix is cache-served emits NO agent-start — a replay starts nothing", async () => {
    const echoFake: Fake = async (p) => ({ text: p });
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a.text, b.text];\n}`;
    const first: UltraEvent[] = [];
    const run = startUltra(script, { agent: echoFake, onEvent: (e) => first.push(e) });
    expect((await run.finished).state).toBe("done");
    expect(first.filter((e) => e.type === "agent-start").length).toBe(2);

    const replayed: UltraEvent[] = [];
    const throwingFake: Fake = async () => {
      throw new Error("must not be called — the full prefix should be cache-served");
    };
    const resumed = resumeUltra(run.runId, script, {
      agent: throwingFake,
      onEvent: (e) => replayed.push(e),
    });
    expect((await resumed.finished).state).toBe("done");
    // The cache-hit path returns EARLY, having spent nothing and started
    // nothing, so it re-emits `agent` (the rail's roster must look the same on a
    // resume as it did live) and NEVER `agent-start`.
    expect(replayed.filter((e) => e.type === "agent-start").length).toBe(0);
    expect(replayed.filter((e) => e.type === "agent").length).toBe(2);
    expect(replayed.every((e) => e.type !== "agent" || e.cached === true)).toBe(true);
  });

  test("a resume that MISSES the cache re-runs live and emits agent-start again for every re-run ordinal", async () => {
    // The anti-vacuity control for the test above: a change that simply deleted
    // the emit would pass "no agent-start on a replay" and fail here.
    const echoFake: Fake = async (p) => ({ text: p });
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a.text, b.text];\n}`;
    const run = startUltra(script, { agent: echoFake });
    await run.finished;

    // An EDITED first call misses at ordinal 0, and `cacheValid` is a one-way
    // latch, so every later ordinal re-runs live too.
    const edited = script.replace('agent("p0"', 'agent("p0-edited"');
    const replayed: UltraEvent[] = [];
    const resumed = resumeUltra(run.runId, edited, {
      agent: echoFake,
      onEvent: (e) => replayed.push(e),
    });
    expect((await resumed.finished).state).toBe("done");
    expect(replayed.filter((e) => e.type === "agent-start").map((e) => e.ordinal)).toEqual([0, 1]);
  });
});

describe("Ultra executor — pipeline() no inter-stage barrier", () => {
  test("item A can finish stage 3 while item B is still stuck in stage 1", async () => {
    const completionOrder: string[] = [];
    const fake: Fake = async (p) => {
      const isSlow = p === "B-1";
      await delay(isSlow ? 30 : 0);
      completionOrder.push(p);
      return { text: p };
    };
    const script = `${META}\nexport default async function ({ agent, pipeline }) {
      const stage1 = async (prev, item) => { await agent(item + "-1", { model: "sonnet" }); return item; };
      const stage2 = async (prev, item) => { await agent(item + "-2", { model: "sonnet" }); return item; };
      const stage3 = async (prev, item) => { await agent(item + "-3", { model: "sonnet" }); return item; };
      return pipeline(["A", "B"], stage1, stage2, stage3);
    }`;
    const run = startUltra(script, { agent: fake as any });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual(["A", "B"]);
    // A races all the way through stage 3 before B's slow stage 1 even settles
    // — proof nothing is barriering A on B clearing stage 1 first.
    expect(completionOrder.indexOf("A-3")).toBeLessThan(completionOrder.indexOf("B-1"));
  });
});

describe("Ultra executor — pipeline() drop-to-null", () => {
  test("a throwing stage drops that item to null and skips its remaining stages; other items are unaffected", async () => {
    const seenPrompts: string[] = [];
    const fake: Fake = async (p) => {
      seenPrompts.push(p);
      return { text: p };
    };
    const script = `${META}\nexport default async function ({ agent, pipeline }) {
      const stage1 = async (prev, item) => { if (item === "bad") throw new Error("boom"); return item; };
      const stage2 = async (prev, item) => { const r = await agent(item + "-stage2", { model: "sonnet" }); return r.text; };
      return pipeline(["good", "bad"], stage1, stage2);
    }`;
    const run = startUltra(script, { agent: fake as any });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual(["good-stage2", null]);
    // stage2 was never called for the dropped "bad" item.
    expect(seenPrompts).toEqual(["good-stage2"]);
  });

  test("a control signal (MissingModel) inside a stage propagates past pipeline, ending the run failed", async () => {
    const run = startUltra(
      `${META}\nexport default async function ({ agent, pipeline }) {
        const stage1 = async (prev, item) => agent(item, {});
        return pipeline(["a"], stage1);
      }`,
      { agent: (async () => ({ text: "ok" })) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("model");
  });
});

describe("Ultra executor — pipeline() journal interplay (doc §3/§7-U2+U3)", () => {
  test("every stage's agent() call journals by ordinal and replays from a full cache on resume", async () => {
    const echoFake: Fake = async (p) => ({ text: p });
    const script = `${META}\nexport default async function ({ agent, pipeline }) {
      const stage1 = async (prev, item) => { const r = await agent(item + "-1", { model: "sonnet" }); return r.text; };
      const stage2 = async (prev, item) => { const r = await agent(prev + "-2", { model: "sonnet" }); return r.text; };
      return pipeline(["x", "y"], stage1, stage2);
    }`;
    const run = startUltra(script, { agent: echoFake });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual(["x-1-2", "y-1-2"]);
    // 2 items * 2 stages = 4 script-level agent() calls, one journal record each.
    expect(readJournal(run.runId).length).toBe(4);

    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — full prefix should be cache-served");
    };
    const resumed = resumeUltra(run.runId, script, { agent: throwingFake });
    const res2 = await resumed.finished;
    expect(res2.state).toBe("done");
    expect(res2.result).toEqual(["x-1-2", "y-1-2"]);
    expect(liveCalls).toBe(0);
  });
});
