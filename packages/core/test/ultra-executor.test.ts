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
import { BadPrompt, isControlSignal } from "../src/ultra/signals";

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
  test("a schema-less agent() gets a passthrough {text} schema, and resolves to the TEXT itself", async () => {
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
    // THE WRAPPER IS INTERNAL. The engine is still asked for `{text}` (the
    // assertion on `seen[0].schema` below), but the script — and therefore the
    // run's result — sees the string. Pinning the wrapper here is what let the
    // executor and the authoring reference disagree for as long as they did.
    expect(res.result).toBe("ok");
    // Passthrough schema injected; model + shared abort passed — AND effort,
    // which this assertion used to pin as ABSENT ("effort NOT sent to the
    // engine"). That pin encoded a real limitation of the SDK this code was
    // written against, and the limitation is gone: the chat route passes
    // `effort` into the same `query()` options for every session turn. Keeping
    // the pin meant an Ultra script could name an effort, see it on the agent's
    // chip, and get a model that was never told — a control that displayed and
    // did nothing. Reversed on an owner ruling.
    expect(seen[0]!.schema).toBeDefined();
    expect(seen[0]!.model).toBe("sonnet");
    expect(seen[0]!.abort).toBeInstanceOf(AbortController);
    expect(seen[0]!.effort).toBe("high");
  });
});

describe("Ultra executor — a schema-less agent() resolves to a STRING", () => {
  // THE DIVERGENCE THIS BLOCK CLOSES. PASSTHROUGH_SCHEMA exists so the
  // validate-and-retry loop can tell "emitted nothing" from "emitted the wrong
  // shape" on a call that declared no schema. It leaked out as the script-facing
  // return type, which put the executor at odds with BOTH runner.ts's own
  // schema-less branch (returns a bare string) and the authoring reference given
  // to every session (says "the model's final text"). Authors wrote the
  // documented `${result}`, got "[object Object]", and the run died at the
  // fold-up with the whole fan-out already paid for.
  const echo: Fake = async (p) => ({ text: `saw:${p}` });

  test("the value handed to the script interpolates cleanly into the next prompt", async () => {
    const calls: string[] = [];
    const recording: Fake = async (p) => {
      calls.push(p);
      return { text: "SUMMARY" };
    };
    const run = startUltra(
      // The canonical fan-out → synthesis shape, written the way the reference
      // documents it. Before the unwrap this was the run-killing footgun.
      `${META}\nexport default async function ({ agent }) {\n  const a = await agent("scout", { model: "sonnet" });\n  return agent(\`fold: \${a}\`, { model: "sonnet" });\n}`,
      { agent: recording as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(calls).toEqual(["scout", "fold: SUMMARY"]);
    expect(res.result).toBe("SUMMARY");
  });

  test("a CACHED replay hands the script the same string a live settle did", async () => {
    // The unwrap is applied at both return points or a resume silently changes
    // the script's own data shape mid-flight — the failure a single-path fix
    // would have shipped.
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  return \`got:\${a}\`;\n}`;
    const run = startUltra(script, { agent: echo });
    expect((await run.finished).result).toBe("got:saw:p0");

    const throwing: Fake = async () => {
      throw new Error("must not be called — the prefix should be cache-served");
    };
    const resumed = resumeUltra(run.runId, script, { agent: throwing });
    const res = await resumed.finished;
    expect(res.state).toBe("done");
    expect(res.result).toBe("got:saw:p0");
  });

  test("the JOURNAL still stores the raw {text} record — unwrapping is presentation, not storage", async () => {
    // What keeps every record written before this change replayable.
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`,
      { agent: echo },
    );
    await run.finished;
    const journal = readJournal(run.runId);
    expect(journal[0]!.result).toEqual({ text: "saw:p0" });
  });

  test("a dead agent stays null — the unwrap never invents a string", async () => {
    const dead: Fake = async () => null;
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("p0", { model: "sonnet" }); }`,
      { agent: dead },
    );
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toBeNull();
  });
});

describe("Ultra executor — a THROWN agent still reports that it settled", () => {
  // THE BUG THIS PINS, measured rather than imagined. Run u-893ce7701785
  // started 10 agents and journaled 6. Ordinals 2, 6 and 7 each ended
  // `error_max_turns` with the subtype sitting in their transcripts, but the
  // journal append and the settle event both live BELOW the throw point, so
  // neither ran. `started - settled` never fell, the run reported three agents
  // in flight forever, and `dead` stayed 0 — literally true, since nothing had
  // marked a death. Hours went into diagnosing "hung agents" that were long
  // dead, using counts that could not have shown it.
  const boom: Fake = async () => {
    throw new Error("child exploded");
  };
  const script = `${META}\nexport default async function ({ agent, parallel }) {\n  const r = await parallel([() => agent("p0", { model: "sonnet" })]);\n  return r[0];\n}`;

  test("the throw emits a settle event, so in-flight accounting can fall", async () => {
    const events: UltraEvent[] = [];
    const run = startUltra(script, { agent: boom, onEvent: (e) => events.push(e) });
    await run.finished;

    const settles = events.filter((e) => e.type === "agent");
    expect(settles).toHaveLength(1);
    expect(settles[0]!.ok).toBe(false);
    expect(settles[0]!.deadReason).toBe("error");
  });

  test("but it journals NOTHING, so a resume re-runs it instead of replaying a failure", async () => {
    // The half that must NOT change. Skipping the journal on a throw is
    // deliberate — an un-journaled ordinal re-runs live on the next resume.
    // A fix that "helpfully" recorded the failure would cache it forever and
    // turn a transient explosion into a permanent one.
    const run = startUltra(script, { agent: boom });
    await run.finished;
    expect(readJournal(run.runId)).toHaveLength(0);
  });

  test("the script still sees the ordinary dead-agent null", async () => {
    const run = startUltra(script, { agent: boom });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toBeNull();
  });

  test("a BARE agent() call gets the same null — it does not fail the run (#22)", async () => {
    // The regression this pins. A bare call used to let the throw propagate out
    // of the script and fail the whole run, so one under-budgeted agent could
    // destroy a run whose other agents had already succeeded — measured on
    // u-ed1031c7b0c2. Whether a failure was survivable depended entirely on
    // whether the author had wrapped the call in parallel().
    const bare = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  return { sawNull: a === null };\n}`;
    const run = startUltra(bare, { agent: boom });
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(res.result).toEqual({ sawNull: true });
  });

  test("a control signal STILL fails the run — only agent failures became values", async () => {
    // The carve-out that must survive #22: Stop / MissingModel / the lifetime
    // backstop end the run, and coercing those to null would make a stopped run
    // look like a successful one.
    const bare = `${META}\nexport default async function ({ agent }) {\n  return agent("p0", { model: "sonnet" });\n}`;
    const aborted: Fake = async () => {
      throw abortErr();
    };
    const run = startUltra(bare, { agent: aborted });
    const res = await run.finished;
    expect(res.state).not.toBe("done");
  });

  test("a control signal is NOT reported as an agent settle", async () => {
    // Stop / MissingModel / the lifetime backstop end the RUN. They are not an
    // agent outcome, and emitting a death for them would put a phantom dead
    // agent in every stopped run's roster.
    const aborted: Fake = async () => {
      throw abortErr();
    };
    const events: UltraEvent[] = [];
    const run = startUltra(script, { agent: aborted, onEvent: (e) => events.push(e) });
    await run.finished;
    expect(events.filter((e) => e.type === "agent")).toHaveLength(0);
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

describe("Ultra executor — BadPrompt is a control signal, rejected before any ordinal or spend", () => {
  // THE DEFECT THIS BLOCK EXISTS FOR. Ultra scripts are untyped JS in a vm
  // sandbox, so interpolating a non-string into a prompt silently sends the
  // child the literal text "[object Object]": the object-ness is gone by the
  // time anything can notice, and the run burns a real billed call on a prompt
  // that says nothing. Deterministic authoring error → reject, as MissingModel does.
  //
  // NOTE WHAT IS NO LONGER IN THIS BLOCK. It used to be a schema-less agent()
  // result that tripped this, because the executor leaked PASSTHROUGH_SCHEMA's
  // `{ text }` wrapper out to the script. That leak is gone (executor.ts's
  // unwrapPassthrough) and with it the guard's most common trigger — the docs
  // no longer induce the error the guard catches. The remaining live triggers
  // are the ones below: a value the SCRIPT ITSELF built, a non-string prompt,
  // and a missing await. Pinning the unwrap that removed the fourth is the
  // "schema-less agent() resolves to a STRING" block further down.
  const seenPrompts = (calls: string[]): Fake =>
    (async (p: string) => {
      calls.push(p);
      return { text: "ok" };
    }) as Fake;

  test("a prompt carrying the '[object Object]' artifact ends the run `failed` with ZERO engine calls", async () => {
    const calls: string[] = [];
    const run = startUltra(
      // A value the SCRIPT built and forgot to unwrap — the fold-up step of a
      // fan-out, keyed by label, interpolated whole instead of by field.
      `${META}\nexport default async function ({ agent }) {\n  const a = await agent("first", { model: "sonnet" });\n  const entry = { label: "scout", body: a };\n  return agent(\`summary: \${entry}\`, { model: "sonnet" });\n}`,
      { agent: seenPrompts(calls) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("BadPrompt");
    expect(res.error).toContain("[object Object]");
    // The message names the LIKELY CAUSE, not just the symptom.
    expect(res.error).toContain("read the field you want");
    // The first (legitimate) call ran; the artifact call never reached the engine.
    expect(calls).toEqual(["first"]);
  });

  test("a NON-STRING prompt is rejected the same way", async () => {
    const calls: string[] = [];
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent({ text: "x" }, { model: "sonnet" }); }`,
      { agent: seenPrompts(calls) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("BadPrompt");
    expect(calls).toEqual([]);
  });

  test("'[object Promise]' — the same bug one step earlier (a missing await) — is rejected too", async () => {
    const calls: string[] = [];
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) {\n  const p = agent("first", { model: "sonnet" });\n  return agent(\`about: \${p}\`, { model: "sonnet" });\n}`,
      { agent: seenPrompts(calls) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("[object Promise]");
  });

  test("NO ordinal was issued and no journal record was written — the 'before any spend' half", async () => {
    // THIS is what distinguishes a rejection from a dead-agent null. A null
    // settles an ordinal, journals it, and (on a real runner) has already been
    // billed. A BadPrompt never gets that far, so the journal for the whole run
    // holds only the calls that genuinely ran.
    const runId = "u-badprompt-journal";
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) {\n  await agent("first", { model: "sonnet" });\n  return agent("x [object Object] y", { model: "sonnet" });\n}`,
      { runId, agent: (async () => ({ text: "ok" })) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    const journal = readJournal(runId);
    expect(journal.map((r) => r.ordinal)).toEqual([0]); // ordinal 1 was never issued
  });

  test("BadPrompt thrown inside parallel() propagates past the barrier (not swallowed to null)", async () => {
    const run = startUltra(
      `${META}\nexport default async function ({ agent, parallel }) { return parallel([() => agent("ok", { model: "sonnet" }), () => agent("bad [object Object]", { model: "sonnet" })]); }`,
      { agent: (async () => ({ text: "ok" })) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(res.error).toContain("BadPrompt");
  });

  test("the SCHEMA-LESS path is covered by the same guard (NFR-UW-6)", async () => {
    // The guard sits ABOVE `schema = uOpts.schema ?? PASSTHROUGH_SCHEMA`, so
    // there is one check rather than two copies. A call passing no schema at all
    // still rejects.
    const calls: string[] = [];
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("[object Object]", { model: "sonnet" }); }`,
      { agent: seenPrompts(calls) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("failed");
    expect(calls).toEqual([]);
  });

  test("the documented escape lets a legitimate quote through", async () => {
    // The REAL false positive is a synthesis prompt embedding an upstream
    // agent's own text that happens to quote a log line containing the
    // artifact — and it fires AFTER the fan-out is paid for. Explicit opt-out,
    // MissingModel's posture, rather than a clever guard that tries to tell
    // quoted text from interpolated text.
    const calls: string[] = [];
    const run = startUltra(
      `${META}\nexport default async function ({ agent }) { return agent("the log said [object Object]", { model: "sonnet", allowStringifiedObject: true }); }`,
      { agent: seenPrompts(calls) as any },
    );
    const res = await run.finished;
    expect(res.state).toBe("done");
    expect(calls).toEqual(["the log said [object Object]"]);
  });

  test("isControlSignal(new BadPrompt(...)) is true", () => {
    expect(isControlSignal(new BadPrompt("a thing", "lbl"))).toBe(true);
    expect(new BadPrompt("a thing", "lbl").message).toContain('agent "lbl"');
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
    expect(res.result).toBe("ok"); // schema-less → the text itself (unwrapPassthrough)
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
    expect(res.result).toBe("ok"); // schema-less → the text itself (unwrapPassthrough)
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

  test("`effort` reaches BOTH the event and engineOpts — the display and the model agree", async () => {
    // THIS TEST REVERSED. It used to assert `effort` reached the EVENT and
    // deliberately NOT `engineOpts`, on the reasoning that the SDK had no
    // reasoning-effort field. It has one, and the chat route has been passing it
    // for every session turn, so the old contract meant the chip and the model
    // could disagree: the row said `sonnet·high` and the child ran at the
    // SDK default. Both halves are asserted together for the same reason the
    // original kept them together — the contract is that what is DISPLAYED is
    // what was REQUESTED, and splitting the assertions is how the two drift.
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
    expect(seen[0]!.effort).toBe("low");
    expect(events[0]).toEqual({ type: "agent-start", ordinal: 0, model: "sonnet", effort: "low" });
  });

  test("a resume whose whole prefix is cache-served emits NO agent-start — a replay starts nothing", async () => {
    const echoFake: Fake = async (p) => ({ text: p });
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a, b];\n}`;
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
    const script = `${META}\nexport default async function ({ agent }) {\n  const a = await agent("p0", { model: "sonnet" });\n  const b = await agent("p1", { model: "sonnet" });\n  return [a, b];\n}`;
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
      const stage2 = async (prev, item) => { const r = await agent(item + "-stage2", { model: "sonnet" }); return r; };
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
      const stage1 = async (prev, item) => { const r = await agent(item + "-1", { model: "sonnet" }); return r; };
      const stage2 = async (prev, item) => { const r = await agent(prev + "-2", { model: "sonnet" }); return r; };
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

// A CHILD THAT RUNS OUT OF TURNS IS NOT A CHILD THAT FAILED, and until this
// block the two were the same value. engine.agent() returns `null` for every
// non-emitting outcome, so the executor could not tell "ran out of room" from
// "crashed" — it retried the exhausted one at the SAME budget (the one retry
// that structurally cannot work) and then settled an anonymous dead agent.
//
// It matters because a child holds Write/Edit/Bash: one that stopped on the
// turn limit may already have changed files, so the script folding a plain
// `null` is folding "nothing happened" into a half-edited repo.
describe("Ultra executor — a turn-exhausted child settles once, and says so", () => {
  // The SDK reports the reason on the result EVENT, never in the return value.
  const exhausted = (calls: { n: number }): Fake =>
    (async (_p: string, o: AgentOpts<any>) => {
      calls.n++;
      o.onEvent?.({ type: "result", subtype: "error_max_turns", turns: 200 } as never);
      return null;
    }) as Fake;

  const script = `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`;

  test("it is NOT retried at the same budget — one engine call, not VALIDATE_RETRY_K", async () => {
    const calls = { n: 0 };
    const run = startUltra(script, { agent: exhausted(calls) });
    const res = await run.finished;
    expect(res.state).toBe("done"); // a dead agent, never a run failure
    expect(res.result).toBeNull();
    expect(calls.n).toBe(1);
    expect(VALIDATE_RETRY_K).toBeGreaterThan(1); // anti-vacuity: 1 is a real saving
  });

  test("an ordinary null STILL retries — the skip is scoped to exhaustion", async () => {
    // The control for the test above: a change that simply stopped retrying
    // everything would pass that one and fail here.
    const calls = { n: 0 };
    const silent: Fake = (async () => {
      calls.n++;
      return null;
    }) as Fake;
    await startUltra(script, { agent: silent }).finished;
    expect(calls.n).toBe(VALIDATE_RETRY_K);
  });

  test("the agent event carries deadReason, so the rail can say WHY", async () => {
    const events: UltraEvent[] = [];
    await startUltra(script, { agent: exhausted({ n: 0 }), onEvent: (e) => events.push(e) })
      .finished;
    const settled = events.find((e) => e.type === "agent");
    expect(settled).toBeDefined();
    expect(settled!.ok).toBe(false);
    expect(settled!.deadReason).toBe("max-turns");
  });

  test("an ordinary dead agent has NO deadReason — absent still means cause-unknown", async () => {
    const events: UltraEvent[] = [];
    const silent: Fake = (async () => null) as Fake;
    await startUltra(script, { agent: silent, onEvent: (e) => events.push(e) }).finished;
    expect(events.find((e) => e.type === "agent")!.deadReason).toBeUndefined();
  });

  test("the JOURNAL records it, and a RESUME re-presents it", async () => {
    // A replay spends nothing and never re-learns the reason, so it has to come
    // off disk — otherwise a resumed run silently downgrades "hit the turn
    // limit" back to an anonymous failure.
    const run = startUltra(script, { agent: exhausted({ n: 0 }) });
    await run.finished;
    expect(readJournal(run.runId)[0]!.deadReason).toBe("max-turns");

    const replayed: UltraEvent[] = [];
    const throwing: Fake = (async () => {
      throw new Error("must not be called — the settle should be cache-served");
    }) as Fake;
    await resumeUltra(run.runId, script, { agent: throwing, onEvent: (e) => replayed.push(e) })
      .finished;
    const cached = replayed.find((e) => e.type === "agent");
    expect(cached!.cached).toBe(true);
    expect(cached!.deadReason).toBe("max-turns");
  });
});

describe("Ultra executor — the script sets maxTurns per agent", () => {
  test("opts.maxTurns reaches the runner; omitting it leaves the runner's default", async () => {
    // The one shape knob the script could not reach: a one-sentence reader and
    // a multi-file refactor were given the same budget.
    const seen: AgentOpts<any>[] = [];
    const fake: Fake = async (_p, o) => {
      seen.push(o);
      return { text: "ok" };
    };
    await startUltra(
      `${META}\nexport default async function ({ agent }) {\n  await agent("big", { model: "sonnet", maxTurns: 400 });\n  return agent("small", { model: "sonnet" });\n}`,
      { agent: fake },
    ).finished;
    expect(seen[0]!.maxTurns).toBe(400);
    // Absent, not defaulted here — the runner owns the default, and an explicit
    // `undefined` would be a field the SDK still sees.
    expect(seen[1]!.maxTurns).toBeUndefined();
  });
});
