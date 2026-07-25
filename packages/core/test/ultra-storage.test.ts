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
  runDir,
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

describe("Ultra storage — events.ndjson tails phase/log/agent/state in order", () => {
  test("readUltraEvents returns everything from offset 0, then only new lines after", async () => {
    const script = `${META}\nexport default async function ({ agent, phase, log }) {\n  phase("Phase 1");\n  await agent("p", { model: "sonnet" });\n  log("done");\n  return 1;\n}`;
    const res = await launchUltra({ script, agent: costedFake(0.02) });
    if (!res.ok) throw new Error("unreachable");
    await getLiveUltraRun(res.runId)!.finished;

    const { events, nextLine } = readUltraEvents(res.runId, 0);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["phase", "agent", "log", "state"]);
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
    // re-makes (or re-bills) the call. Its ledger line was written on the
    // first run and survives the stop, so the resumed total must be identical.
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
    // Zero new lines for the replayed ordinals, and the total is unchanged —
    // not ~2x, which is what an unconditional append would produce.
    expect(ultraLinesFor(res.runId)).toHaveLength(linesAfterFirstRun);
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
