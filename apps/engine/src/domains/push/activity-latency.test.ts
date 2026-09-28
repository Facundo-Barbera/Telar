import { describe, expect, test } from "bun:test";
import { AUTOMATIC_ACTIVITY, apnsPriority, signalKey, type Delivery, type PushRecord, type SessionSignal } from "./push";
import { v2Body } from "./relay-v2";
import { deliverRecord, FEED_COALESCE_MS, frameAction } from "./worker";

function firstPass(frames: number[]): number | undefined {
  let dueAt: number | undefined;
  for (const at of frames) {
    if (dueAt !== undefined && dueAt <= at) return dueAt;
    if (frameAction(dueAt, false, at) === "schedule") dueAt = at + FEED_COALESCE_MS;
  }
  return dueAt;
}

describe("a busy feed cannot hold the pass back", () => {
  test("frames every 100 ms for ten seconds still get a pass after the first 250", () => {
    const frames = Array.from({ length: 100 }, (_, i) => i * 100);
    expect(firstPass(frames)).toBe(FEED_COALESCE_MS);
  });

  test("a frame during a pass asks for one more, and a long timer is cut short", () => {
    expect(frameAction(undefined, true, 0)).toBe("after-pass");
    expect(frameAction(600_000, false, 0)).toBe("schedule");
    expect(frameAction(FEED_COALESCE_MS, false, 0)).toBe("join");
  });
});

describe("priority 10 for the transition that needs the person, 5 for the rest", () => {
  const working: SessionSignal = { id: "one", title: "A task", activity: "working", activityAt: 1000 };
  const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
  const card = { sessionId: AUTOMATIC_ACTIVITY, token: "d".repeat(64), startedAt: 1 };
  const followed = { sessionId: working.id, token: "e".repeat(64), startedAt: 1 };
  const record = (patch: Partial<PushRecord>): PushRecord => ({
    hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "io.github.novarix.telar", sandbox: false,
    enabled: true, completions: true, previews: false, mutedSessions: [], liveActivities: true, activities: [card, followed],
    deviceId: "paired", revision: "r1", updatedAt: 1000, baselined: true, seen: { [working.id]: signalKey(working) }, activitySent: {}, ...patch,
  });
  async function sent(r: PushRecord, sessions: SessionSignal[], now: number) {
    const out: Delivery[] = [];
    await deliverRecord(r, sessions, async d => { out.push(d); return { status: 200 }; }, now);
    return out.filter(d => d.kind === "liveactivity");
  }

  test("turning to Needs you is urgent, on both cards and through the relay", async () => {
    const out = await sent(record({ automaticSignal: "old" }), [blocked], 5000);
    expect(out.map(apnsPriority)).toEqual(["10", "10"]);
    expect(out.map(d => v2Body(d)?.urgent)).toEqual([true, true]);
  });

  test("the heartbeat repeating Needs you, and routine progress, stay at 5", async () => {
    const quiet = record({ seen: { [working.id]: signalKey(blocked) } });
    const first = await deliverRecord(quiet, [blocked], async () => ({ status: 200 }), 5000);
    const beat = await sent({ ...first!, activitySent: {} }, [blocked], 5200);
    expect(beat.map(apnsPriority)).toEqual(["5", "5"]);
    const progress = await sent(record({ automaticSignal: "old" }), [{ ...working, activityAt: 3000 }], 5000);
    expect(progress.map(apnsPriority)).toEqual(["5", "5"]);
    expect(progress.map(d => "urgent" in (v2Body(d) ?? {}))).toEqual([false, false]);
  });

  test("background is always 5, alerts and ends always 10", () => {
    const base = { token: "a", topic: "t", sandbox: false, collapseId: "c" };
    expect(apnsPriority({ ...base, kind: "background", urgent: true, payload: { aps: { "content-available": 1 } } })).toBe("5");
    expect(apnsPriority({ ...base, kind: "alert", payload: { aps: {} } })).toBe("10");
    expect(apnsPriority({ ...base, kind: "liveactivity", payload: { aps: { event: "end" } } })).toBe("10");
  });
});
