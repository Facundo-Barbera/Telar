// Cut U2 — journal + ordinal resume (docs/plans/ultra-harness.md §3/§7-U2).
// Temp TELAR_HOME (never the real ~/.telar), a fake agent() runner (DI seam,
// no live SDK). Pins: full-cache replay makes zero live calls; an edited call
// N invalidates N..end but NOT 0..N-1 (prefix cache, not per-call cache);
// parallel() ordinals key by ISSUE order (deterministic) not completion order,
// and that stability survives a resume; a partial journal (simulated "process
// death" via Stop, doc §3's stated equivalence) resumes the live tail only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentOpts } from "../src/engine";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ultra-resume-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin before every test (looms.test.ts idiom).
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { startUltra, resumeUltra, readJournal, appendJournal, runDir } = await import("../src/ultra");

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
const echoFake: Fake = async (p) => ({ text: p });

describe("Ultra resume — full-cache prefix replay runs zero live calls", () => {
  const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a, b];\n}`;

  test("first run journals both calls; resume with a throwing fake still succeeds untouched", async () => {
    const run = startUltra(script, { agent: echoFake });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual(["p0", "p1"]);
    expect(readJournal(run.runId).length).toBe(2);

    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — full prefix should be cache-served");
    };
    const resumed = resumeUltra(run.runId, script, { agent: throwingFake });
    const res2 = await resumed.finished;
    expect(res2.state).toBe("done");
    expect(res2.result).toEqual(["p0", "p1"]);
    expect(liveCalls).toBe(0);
  });
});

describe("Ultra resume — an edited call invalidates it AND every later ordinal, not the prefix before it", () => {
  test("editing ordinal 1 re-runs ordinals 1 and 2 live; ordinal 0 stays cache-served", async () => {
    const original = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  const c = await agent("p2", { model: "sonnet" });\n  return [a, b, c];\n}`;
    const run = startUltra(original, { agent: echoFake });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(readJournal(run.runId).length).toBe(3);

    // Only the SECOND call's prompt changes; the third is byte-identical to
    // the original run yet must still run live (prefix invalidation, not a
    // per-call cache lookup).
    const edited = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1-EDITED", { model: "sonnet" });\n  const c = await agent("p2", { model: "sonnet" });\n  return [a, b, c];\n}`;
    const seenPrompts: string[] = [];
    const trackingFake: Fake = async (p) => {
      seenPrompts.push(p);
      return { text: p };
    };
    const resumed = resumeUltra(run.runId, edited, { agent: trackingFake });
    const res2 = await resumed.finished;
    expect(res2.state).toBe("done");
    expect(res2.result).toEqual(["p0", "p1-EDITED", "p2"]);
    // p0 never re-runs live; p1-EDITED and p2 both do, in issue order.
    expect(seenPrompts).toEqual(["p1-EDITED", "p2"]);
  });
});

describe("Ultra resume — parallel() ordinals key by issue order, stable across a resume", () => {
  test("ordinal 0/1/2 match issue order (a,b,c) even though completion order is reversed (c,b,a)", async () => {
    const script = `${META}\nexport default async function ({ agent, parallel }) {\n  return parallel([\n    () => agent("a", { model: "sonnet" }),\n    () => agent("b", { model: "sonnet" }),\n    () => agent("c", { model: "sonnet" }),\n  ]);\n}`;
    const reorderingFake: Fake = async (p) => {
      // "a" is issued first but finishes LAST; "c" is issued last but finishes FIRST.
      const ms = p === "a" ? 30 : p === "b" ? 15 : 0;
      await delay(ms);
      return { text: p };
    };
    const run = startUltra(script, { agent: reorderingFake });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual(["a", "b", "c"]); // Promise.all preserves input order regardless

    const byOrdinal = new Map(readJournal(run.runId).map((r) => [r.ordinal, r]));
    expect(byOrdinal.get(0)!.result).toEqual({ text: "a" }); // issued first → ordinal 0, despite finishing last
    expect(byOrdinal.get(1)!.result).toEqual({ text: "b" });
    expect(byOrdinal.get(2)!.result).toEqual({ text: "c" }); // issued last → ordinal 2, despite finishing first

    let liveCalls = 0;
    const throwingFake: Fake = async () => {
      liveCalls++;
      throw new Error("must not be called — full prefix should be cache-served");
    };
    const resumed = resumeUltra(run.runId, script, { agent: throwingFake });
    const res2 = await resumed.finished;
    expect(res2.state).toBe("done");
    expect(res2.result).toEqual(["a", "b", "c"]);
    expect(liveCalls).toBe(0);
  });
});

describe("Ultra resume — a partial journal (simulated process death) resumes only the live tail", () => {
  test("Stop mid-run (doc §3: Stop and server death land in the same `stopped` state) leaves one journaled call; resume replays it and finishes the rest live", async () => {
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a, b];\n}`;
    // p0 resolves quickly; p1 hangs until the shared AbortController fires —
    // standing in for "the process died while p1 was in flight".
    const hangingFake: Fake = async (p, o) => {
      if (p === "p0") return { text: "p0" };
      return new Promise((_res, rej) => {
        o.abort!.signal.addEventListener("abort", () => rej(abortErr()), { once: true });
      });
    };
    const run = startUltra(script, { agent: hangingFake });
    await delay(20); // let ordinal 0 settle+journal and ordinal 1 go in-flight (hung)
    expect(readJournal(run.runId).length).toBe(1);
    run.stop();
    const res = await run.finished;
    expect(res.state).toBe("stopped");
    expect(readJournal(run.runId).length).toBe(1); // journal prefix kept, not corrupted by the abort

    const seenPrompts: string[] = [];
    const freshFake: Fake = async (p) => {
      seenPrompts.push(p);
      return { text: `live-${p}` };
    };
    const resumed = resumeUltra(run.runId, script, { agent: freshFake });
    const res2 = await resumed.finished;
    expect(res2.state).toBe("done");
    expect(res2.result).toEqual(["p0", "live-p1"]);
    expect(seenPrompts).toEqual(["p1"]); // p0 served from the journal, never re-issued live
  });
});

describe("Ultra journal storage — corruption tolerance + id guard (doc §3/§5)", () => {
  test("a torn trailing line (crash mid-append) is dropped; earlier complete records survive", () => {
    const runId = "u-corrupt-test";
    appendJournal(runId, { ordinal: 0, hash: "h0", result: { text: "ok" } });
    // Simulate a crash mid-write: append a line with no trailing newline.
    fs.appendFileSync(path.join(runDir(runId), "journal.jsonl"), `{"ordinal":1,"hash":"h1","resul`);
    const recs = readJournal(runId);
    expect(recs).toEqual([{ ordinal: 0, hash: "h0", result: { text: "ok" } }]);
  });

  test("a hostile runId is rejected rather than escaping the ultra/ dir", () => {
    expect(() => runDir("../../etc")).toThrow(/invalid ultra runId/);
  });
});
