// Story 4.1 — the completion wake (AC1, AC2, AC4, AC7; FR-UW-1).
//
// Temp TELAR_HOME (never the real ~/.telar, the ultra-storage.test.ts idiom),
// a fake agent() runner (DI seam, no live SDK). Exercises: the declared
// agent-facing event and its class gate; a terminal run becoming pending and
// only a terminal one; the RESTART FLOOR — a wake that was never published at
// all is still pending; the self-healed `stopped` that never reaches settle();
// the durable, idempotent, session-scoped ack; and the runId fallback for a
// script whose meta carries no usable name.
//
// THE THING THESE TESTS ARE FOR, stated once: the bus is the fast path and the
// manifest projection is the guarantee. Half the cases below deliberately never
// publish anything.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentOpts } from "../src/engine";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ultra-wake-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin before every test (looms.test.ts idiom).
beforeEach(() => {
  process.env.TELAR_HOME = home;
  resetBus();
});

const {
  launchUltra,
  getLiveUltraRun,
  getUltraManifest,
  runDir,
  ultraEvents,
  ultraRunLabel,
  ultraWakeChannel,
  pendingUltraWakes,
  ackUltraWakes,
  watchUltraRun,
  readUltraWakeRecord,
  liveUltraRunCount,
  ULTRA_RUN_COMPLETED,
} = await import("../src/ultra");
const { declareEvents, resetBus, subscribeAgentFacing, eventDeclaration } = await import(
  "../src/event-bus"
);

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

type Fake = (prompt: string, opts: AgentOpts<any>) => Promise<any>;
const META = `export const meta = { name: "nightly sweep", description: "d", phases: [] };`;
const costedFake =
  (cost: number): Fake =>
  async (p, o) => {
    o.onEvent?.({ type: "result", subtype: "success", costUsd: cost, turns: 1 });
    return { text: p };
  };

// A run driven all the way to a terminal state through the REAL launch path, so
// the manifest under test is the one production writes rather than one this
// suite invented.
async function settledRun(opts: {
  sessionId?: string;
  messageId?: string;
  meta?: string;
  cost?: number;
}): Promise<string> {
  const script = `${opts.meta ?? META}\nexport default async function ({ agent }) {\n  return await agent("p0", { model: "sonnet" });\n}`;
  const res = await launchUltra({
    script,
    agent: costedFake(opts.cost ?? 0.01),
    sessionId: opts.sessionId,
    messageId: opts.messageId,
  });
  if (!res.ok) throw new Error(`launch failed: ${res.error}`);
  await getLiveUltraRun(res.runId)!.finished;
  return res.runId;
}

// A manifest placed straight on disk — the only way to build the two states no
// live launch can produce in-process: a run whose process DIED (so nothing ever
// published), and a `running` manifest with no registry entry (the stale one
// getUltraManifest self-heals on read).
function plantManifest(runId: string, over: Record<string, unknown>): void {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        runId,
        meta: { name: "planted" },
        state: "done",
        spend: 0,
        startedAt: 1,
        updatedAt: 2,
        ...over,
      },
      null,
      2,
    ),
  );
}

const SID = (tag: string) => `sess-${tag}`;

describe("ultra completion wake (FR-UW-1)", () => {
  // ── AC4: the declared event and its class gate ────────────────────────────

  test("AC4 the wake is an agent-facing event on epic 1's bus, and it reaches the WAKE channel", async () => {
    const runId = await settledRun({ sessionId: SID("ac4"), messageId: "turn-1" });
    // The accessor installs the declaration AND the recorder — one call, both.
    const port = ultraWakeChannel();
    expect(eventDeclaration(ULTRA_RUN_COMPLETED)).toEqual({ deliveryClass: "agent-facing" });
    const m = getUltraManifest(runId)!;
    const r = port.publish("run-completed", {
      runId,
      sessionId: m.sessionId ?? "",
      messageId: m.messageId ?? "",
      state: "done",
      name: ultraRunLabel(m.meta, runId),
      spendUsd: m.spend,
      terminalAt: m.updatedAt,
    });
    expect(r.name).toBe(ULTRA_RUN_COMPLETED);
    expect(r.deliveryClass).toBe("agent-facing");
    // The discriminating field: it went to a WAKE subscriber, not merely to a
    // subscriber. That is the capability the class exists to license.
    expect(r.wakeDelivered).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBe(0);
  });

  test("AC4 a human-facing declaration of the SAME shape is refused by the wake channel", () => {
    // The discriminator. Without it, "our event is agent-facing" would be a
    // claim about a string rather than about a gate that does anything.
    declareEvents("fixture", {
      "run-completed": { deliveryClass: "human-facing", payload: z.object({ runId: z.string() }) },
    });
    expect(() => subscribeAgentFacing("fixture:run-completed", () => {})).toThrow(/wake channel/);
    expect(() => subscribeAgentFacing("fixture:run-completed", () => {})).toThrow(/human-facing/);
    // …and the same call against ultra's real, agent-facing name succeeds.
    expect(() => ultraWakeChannel()).not.toThrow();
  });

  test("the accessor is SELF-HEALING: it survives a global resetBus() rather than caching a dead port", () => {
    // T2 — a cached-port-plus-a-boolean-flag passes a re-evaluation and then
    // breaks here, because the flag says "declared" while the registry says
    // otherwise and the next publish throws `not declared`. Checking the
    // REGISTRY is what makes this pass.
    const first = ultraWakeChannel();
    expect(eventDeclaration(ULTRA_RUN_COMPLETED)).not.toBeNull();
    resetBus();
    expect(eventDeclaration(ULTRA_RUN_COMPLETED)).toBeNull();
    const second = ultraWakeChannel();
    expect(second).not.toBe(first);
    expect(eventDeclaration(ULTRA_RUN_COMPLETED)).toEqual({ deliveryClass: "agent-facing" });
    // And the RECORDER came back with it — a re-declared port with no
    // subscriber would report wakeDelivered 0 here.
    const r = second.publish("run-completed", {
      runId: "does-not-exist-heal",
      sessionId: "",
      messageId: "",
      state: "stopped",
      name: "x",
      spendUsd: 0,
      terminalAt: 1,
    });
    expect(r.wakeDelivered).toBeGreaterThanOrEqual(1);
  });

  // ── AC1/AC7: pending is a projection ──────────────────────────────────────

  test("AC1 a terminal run is pending for its session, carrying the outcome without a second lookup", async () => {
    const sid = SID("pending");
    const runId = await settledRun({ sessionId: sid, messageId: "turn-7", cost: 0.25 });
    const [wake, ...rest] = pendingUltraWakes(sid);
    expect(rest).toEqual([]);
    expect(wake!.runId).toBe(runId);
    expect(wake!.sessionId).toBe(sid);
    expect(wake!.messageId).toBe("turn-7");
    expect(wake!.state).toBe("done");
    // AD-8 — denormalized enough to render with no lookup.
    expect(wake!.name).toBe("nightly sweep");
    expect(wake!.spendUsd).toBeCloseTo(0.25);
    expect(wake!.terminalAt).toBe(getUltraManifest(runId)!.updatedAt);
    expect(wake!.result).toEqual({ text: "p0" });
  });

  test("AC7 anti-vacuity — a genuinely LIVE run is NOT pending, so 'everything is pending' cannot pass", async () => {
    // THE POSITIVE CONTROL, and it has to be a genuinely live run rather than a
    // planted `running` manifest: a `running` manifest with no registry entry
    // self-heals to `stopped` on read (T3, below), which IS terminal and SHOULD
    // be pending. Only a run this process is still driving is honestly
    // non-terminal, so the gate below holds one open across the assertion.
    const sid = SID("live");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowFake: Fake = async (p, o) => {
      await gate;
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0.02, turns: 1 });
      return { text: p };
    };
    const script = `${META}\nexport default async function ({ agent }) {\n  return await agent("p0", { model: "sonnet" });\n}`;
    const res = await launchUltra({ script, agent: slowFake, sessionId: sid });
    if (!res.ok) throw new Error("unreachable");
    expect(pendingUltraWakes(sid)).toEqual([]);
    expect(liveUltraRunCount(sid)).toBe(1);
    release();
    await getLiveUltraRun(res.runId)!.finished;
    // …and the SAME run is pending the moment it settles, so the negative above
    // is about the run's state and not about the projection being broken.
    expect(pendingUltraWakes(sid).map((w) => w.runId)).toEqual([res.runId]);
    expect(liveUltraRunCount(sid)).toBe(0);
    // A session with no runs at all is empty rather than "everything".
    expect(pendingUltraWakes("no-such-session")).toEqual([]);
  });

  test("AC7 THE RESTART FLOOR — a wake that was NEVER published at all is still pending", () => {
    // Nothing in this test touches the bus. This is the case that decides
    // whether losing an event means "delivered late" or "delivered never": the
    // process persisted a terminal manifest and died before publishing.
    const sid = SID("floor");
    plantManifest("run_floor_1", { sessionId: sid, state: "done", spend: 3.5, result: { ok: 1 } });
    expect(readUltraWakeRecord("run_floor_1")).toBeNull();
    const [wake] = pendingUltraWakes(sid);
    expect(wake!.runId).toBe("run_floor_1");
    expect(wake!.state).toBe("done");
    expect(wake!.spendUsd).toBe(3.5);
    expect(wake!.result).toEqual({ ok: 1 });
  });

  test("AC7 T3 — a SELF-HEALED `stopped` never reaches settle(), and is pending anyway", () => {
    // getUltraManifest rewrites a stale `running` manifest to `stopped` ON READ
    // and re-saves it. That is a state change with no {type:"state"} event, no
    // run.finished, and therefore NO publish — and it is state-identical to a
    // human ultra_stop. A projection keyed off "a wake record exists" would
    // silently swallow every run killed by a server restart, which is the exact
    // class of failure this story exists to end.
    const sid = SID("selfheal");
    plantManifest("run_stale_1", { sessionId: sid, state: "running" });
    expect(readUltraWakeRecord("run_stale_1")).toBeNull();
    const [wake] = pendingUltraWakes(sid);
    expect(wake!.runId).toBe("run_stale_1");
    expect(wake!.state).toBe("stopped");
    // The self-heal really did happen — the manifest on disk says so now.
    expect(getUltraManifest("run_stale_1")!.state).toBe("stopped");
    // …and still no wake record was needed to get here.
    expect(readUltraWakeRecord("run_stale_1")).toBeNull();
  });

  test("a run belonging to ANOTHER session is never this session's wake", () => {
    plantManifest("run_theirs_1", { sessionId: SID("theirs"), state: "done" });
    plantManifest("run_mine_1", { sessionId: SID("mine"), state: "done" });
    expect(pendingUltraWakes(SID("mine")).map((w) => w.runId)).toEqual(["run_mine_1"]);
    expect(pendingUltraWakes(SID("theirs")).map((w) => w.runId)).toEqual(["run_theirs_1"]);
  });

  test("an empty sessionId short-circuits — no scan, and no '' bucket to match against", () => {
    plantManifest("run_orphan_1", { state: "done" }); // launched outside a chat: no sessionId
    expect(pendingUltraWakes("")).toEqual([]);
    expect(liveUltraRunCount("")).toBe(0);
  });

  // ── AC7: delivered is a durable stamp ─────────────────────────────────────

  test("AC7 EXACTLY ONCE — an acked wake stops being pending, durably", () => {
    const sid = SID("ack");
    plantManifest("run_ack_1", { sessionId: sid, state: "done" });
    expect(pendingUltraWakes(sid).map((w) => w.runId)).toEqual(["run_ack_1"]);
    expect(ackUltraWakes(sid, ["run_ack_1"])).toBe(1);
    expect(pendingUltraWakes(sid)).toEqual([]);
    // Durable, not an in-memory flag: the stamp is on disk and a fresh read
    // (which is all a new process would do) finds it.
    const rec = readUltraWakeRecord("run_ack_1")!;
    expect(rec.deliveredAt).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(runDir("run_ack_1"), "wake.json"), "utf8")).deliveredAt)
      .toBe(rec.deliveredAt);
  });

  test("AC7 the ack is IDEMPOTENT — a second ack keeps the FIRST timestamp", () => {
    const sid = SID("ackidem");
    plantManifest("run_ack_2", { sessionId: sid, state: "failed", error: "boom" });
    expect(ackUltraWakes(sid, ["run_ack_2"])).toBe(1);
    const first = readUltraWakeRecord("run_ack_2")!.deliveredAt;
    // Two turns racing the same wake: the second stamps nothing.
    expect(ackUltraWakes(sid, ["run_ack_2", "run_ack_2"])).toBe(0);
    expect(readUltraWakeRecord("run_ack_2")!.deliveredAt).toBe(first);
  });

  test("an ack cannot consume ANOTHER session's wake, and cannot invent one", () => {
    plantManifest("run_x_1", { sessionId: SID("owner"), state: "done" });
    expect(ackUltraWakes(SID("attacker"), ["run_x_1"])).toBe(0);
    expect(pendingUltraWakes(SID("owner")).map((w) => w.runId)).toEqual(["run_x_1"]);
    // Unknown and malformed ids are no-ops, never throws — this sits on a turn path.
    expect(ackUltraWakes(SID("owner"), ["no-such-run"])).toBe(0);
    expect(ackUltraWakes(SID("owner"), ["../../etc/passwd"])).toBe(0);
    expect(ackUltraWakes("", ["run_x_1"])).toBe(0);
    expect(ackUltraWakes(SID("owner"), [])).toBe(0);
  });

  test("a LIVE run cannot be acked — a wake nobody could have read is not consumable", async () => {
    // Same reason the anti-vacuity control above uses a real run: a planted
    // `running` manifest self-heals to `stopped` on the ack's own read, which is
    // terminal and IS ackable (correct, and asserted at the end). The refusal
    // that matters is for a run still executing.
    const sid = SID("ackrunning");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowFake: Fake = async (p, o) => {
      await gate;
      o.onEvent?.({ type: "result", subtype: "success", costUsd: 0, turns: 1 });
      return { text: p };
    };
    const script = `${META}\nexport default async function ({ agent }) {\n  return await agent("p0", { model: "sonnet" });\n}`;
    const res = await launchUltra({ script, agent: slowFake, sessionId: sid });
    if (!res.ok) throw new Error("unreachable");
    expect(ackUltraWakes(sid, [res.runId])).toBe(0);
    expect(readUltraWakeRecord(res.runId)).toBeNull();
    release();
    await getLiveUltraRun(res.runId)!.finished;
    expect(ackUltraWakes(sid, [res.runId])).toBe(1);
    // The self-heal path really does end terminal-and-ackable, which is why the
    // refusal above had to be proved with a live run rather than a planted one.
    plantManifest("run_ack_stale_1", { sessionId: sid, state: "running" });
    expect(ackUltraWakes(sid, ["run_ack_stale_1"])).toBe(1);
    expect(getUltraManifest("run_ack_stale_1")!.state).toBe("stopped");
  });

  // ── T10 / D3a ─────────────────────────────────────────────────────────────

  test("T10 three finished runs are THREE pending records for one session — the caller fires one turn", () => {
    // The formatter takes a list precisely so several outcomes ride one
    // appendix; the client's job is one trigger per pass, proved at the
    // dev server and in apps/web/lib/ultra-wake.test.ts.
    const sid = SID("three");
    plantManifest("run_t10_a", { sessionId: sid, state: "done", updatedAt: 10 });
    plantManifest("run_t10_b", { sessionId: sid, state: "failed", updatedAt: 30, error: "nope" });
    plantManifest("run_t10_c", { sessionId: sid, state: "stopped", updatedAt: 20 });
    const wakes = pendingUltraWakes(sid);
    expect(wakes).toHaveLength(3);
    // Newest first.
    expect(wakes.map((w) => w.runId)).toEqual(["run_t10_b", "run_t10_c", "run_t10_a"]);
    // One ack call consumes the whole set.
    expect(ackUltraWakes(sid, wakes.map((w) => w.runId))).toBe(3);
    expect(pendingUltraWakes(sid)).toEqual([]);
  });

  test("D3a a script whose meta carries no usable name falls back to the runId rather than throwing", () => {
    // UltraManifest has NO `name` field; ScriptMeta is Record<string, unknown>
    // and compileScript validates only that `meta` is a pure object literal. So
    // every shape below is reachable from a script a human actually wrote.
    expect(ultraRunLabel({ name: "real" }, "run_z")).toBe("real");
    expect(ultraRunLabel({}, "run_z")).toBe("run_z");
    expect(ultraRunLabel({ name: "" }, "run_z")).toBe("run_z");
    expect(ultraRunLabel({ name: "   " }, "run_z")).toBe("run_z");
    expect(ultraRunLabel({ name: 42 }, "run_z")).toBe("run_z");
    expect(ultraRunLabel(undefined, "run_z")).toBe("run_z");
    expect(ultraRunLabel(null, "run_z")).toBe("run_z");
    // …and it reaches the projection, not only the helper.
    const sid = SID("noname");
    plantManifest("run_noname_1", { sessionId: sid, state: "done", meta: {} });
    expect(pendingUltraWakes(sid)[0]!.name).toBe("run_noname_1");
  });

  // ── the recorder's own stamp ──────────────────────────────────────────────

  test("the published event stamps `recordedAt` — and the stamp is the FAST PATH, not the guarantee", () => {
    const sid = SID("stamp");
    plantManifest("run_stamp_1", { sessionId: sid, state: "done" });
    const port = ultraWakeChannel();
    expect(readUltraWakeRecord("run_stamp_1")).toBeNull();
    port.publish("run-completed", {
      runId: "run_stamp_1",
      sessionId: sid,
      messageId: "",
      state: "done",
      name: "x",
      spendUsd: 0,
      terminalAt: 2,
    });
    const rec = readUltraWakeRecord("run_stamp_1")!;
    expect(rec.recordedAt).toBeGreaterThan(0);
    expect(rec.deliveredAt).toBe(0);
    // A stamped-but-undelivered run is STILL pending — recording is not delivering.
    expect(pendingUltraWakes(sid).map((w) => w.runId)).toEqual(["run_stamp_1"]);
    // A re-publish REFRESHES `recordedAt` (it means "when the most recent
    // terminal publish was seen") and can NEVER un-deliver: the delivery stamps
    // are carried forward, so a publish arriving after an ack cannot resurrect a
    // wake the agent already stated.
    ackUltraWakes(sid, ["run_stamp_1"]);
    const delivered = readUltraWakeRecord("run_stamp_1")!.deliveredAt;
    expect(delivered).toBeGreaterThan(0);
    port.publish("run-completed", {
      runId: "run_stamp_1",
      sessionId: sid,
      messageId: "",
      state: "done",
      name: "x",
      spendUsd: 0,
      terminalAt: 3,
    });
    const after = readUltraWakeRecord("run_stamp_1")!;
    expect(after.deliveredAt).toBe(delivered);
    expect(after.recordedAt).toBeGreaterThan(0);
    expect(pendingUltraWakes(sid)).toEqual([]);
  });

  test("AC7 a RESUMED run's NEW outcome is pending again — a delivery stamp names a TERMINAL, not a run", () => {
    // THE BUG THIS PINS, found by adversarial review of story 4.1's own code and
    // fixed rather than argued away. `deliveredAt` alone says "this RUN was
    // delivered". Nothing on the resume path touches wake.json — so a run
    // delivered as `stopped`, then resumed (the documented Stop → edit → resume
    // surgery) and finished `done` with a real result, was excluded from
    // pendingUltraWakes FOREVER. The agent would have heard the stale outcome
    // and never the real one, permanently, surviving a restart: exactly the
    // "delivered never" this module claims cannot happen.
    const sid = SID("resume");
    plantManifest("run_resume_1", { sessionId: sid, state: "stopped", updatedAt: 100 });
    expect(pendingUltraWakes(sid).map((w) => w.runId)).toEqual(["run_resume_1"]);
    expect(ackUltraWakes(sid, ["run_resume_1"])).toBe(1);
    expect(pendingUltraWakes(sid)).toEqual([]);
    // The resume: a NEW terminal state, with a new updatedAt, and a real result.
    plantManifest("run_resume_1", {
      sessionId: sid,
      state: "done",
      updatedAt: 200,
      result: { finally: "done" },
    });
    const [again] = pendingUltraWakes(sid);
    expect(again!.runId).toBe("run_resume_1");
    expect(again!.state).toBe("done");
    expect(again!.result).toEqual({ finally: "done" });
    // …and acking the NEW outcome consumes it, without re-arming.
    expect(ackUltraWakes(sid, ["run_resume_1"])).toBe(1);
    expect(pendingUltraWakes(sid)).toEqual([]);
    // THE DISCRIMINATOR: the SAME terminal is still delivered-once. Without this,
    // "re-deliver on a new updatedAt" could be satisfied by never honouring the
    // stamp at all, which would re-state every outcome on every turn.
    expect(ackUltraWakes(sid, ["run_resume_1"])).toBe(0);
    expect(pendingUltraWakes(sid)).toEqual([]);
    expect(readUltraWakeRecord("run_resume_1")!.deliveredTerminalAt).toBe(200);
  });

  test("a torn or unparseable wake record reads as 'not delivered' rather than throwing", () => {
    // AD-7 tolerant reader, and the failure DIRECTION matters: a record nobody
    // can parse must re-deliver, never swallow.
    const sid = SID("torn");
    plantManifest("run_torn_1", { sessionId: sid, state: "done" });
    fs.writeFileSync(path.join(runDir("run_torn_1"), "wake.json"), '{"runId": "run_torn_1", "deliv');
    expect(readUltraWakeRecord("run_torn_1")).toBeNull();
    expect(pendingUltraWakes(sid).map((w) => w.runId)).toEqual(["run_torn_1"]);
    // An unknown field is absorbed; a missing one defaults.
    fs.writeFileSync(
      path.join(runDir("run_torn_1"), "wake.json"),
      JSON.stringify({ runId: "run_torn_1", somethingNewer: true }),
    );
    expect(readUltraWakeRecord("run_torn_1")).toEqual({
      runId: "run_torn_1",
      recordedAt: 0,
      deliveredAt: 0,
      deliveredTerminalAt: 0,
      // Added by the per-run watch record; defaulted, so a wake.json written
      // before the field existed still parses (story 1.1's tolerant reader).
      watchedAt: 0,
    });
  });

  test("the real launch path publishes at the terminal write, so a live process needs no reconcile", async () => {
    // End to end through storage.ts's run.finished.then — the only test here
    // that exercises the production publish site rather than calling publish
    // itself.
    const sid = SID("e2e");
    ultraWakeChannel(); // install the recorder BEFORE the run settles
    const runId = await settledRun({ sessionId: sid, messageId: "turn-e2e" });
    expect(readUltraWakeRecord(runId)!.recordedAt).toBeGreaterThan(0);
    expect(pendingUltraWakes(sid).map((w) => w.runId)).toEqual([runId]);
    expect(ackUltraWakes(sid, [runId])).toBe(1);
    expect(pendingUltraWakes(sid)).toEqual([]);
  });

  // ── the per-run watch record (AC-E5) ──────────────────────────────────────
  //
  // THE ONE SENTENCE: watching records INTEREST, it does not switch delivery on.
  // pendingUltraWakes has no opt-in gate and must never grow one.
  describe("watchUltraRun — register interest in ONE run, additive, never a gate", () => {
    test("it stamps watchedAt and returns the run's CURRENT state, without waiting for a terminal", async () => {
      const sid = SID("watch-live");
      const hanging: Fake = (_p, o) =>
        new Promise((_res, rej) => {
          o.abort!.signal.addEventListener("abort", () => rej(new Error("stopped")), { once: true });
        });
      const res = await launchUltra({
        script: `${META}\nexport default async function ({ agent }) { return agent("p", { model: "sonnet" }); }`,
        agent: hanging,
        sessionId: sid,
      });
      if (!res.ok) throw new Error("unreachable");
      const watched = watchUltraRun(sid, res.runId);
      expect(watched.ok).toBe(true);
      expect(watched.state).toBe("running"); // it returned BEFORE the run was terminal
      expect(watched.alreadyWatching).toBe(false);
      expect(readUltraWakeRecord(res.runId)!.watchedAt).toBeGreaterThan(0);
      getLiveUltraRun(res.runId)!.stop();
      await getLiveUltraRun(res.runId)!.finished;
    });

    test("IDEMPOTENT — a second watch keeps the FIRST stamp and reports alreadyWatching", () => {
      const sid = SID("watch-idem");
      plantManifest("run_watch_idem", { sessionId: sid, state: "done" });
      expect(watchUltraRun(sid, "run_watch_idem").alreadyWatching).toBe(false);
      const first = readUltraWakeRecord("run_watch_idem")!.watchedAt;
      const second = watchUltraRun(sid, "run_watch_idem");
      expect(second.alreadyWatching).toBe(true);
      expect(readUltraWakeRecord("run_watch_idem")!.watchedAt).toBe(first);
    });

    test("SESSION-CHECKED — watching another session's run is refused and writes NOTHING", () => {
      plantManifest("run_watch_other", { sessionId: SID("watch-owner"), state: "done" });
      const res = watchUltraRun(SID("watch-intruder"), "run_watch_other");
      expect(res.ok).toBe(false);
      expect(readUltraWakeRecord("run_watch_other")).toBeNull();
      // An empty session is refused the same way, and never scans.
      expect(watchUltraRun("", "run_watch_other").ok).toBe(false);
    });

    test("an UNKNOWN runId is refused and leaves no orphaned directory behind", () => {
      // A typo must not mkdir a run directory that has no manifest — nothing
      // reaps such a directory and listUltraRuns can never reach it.
      const res = watchUltraRun(SID("watch-typo"), "run_watch_typo");
      expect(res.ok).toBe(false);
      expect(fs.existsSync(runDir("run_watch_typo"))).toBe(false);
    });

    test("THE NON-GATE — a terminal run that was NEVER watched is STILL pending", () => {
      // Watching is additive; it never gates delivery. If a later change
      // "optimises" pendingUltraWakes by filtering on watchedAt, this fails.
      const sid = SID("watch-nongate");
      plantManifest("run_watch_unwatched", { sessionId: sid, state: "done" });
      plantManifest("run_watch_watched", { sessionId: sid, state: "done", updatedAt: 3 });
      watchUltraRun(sid, "run_watch_watched");
      const pending = pendingUltraWakes(sid);
      expect(pending.map((w) => w.runId).sort()).toEqual([
        "run_watch_unwatched",
        "run_watch_watched",
      ]);
      // …and `watched` is surfaced only for the one that was.
      expect(pending.find((w) => w.runId === "run_watch_watched")!.watched).toBe(true);
      expect(pending.find((w) => w.runId === "run_watch_unwatched")!.watched).toBeUndefined();
    });

    test("CARRY-FORWARD — watchedAt survives a publish AND an ack", () => {
      // THE SHAPE BUG THIS DESIGN INVITES. recordUltraWake and ackUltraWakes each
      // rebuild the record from a FULL object literal, so a field either of them
      // forgets is erased by the next publish or the next ack — the same clobber
      // buildManifest has one level up. Every single-step test passes without
      // this one.
      const sid = SID("watch-carry");
      plantManifest("run_watch_carry", { sessionId: sid, state: "done", updatedAt: 42 });
      watchUltraRun(sid, "run_watch_carry");
      const stamped = readUltraWakeRecord("run_watch_carry")!.watchedAt;
      expect(stamped).toBeGreaterThan(0);

      ultraWakeChannel().publish("run-completed", {
        runId: "run_watch_carry",
        sessionId: sid,
        messageId: "",
        state: "done",
        name: "planted",
        spendUsd: 0,
        terminalAt: 42,
      });
      expect(readUltraWakeRecord("run_watch_carry")!.watchedAt).toBe(stamped);

      expect(ackUltraWakes(sid, ["run_watch_carry"])).toBe(1);
      expect(readUltraWakeRecord("run_watch_carry")!.watchedAt).toBe(stamped);
    });

    test("TOLERANT READER — a wake.json written before watchedAt existed is unwatched, not rejected", () => {
      const sid = SID("watch-tolerant");
      plantManifest("run_watch_old", { sessionId: sid, state: "done", updatedAt: 7 });
      fs.writeFileSync(
        path.join(runDir("run_watch_old"), "wake.json"),
        JSON.stringify({ runId: "run_watch_old", recordedAt: 1, deliveredAt: 0, deliveredTerminalAt: 0 }),
      );
      expect(readUltraWakeRecord("run_watch_old")!.watchedAt).toBe(0);
      expect(pendingUltraWakes(sid).find((w) => w.runId === "run_watch_old")!.watched).toBeUndefined();
    });
  });

  test("the record lives under ultra's OWN subtree and nowhere else — AD-5", () => {
    plantManifest("run_ad5_1", { sessionId: SID("ad5"), state: "done" });
    ackUltraWakes(SID("ad5"), ["run_ad5_1"]);
    expect(fs.existsSync(path.join(home, "ultra", "run_ad5_1", "wake.json"))).toBe(true);
    // NOT under sessions/ — that subtree is the session module's, and a third
    // writer there is the exact breach INV-3 exists to catch.
    expect(fs.existsSync(path.join(home, "sessions"))).toBe(false);
    // Atomic write leaves no .tmp behind.
    expect(fs.existsSync(path.join(home, "ultra", "run_ad5_1", "wake.json.tmp"))).toBe(false);
  });
});
