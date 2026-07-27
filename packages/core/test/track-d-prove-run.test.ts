// THE TRACK D PROVE-RUN — story 4.2's engine-and-projection spine, executed.
//
// WHAT THIS IS. Not "each new function has a unit test". ONE SCRIPTED RUN, in
// ONE process, under ONE sandboxed state root, in which the pieces story 4.2
// added to the engine actually serve the consumer they were added for — and the
// real ~/.telar is untouched throughout. Modelled on
// `packages/core/test/track-a-prove-run.test.ts`, including its sandbox idiom,
// its transcript line and its real-home fingerprint.
//
// The whole run is one command, from the repo root:
//
//     TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-d prove-run"
//
// WHY THE `packages/core` PATH ARGUMENT IS THERE, and it is not decoration.
// Track A's header states the measured reason: `apps/web` suites install a
// PROCESS-GLOBAL `mock.module("@telar/core", …)` at MODULE SCOPE and restore it
// only in `afterAll`, and a repo-root run WITH a `-t` filter evaluates every
// file's module scope before running any test — so those `afterAll` hooks never
// fire and the stub is live inside every core suite in the process. Track A also
// measured that `apps/web/lib/ultra-mcp.test.ts` — the file story 4.2 EDITS —
// installs the same process-global mock with the same hygiene defect but stubs
// no loom writer, so it does not reproduce Track A's particular symptom. THAT IS
// NOT A REASON TO DROP THE ARGUMENT. It is the file this story just extended,
// and the next stub someone adds to it changes the answer.
//
// (The suite pins its own `mkdtemp`'d root regardless — the TELAR_HOME on that
// command line is belt-and-braces, and the pin is what makes the run safe when
// someone forgets it.)
//
// THE LEGS, AND THEIR HONEST SCOPE, because an over-claimed prove-run is worse
// than a silent one:
//   L1  a run is born and narrates: phase → agent-start → agent → state, in
//       order, on events.ndjson
//   L2  AN IN-FLIGHT AGENT IS VISIBLE — `listUltraAgentOrdinals` reports an
//       ordinal that has emitted and NOT settled, while the run is live. THIS IS
//       THE ONE LEG THAT PROVES §5.5-D6 LANDED RATHER THAN MERELY COMPILED, and
//       it is the reason this story touched the executor at all.
//   L3  the captured stream is serialisable and complete — every variant
//       present, ordered, deduped by ordinal
//   L4  the session filter answers: filtered returns exactly this run,
//       unfiltered returns a superset
//   L5  stop and resume keep the journal: a resumed ordinal replays `cached:
//       true` and the ordinal set does not double
//   L6  the ledger and the manifest agree: `manifest.spend` equals the
//       first-occurrence-per-`entryKey` fold over the sandboxed `usage.ndjson`
//   L7  the real telar home is untouched throughout
//
// WHAT IT DELIBERATELY DOES NOT PROVE, said out loud: it drives no browser and
// renders nothing, so it proves NOTHING about the anchor's height, the narrator
// window's layout stability, the composer chip, or the dock signal. Those are
// the dev-server proof's, and story 4.2 §6.2 says which claims live where.
//
// AND L3's OTHER HALF LIVES IN `apps/web/lib/ultra-runs.test.ts`, NOT HERE, and
// saying so is the honest scope line: `packages/core` importing from `apps/web`
// is an edge that exists nowhere in this tree. The core half asserts the STREAM
// is complete and ordered; the web half replays the same shapes through
// `runSnapshot` / `phaseGroups` / `agentRows` / `narratorLines` and asserts the
// anchor payload — including that `agentsTotal` is `undefined` and that a `meta`
// without `phases` yields no sliver.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentOpts } from "../src/engine";

// ── the sandbox ─────────────────────────────────────────────────────────────
// House idiom: mkdtemp a root, pin it BEFORE importing anything that could
// resolve it, RESTORE the original in afterAll rather than deleting it — bun
// runs every file in one process, so a suite that re-points TELAR_HOME and does
// not put it back silently re-roots every suite that runs after it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "telar-track-d-prove-run-"));
const ORIGINAL_HOME = process.env.TELAR_HOME;
process.env.TELAR_HOME = HOME;

// L7's fingerprint, taken BEFORE any leg runs: a bounded, read-only snapshot of
// the REAL ~/.telar. It never creates the directory, never stats it into
// existence, and never deletes anything. Note what it does NOT do: it does not
// assert the directory is absent. ~/.telar EXISTS on this machine — story 1.1's
// verification agent ran an ad-hoc probe OUTSIDE the harness, where NODE_ENV is
// not "test" so `logUsage`'s write-guard correctly did not fire, and a synthetic
// billing line landed on the home default. That is the operator's to clean up,
// not this suite's, and an "it does not exist" assertion would be the wrong
// claim even where it passed.
const REAL_TELAR = path.join(os.homedir(), ".telar");
function realTelarSnapshot(): { exists: boolean; entries: string[] } {
  try {
    const entries = fs
      .readdirSync(REAL_TELAR)
      .map((name) => {
        try {
          const st = fs.statSync(path.join(REAL_TELAR, name));
          return `${name} ${st.isDirectory() ? "dir" : String(st.size)}`;
        } catch {
          return `${name} <unstattable>`;
        }
      })
      .sort();
    return { exists: true, entries };
  } catch {
    // ENOENT (and any other read failure) → "nothing observable here". Never
    // mkdir, never create it in order to check it: a probe that creates the
    // directory to inspect it IS the failure mode.
    return { exists: false, entries: [] };
  }
}
const REAL_TELAR_BEFORE = realTelarSnapshot();

// Pinned BEFORE these imports: static imports are hoisted and evaluated first,
// so a module that captured the root at evaluation time would capture the wrong
// one.
const {
  launchUltra,
  resumeUltraRun,
  stopUltraRun,
  getUltraManifest,
  getLiveUltraRun,
  listUltraRuns,
  listUltraAgentOrdinals,
  readUltraEvents,
} = await import("../src/ultra");
// THE LEDGER IS READ THROUGH ITS PORT, NEVER BY PATH. project-context.md fixes
// exactly one writer (`logUsage`) and one reader path (usage-ledger.ts's
// projections) for `usage.ndjson`, and "no module opens it by path" includes
// this one — a second reader is the exact failure FR-RF-2 exists to end.
const { ledgerSpendUsd, ultraCostBySession } = await import("../src/usage-ledger");

// Set by L1 and read by L3/L6. Bun runs a file's tests in DECLARATION ORDER, so
// L1 has always run by then; threading one leg's artifact into the next is what
// makes these legs a RUN rather than a set of independent tests.
let L1_RUN_ID = "";

beforeEach(() => {
  process.env.TELAR_HOME = HOME;
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

// One line per leg, stable prefix. This IS the artifact the story's dev-proof
// section calls the scripted run's transcript.
const transcript = (leg: string, what: string) => console.log(`[track-d] ${leg} ${what}`);

type Fake = (prompt: string, opts: AgentOpts<never>) => Promise<unknown>;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The engine's own abort shape — `executor.ts`'s control-signal carve-out
 *  re-throws an AbortError rather than folding it to a null result, which is
 *  what turns a Stop into a `stopped` terminal instead of a dead agent. */
const abortErr = () => {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
};

const META = `export const meta = { name: "track-d", description: "the prove-run's script", phases: ["Scan", "Rank"] };`;

// A two-phase, two-agent script — the smallest shape that exercises phase
// grouping, ordinal ordering and the narrator at once.
const SCRIPT =
  `${META}\n` +
  `export default async function ({ agent, phase, log }) {\n` +
  `  phase("Scan");\n` +
  `  const a = await agent("p0", { model: "sonnet", label: "scout", effort: "high" });\n` +
  `  log("scan done");\n` +
  `  phase("Rank");\n` +
  `  const b = await agent("p1", { model: "opus", label: "ranker" });\n` +
  `  return [a, b];\n` +
  `}`;

/** A fake that streams one engine event (which is what creates the ordinal's
 *  transcript file) and reports a cost, like the real runner does. */
const costedFake =
  (cost: number): Fake =>
  async (p, o) => {
    o.onEvent?.({ type: "text", text: `working on ${p}` });
    o.onEvent?.({ type: "result", subtype: "success", costUsd: cost, turns: 1 });
    return { text: p };
  };

describe("track-d prove-run", () => {
  test("L1 a run is born and narrates — phase, agent-start, agent, state, in order", async () => {
    const res = await launchUltra({
      script: SCRIPT,
      agent: costedFake(0.02) as never,
      sessionId: "sess-track-d",
      messageId: "turn-1",
    });
    if (!res.ok) throw new Error(`launch rejected: ${res.error}`);
    await getLiveUltraRun(res.runId)!.finished;
    L1_RUN_ID = res.runId;

    const types = readUltraEvents(res.runId, 0).events.map((e) => e.type);
    // ORDERED, not "contains": the whole claim of story 4.2's engine change is
    // that "begun" PRECEDES "settled" for each ordinal, and an unordered
    // assertion cannot say it.
    expect(types).toEqual([
      "phase",
      "agent-start",
      "agent",
      "log",
      "phase",
      "agent-start",
      "agent",
      "state",
    ]);
    const manifest = getUltraManifest(res.runId);
    expect(manifest?.state).toBe("done");
    expect(manifest?.sessionId).toBe("sess-track-d");
    transcript("L1", `run ${res.runId} narrated ${types.length} events and settled done`);
  });

  test("L2 an in-flight agent is VISIBLE — the leg that proves the executor change landed", async () => {
    // A gated fake: it streams (creating `agents/0.ndjson`) and then blocks, so
    // the run is observed at a moment when ordinal 0 has BEGUN and has NOT
    // SETTLED. Before story 4.2 that moment was unobservable from outside the
    // executor's own process, because an agent emitted NOTHING until it settled.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated: Fake = async (p, o) => {
      o.onEvent?.({ type: "text", text: "half-written answer" });
      await gate;
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.01, turns: 1 });
      return { text: p };
    };
    const res = await launchUltra({
      script: `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet", effort: "high" }); }`,
      agent: gated as never,
      sessionId: "sess-track-d",
    });
    if (!res.ok) throw new Error(`launch rejected: ${res.error}`);

    // Wait for the transcript file rather than sleeping a guessed interval — a
    // fixed delay is a flake waiting for a slower machine.
    for (let i = 0; i < 400 && listUltraAgentOrdinals(res.runId).length === 0; i++) {
      await delay(5);
    }

    const midOrdinals = listUltraAgentOrdinals(res.runId);
    const midEvents = readUltraEvents(res.runId, 0).events;
    expect(midOrdinals).toEqual([0]);
    // ...and it is genuinely NOT settled: settlement IS the `agent` UltraEvent,
    // which is exactly why `agent-start` had to be added.
    expect(midEvents.some((e) => e.type === "agent-start" && e.ordinal === 0)).toBe(true);
    expect(midEvents.some((e) => e.type === "agent")).toBe(false);
    // `effort` rides the event and still never reaches the engine (AC11 proof 1;
    // `ultra-executor.test.ts` holds the engine half of that pin).
    const start = midEvents.find((e) => e.type === "agent-start");
    expect(start && "effort" in start ? start.effort : undefined).toBe("high");

    release();
    await getLiveUltraRun(res.runId)!.finished;
    expect(readUltraEvents(res.runId, 0).events.some((e) => e.type === "agent")).toBe(true);
    transcript("L2", `ordinal 0 was visible in-flight (agent-start seen, agent not yet)`);
  });

  test("L3 the captured stream is serialisable and complete", () => {
    // The core half of L3. The WEB half — replaying these same shapes through
    // `runSnapshot`/`phaseGroups`/`agentRows`/`narratorLines` — lives in
    // `apps/web/lib/ultra-runs.test.ts`, because packages/core cannot import
    // apps/web and no edge like that exists anywhere in this tree.
    const { events } = readUltraEvents(L1_RUN_ID, 0);
    // Every variant the projection layer branches on is present.
    for (const type of ["phase", "agent-start", "agent", "log", "state"]) {
      expect(events.some((e) => e.type === type)).toBe(true);
    }
    // Serialisable: every line round-trips, and every one carries a timestamp.
    expect(events.every((e) => typeof e.ts === "number")).toBe(true);
    expect(() => JSON.parse(JSON.stringify(events))).not.toThrow();
    // Deduped by ordinal: two agents, two settles, two distinct ordinals.
    const settled = events.filter((e) => e.type === "agent").map((e) => e.ordinal);
    expect(settled).toEqual([0, 1]);
    expect(new Set(settled).size).toBe(settled.length);
    // Each `agent-start` precedes its own `agent`.
    for (const ordinal of [0, 1]) {
      const begun = events.findIndex((e) => e.type === "agent-start" && e.ordinal === ordinal);
      const done = events.findIndex((e) => e.type === "agent" && e.ordinal === ordinal);
      expect(begun).toBeGreaterThanOrEqual(0);
      expect(begun).toBeLessThan(done);
    }
    transcript("L3", `${events.length} events complete, ordered and deduped by ordinal`);
  });

  test("L4 the session filter answers — filtered is exactly this run's session, unfiltered a superset", async () => {
    // A run in a DIFFERENT session, so "filtered returns exactly this session"
    // is not vacuously true of a store with one session in it.
    const other = await launchUltra({
      script: `${META}\nexport default async function () { return 1; }`,
      agent: costedFake(0) as never,
      sessionId: "sess-other",
    });
    if (!other.ok) throw new Error("unreachable");
    await getLiveUltraRun(other.runId)!.finished;

    const all = listUltraRuns();
    const mine = all.filter((r) => r.sessionId === "sess-track-d");
    const theirs = all.filter((r) => r.sessionId === "sess-other");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(theirs.map((r) => r.runId)).toEqual([other.runId]);
    expect(all.length).toBeGreaterThan(mine.length);
    // A run with NO sessionId is matched by neither — the reason
    // `filterRunsBySession` is defined-and-equal rather than truthy.
    const loose = await launchUltra({
      script: `${META}\nexport default async function () { return 1; }`,
      agent: costedFake(0) as never,
    });
    if (!loose.ok) throw new Error("unreachable");
    await getLiveUltraRun(loose.runId)!.finished;
    expect(listUltraRuns().filter((r) => r.sessionId === undefined).map((r) => r.runId)).toContain(
      loose.runId,
    );
    transcript("L4", `${mine.length} runs for sess-track-d out of ${listUltraRuns().length}`);
  });

  test("L5 stop and resume keep the journal — a replayed ordinal is `cached` and does not double", async () => {
    // A run that blocks on its SECOND ordinal, so a Stop lands with ordinal 0
    // journaled and ordinal 1 unfinished — the shape a resume actually meets.
    let calls = 0;
    const stopper: Fake = async (p, o) => {
      calls += 1;
      o.onEvent?.({ type: "text", text: "t" });
      if (calls >= 2) {
        // THE FAKE HONOURS THE SHARED AbortController, because the real runner
        // does and because a fake that does not turns Stop into a no-op: the
        // first version of this leg simply blocked on a gate, so releasing it
        // let the agent return normally and the run reached `done` — a Stop
        // test that proved the opposite of its own name.
        await new Promise<void>((_resolve, reject) => {
          const signal = o.abort?.signal;
          if (!signal) return; // never happens: the executor always passes one
          if (signal.aborted) return reject(abortErr());
          signal.addEventListener("abort", () => reject(abortErr()), { once: true });
        });
      }
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.03, turns: 1 });
      return { text: p };
    };
    const res = await launchUltra({ script: SCRIPT, agent: stopper as never, sessionId: "sess-track-d" });
    if (!res.ok) throw new Error("unreachable");
    for (let i = 0; i < 400 && calls < 2; i++) await delay(5);

    expect(stopUltraRun(res.runId)).toBe(true);
    await getLiveUltraRun(res.runId)!.finished.catch(() => {});
    expect(getUltraManifest(res.runId)?.state).toBe("stopped");
    const beforeOrdinals = listUltraAgentOrdinals(res.runId);
    transcript("L5", `stopped with ordinals [${beforeOrdinals.join(",")}] journaled`);

    // RESUME. `resumeUltraRun` replays the persisted script.js from the journal.
    const resumed = await resumeUltraRun(res.runId, { agent: costedFake(0.03) as never });
    if (!resumed.ok) throw new Error(`resume rejected: ${JSON.stringify(resumed)}`);
    await getLiveUltraRun(res.runId)!.finished;

    const events = readUltraEvents(res.runId, 0).events;
    // The replayed prefix re-emits `agent` with `cached: true`...
    const cached = events.filter((e) => e.type === "agent" && e.cached === true);
    expect(cached.length).toBeGreaterThanOrEqual(1);
    // ...and NEVER `agent-start`, because a cache hit starts nothing. That is
    // what keeps a projection keyed on ordinal from doubling its rows.
    const startedOrdinals = events.filter((e) => e.type === "agent-start").map((e) => e.ordinal);
    const settledOrdinals = new Set(
      events.filter((e) => e.type === "agent").map((e) => e.ordinal),
    );
    expect(settledOrdinals.size).toBe(2);
    expect(listUltraAgentOrdinals(res.runId)).toEqual([0, 1]);
    // The stream itself DOES contain duplicate `agent` events — that is the
    // append-only record being honest — so the dedupe is the projection's job
    // and this asserts the raw material it has to survive.
    expect(events.filter((e) => e.type === "agent").length).toBeGreaterThan(settledOrdinals.size);
    transcript(
      "L5",
      `resumed: ${cached.length} cached replays, agent-start for [${startedOrdinals.join(",")}], ordinals still [0,1]`,
    );
  });

  test("L6 the ledger and the manifest agree", () => {
    // `manifest.spend` is a FOLD over `usage.ndjson` — recomputed on every
    // manifest save, never an accumulator — and the fold consumes a non-empty
    // `entryKey` AT MOST ONCE over the file. `ledgerSpendUsd({ ownerKind:
    // "ultra", ownerId })` is THE SAME FOLD read through the port, so the two
    // must agree by construction. Re-deriving the fold here instead would create
    // a second answer waiting to disagree, which is the thing AD-18 exists to
    // prevent.
    const manifest = getUltraManifest(L1_RUN_ID);
    expect(manifest).not.toBeNull();
    const owned = ledgerSpendUsd({ ownerKind: "ultra", ownerId: L1_RUN_ID });
    expect(owned).toBeGreaterThan(0);
    expect(manifest!.spend).toBeCloseTo(owned, 10);

    // AND THE TWO ROLLUPS AGREE ONE LEVEL UP. `ultraCostBySession().get(sid)`
    // necessarily equals the sum of `ledgerSpendUsd` over that session's runs —
    // usage-ledger.ts's own header states it, and folding the same rows two ways
    // is what makes it true rather than maintained.
    const bySession = ultraCostBySession().get("sess-track-d") ?? 0;
    const summed = listUltraRuns()
      .filter((r) => r.sessionId === "sess-track-d")
      .reduce((acc, r) => acc + ledgerSpendUsd({ ownerKind: "ultra", ownerId: r.runId }), 0);
    expect(bySession).toBeCloseTo(summed, 10);
    transcript(
      "L6",
      `manifest.spend ${manifest!.spend} == ledgerSpendUsd ${owned}; session fold ${bySession} == ${summed}`,
    );
  });

  test("L7 the real telar home is untouched throughout", () => {
    // Declared last so it runs last — bun runs a file's tests in declaration
    // order — which is what makes "throughout" mean the whole run rather than
    // one moment in it.
    //
    // LAYER 1 — the guard is ARMED. `usage-ledger.ts` refuses a write when
    // NODE_ENV is "test" and TELAR_HOME is unset or blank. NODE_ENV comes from
    // the runner, not from repo config, so this is checked rather than assumed.
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.TELAR_HOME).toBe(HOME);

    // LAYER 2 — the fingerprint is unchanged. Note this suite does NOT assign a
    // blank TELAR_HOME in this process to "test" the guard: `manifest.ts`'s
    // `telarDir()` falls back to `path.join(os.homedir(), ".telar")` on a blank
    // value, so the only thing between that assignment and a synthetic billing
    // line in the operator's REAL ~/.telar is the very guard under test. Track A
    // proves the guard from a CHILD with its own env and its own HOME; this leg
    // does not re-prove it and does not arm the weapon to try.
    const after = realTelarSnapshot();
    expect(after.exists).toBe(REAL_TELAR_BEFORE.exists);
    expect(after.entries).toEqual(REAL_TELAR_BEFORE.entries);

    // And everything this run wrote is under the sandbox.
    const ultraRoot = path.join(HOME, "ultra");
    expect(fs.existsSync(ultraRoot)).toBe(true);
    expect(fs.readdirSync(ultraRoot).length).toBeGreaterThanOrEqual(4);
    transcript(
      "L7",
      `real ~/.telar unchanged (${after.exists ? `${after.entries.length} entries` : "absent"}); ` +
        `${fs.readdirSync(ultraRoot).length} run dirs under the sandbox`,
    );
  });
});
