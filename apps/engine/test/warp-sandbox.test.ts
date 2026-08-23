/**
 * WHAT A WARP SCRIPT IS ALLOWED TO BE, decided before anything is spent.
 *
 * Every rejection here is free and synchronous, which is the point: a script
 * that cannot work should be refused before a runId exists, not discovered at
 * agent 40 of 60 with the first 39 already paid for. And the refusal goes back
 * to the AUTHORING AGENT in a shape it can act on — kind, detail, line — rather
 * than to the user as a stack trace.
 */
import { expect, test } from "bun:test";
import { compileWarpScript } from "../src/warp/sandbox";
import type { WarpSurface } from "../src/warp/surface";

/** A surface that records what a script asked for, so a test can assert on the
 *  calls rather than on a mock's internals. */
function recordingSurface(answers: unknown[] = []) {
  const calls: Array<{ prompt: string; opts?: unknown }> = [];
  const phases: string[] = [];
  const logs: string[] = [];
  let next = 0;
  const surface: WarpSurface = {
    agent: async (prompt, opts) => {
      calls.push({ prompt, ...(opts ? { opts } : {}) });
      return answers[next++] ?? `answer ${calls.length}`;
    },
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items, ...stages) => {
      const out: unknown[] = [];
      for (const [index, item] of items.entries()) {
        let carried: unknown = item;
        for (const stage of stages) carried = await (stage as (a: unknown, b: unknown, c: number) => unknown)(carried, item, index);
        out.push(carried);
      }
      return out;
    },
    phase: (title) => phases.push(title),
    log: (message) => logs.push(message),
    args: undefined,
  };
  return { surface, calls, phases, logs };
}

const META = `export const meta = { name: "demo", description: "a demo" };\n`;

test("a script is a body: top-level await and top-level return both work", async () => {
  /**
   * THE AUTHORING SHAPE, and the departure from the legacy that matters most.
   * The frozen app took `export default async function (surface) {}` and passed
   * the surface as an argument. Every example an agent has actually read writes
   * statements at the top level and calls `agent()` bare, so that is what this
   * accepts — an authoring surface that fights the author's prior costs a round
   * trip per script.
   */
  const compiled = compileWarpScript(`${META}
    phase("Scan");
    const first = await agent("look at the logs");
    log("found something");
    return { first, done: true };
  `);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;

  const { surface, calls, phases, logs } = recordingSurface(["a finding"]);
  expect(await compiled.run(surface)).toEqual({ first: "a finding", done: true });
  expect(calls).toEqual([{ prompt: "look at the logs" }]);
  expect(phases).toEqual(["Scan"]);
  expect(logs).toEqual(["found something"]);
});

test("meta is read without running the script", () => {
  // It names the run and draws the progress tree, both of which have to happen
  // before the first agent starts — so a `meta` that had to be executed to be
  // read would be useless.
  const compiled = compileWarpScript(`export const meta = {
      name: "review",
      description: "review the diff",
      phases: [{ title: "Find" }, { title: "Verify", detail: "adversarially" }],
    };
    await agent("this never runs");
  `);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  expect(compiled.meta.name).toBe("review");
  expect(compiled.meta.phases).toHaveLength(2);
  expect(compiled.meta.phases?.[1]).toEqual({ title: "Verify", detail: "adversarially" });
});

test("the determinism bans throw, which is what makes resume possible", async () => {
  /**
   * NOT HYGIENE — LOAD-BEARING. Replaying a run's settled prefix has to take the
   * same control flow, and a script that branched on the clock would take a
   * different path on the second pass and silently re-run work already paid for.
   */
  const compiled = compileWarpScript(`${META}
    return typeof globalThis;
  `);
  expect(compiled.ok).toBe(true);

  // Reached through a name the lint cannot see, so this proves the CONTEXT bans
  // it rather than the regex.
  for (const [expression, banned] of [
    ["const d = globalThis['Da' + 'te']; return d.now();", "Date.now"],
    ["const d = globalThis['Da' + 'te']; return new d();", "Date"],
    ["return Math['rand' + 'om']();", "Math.random"],
  ] as const) {
    const script = compileWarpScript(`${META}\n${expression}`);
    expect(script.ok).toBe(true);
    if (!script.ok) continue;
    await expect(script.run(recordingSurface().surface)).rejects.toThrow(banned);
  }

  // The rest of Math survives — banning `random` must not cost arithmetic.
  const math = compileWarpScript(`${META}\nreturn Math.max(2, 40) + Math.floor(0.9);`);
  expect(math.ok).toBe(true);
  if (math.ok) expect(await math.run(recordingSurface().surface)).toBe(40);
});

test("banned identifiers are refused before anything runs, with a line number", () => {
  for (const [source, id] of [
    [`${META}const fs = require("node:fs");`, "require"],
    [`${META}return process.env.HOME;`, "process"],
    [`${META}return Date.now();`, "Date"],
    [`${META}return Math.random();`, "Math.random"],
  ] as const) {
    const rejected = compileWarpScript(source);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) continue;
    expect(rejected.kind).toBe("banned-identifier");
    expect(rejected.detail).toBe(id);
    expect(rejected.line).toBe(2);
  }
});

test("a comment or a string mentioning a banned name is not reaching for it", () => {
  /**
   * The lint reads code, not prose. Rejecting a script whose COMMENT says
   * "process" would teach authors to stop writing comments, which is a worse
   * outcome than the hygiene it buys — and this harness's whole house style is
   * comments that explain themselves.
   */
  const compiled = compileWarpScript(`${META}
    // We deliberately do not touch process or Date here.
    /* Math.random would break resume. */
    const note = "require('fs') is banned";
    log(note);
    return note;
  `);
  expect(compiled.ok).toBe(true);
});

test("meta must be present, complete, and a pure literal", () => {
  const missing = compileWarpScript(`await agent("no meta");`);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.kind).toBe("no-meta");

  // A literal that has to be EXECUTED to be read cannot be read before the run.
  const computed = compileWarpScript(`const n = "x";\nexport const meta = { name: n, description: "d" };\n`);
  expect(computed.ok).toBe(false);
  if (!computed.ok) expect(computed.kind).toBe("meta-not-literal");

  const incomplete = compileWarpScript(`export const meta = { name: "only" };\n`);
  expect(incomplete.ok).toBe(false);
  if (!incomplete.ok) {
    expect(incomplete.kind).toBe("meta-incomplete");
    expect(incomplete.detail).toBe("description");
  }
});

test("a syntax error is caught at compile time and named by line", () => {
  const broken = compileWarpScript(`${META}\nconst x = ;\n`);
  expect(broken.ok).toBe(false);
  if (!broken.ok) expect(broken.kind).toBe("compile-error");
});

test("a brace inside a meta string does not end the literal early", () => {
  // Found by writing one: the extractor is brace-counting, so it has to be
  // string-aware or a description containing `}` truncates the object.
  const compiled = compileWarpScript(`export const meta = { name: "n", description: "closes } here" };\nreturn 1;`);
  expect(compiled.ok).toBe(true);
  if (compiled.ok) expect(compiled.meta.description).toBe("closes } here");
});

test("two runs of one script do not share a context", async () => {
  // Concurrent runs of the same script must not see each other's state — the
  // phase a second run opens must not land rows from the first in its box.
  const compiled = compileWarpScript(`${META}\nglobalThis.seen = (globalThis.seen ?? 0) + 1;\nreturn globalThis.seen;`);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  expect(await compiled.run(recordingSurface().surface)).toBe(1);
  expect(await compiled.run(recordingSurface().surface)).toBe(1);
});

test("the script cannot reach the host: no require, no import, no fs", async () => {
  // Absent rather than fenced. The header is honest that vm is not a security
  // boundary; what this pins is that an authoring SLIP is a ReferenceError at
  // the point of the mistake, not a surprise at agent 40 of 60.
  const compiled = compileWarpScript(`${META}\nreturn typeof globalThis["requi" + "re"] + "," + typeof globalThis["proc" + "ess"];`);
  expect(compiled.ok).toBe(true);
  if (compiled.ok) expect(await compiled.run(recordingSurface().surface)).toBe("undefined,undefined");
});

test("agent options reach the surface verbatim", async () => {
  // Including `schema`, which is what makes a fan-out composable: the stage
  // between two agents is ordinary code rather than another agent hired to read
  // the last one's paragraphs.
  const compiled = compileWarpScript(`${META}
    const found = await agent("find bugs", { model: "claude-opus-5", effort: "high", schema: { type: "object" }, phase: "Find" });
    return found;
  `);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const { surface, calls } = recordingSurface([{ bugs: [] }]);
  expect(await compiled.run(surface)).toEqual({ bugs: [] });
  expect(calls[0]?.opts).toEqual({ model: "claude-opus-5", effort: "high", schema: { type: "object" }, phase: "Find" });
});

test("a model-less agent call is allowed, and inherits the session's model", async () => {
  /**
   * THE DEPARTURE FROM THE LEGACY, pinned so it is a decision rather than a
   * regression. The frozen app REQUIRED `model` on every call and rejected a
   * model-less script statically. Telar's own older rule is the opposite:
   * `DriverRun.model` documents that ABSENT means "the provider's own default",
   * because a layer that substituted a name would silently override whatever the
   * user actually chose. Ultracode — the harness the authoring agent has read —
   * agrees: omit it and inherit.
   */
  const compiled = compileWarpScript(`${META}\nreturn await agent("no model named");`);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const { surface, calls } = recordingSurface(["fine"]);
  expect(await compiled.run(surface)).toBe("fine");
  expect(calls[0]).toEqual({ prompt: "no model named" });
});
