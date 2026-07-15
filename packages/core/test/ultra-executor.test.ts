import { describe, expect, test } from "bun:test";
import type { AgentOpts, EngineEvent } from "../src/engine";
import { startUltra, RUN_CONCURRENCY, LIFETIME_BACKSTOP } from "../src/ultra/executor";

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
    const fake: Fake = async () => {
      calls++;
      return null;
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
  test("onAgentEvent receives the engine EngineEvent stream keyed by ordinal", async () => {
    const taps: Array<{ ordinal: number; e: EngineEvent }> = [];
    const fake: Fake = async (_p, o) => {
      o.onEvent?.({ type: "text", text: "hi" });
      return { text: "ok" };
    };
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { await agent("a", { model: "sonnet" }); return agent("b", { model: "sonnet" }); }`,
      { agent: fake as any, onAgentEvent: (ordinal, e) => taps.push({ ordinal, e }) },
    );
    await run.finished;
    expect(taps.map((t) => t.ordinal)).toEqual([0, 1]);
    expect(taps[0]!.e).toEqual({ type: "text", text: "hi" });
  });
});
