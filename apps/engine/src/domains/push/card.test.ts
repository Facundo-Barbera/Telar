import { describe, expect, test } from "bun:test";
import { apnsPriority, signalKey, type Delivery, type DeliveryResult, type PushRecord, type SessionSignal } from "./push";
import { v2Body } from "./relay-v2";
import type { LiveSessionRow, Project } from "@telar/engine-client";
import { deliverRecord, signals } from "./worker";
import { CARD_ROWS, ROW_DONE_S, automaticActivityDelivery, cardRows } from "./card";

const now = 1_800_000_000;
const ms = (s: number) => s * 1000;
const session = (id: string, activity: string, patch: Partial<SessionSignal> = {}): SessionSignal =>
  ({ id, title: `Title ${id}`, activity, activityAt: ms(now - 100), project: "web", ...patch });

describe("the card's session rows", () => {
  test("needs-you first, then working, then the rest, most recent first within each, capped", () => {
    const rows = cardRows([
      session("queued", "queued"), session("old", "working", { activityAt: ms(now - 500) }), session("new", "working", { activityAt: ms(now - 10) }),
      session("bg", "monitoring"), session("ask", "blocked"), session("idle", "idle"),
    ], now, true);
    expect(rows.map(r => [r.id, r.status])).toEqual([["ask", "Needs you"], ["new", "Working"], ["old", "Working"], ["queued", "Queued"]]);
    expect(rows).toHaveLength(CARD_ROWS);
    expect(rows[0]).toEqual({ id: "ask", status: "Needs you", title: "Title ask", project: "web" });
  });

  test("a finished or failed session stays about fifteen minutes after it ends, then leaves", () => {
    const done = session("done", "idle", { lastTurnEndedAt: ms(now - 60) });
    const failed = session("failed", "waiting", { lastTurnEndedAt: ms(now - 30), lastTurnFailed: true });
    expect(cardRows([done, failed, session("work", "working")], now, true).map(r => [r.id, r.status])).toEqual([["work", "Working"], ["failed", "Failed"], ["done", "Done"]]);
    expect(cardRows([done], now + ROW_DONE_S - 61, true)).toHaveLength(1);
    expect(cardRows([done], now + ROW_DONE_S - 60, true)).toHaveLength(0);
  });

  test("without previews no session title leaves the Mac, and long names are cut", () => {
    const secret = session("one", "working", { title: "Rotate the prod keys" });
    const delivery = automaticActivityDelivery({ ...record(), previews: false }, [secret], "c".repeat(64), now, now);
    expect(JSON.stringify(delivery)).not.toContain("Rotate");
    expect((delivery.payload.aps["content-state"] as { rows: unknown[] }).rows).toEqual([{ id: "one", status: "Working", project: "web" }]);
    const [long] = cardRows([session("l", "working", { title: "x".repeat(200), project: "p".repeat(200) })], now, true);
    expect(long!.title).toHaveLength(60);
    expect(long!.project).toHaveLength(40);
  });

  test("rows name the session's project from the engine's project list", () => {
    const [row] = signals([{ id: "one", title: "Task", activity: "working", projectId: "project_1" } as LiveSessionRow], {}, [{ id: "project_1", name: "Telar" } as Project]);
    expect(cardRows([row!], now, true)[0]!.project).toBe("Telar");
  });

  test("a full card stays well under Apple's 4 KB", () => {
    const many = Array.from({ length: 20 }, (_, i) => session(`session_${"x".repeat(40)}${i}`, "working", { title: "t".repeat(500), project: "p".repeat(500) }));
    expect(new TextEncoder().encode(JSON.stringify(automaticActivityDelivery(record(), many, "c".repeat(64), now, now).payload)).length).toBeLessThan(2048);
  });
});

function record(patch: Partial<PushRecord> = {}): PushRecord {
  return { hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "io.github.novarix.telar", sandbox: false,
    enabled: true, completions: true, previews: true, sounds: "felt", mutedSessions: [], liveActivities: true, card: { token: "d".repeat(64), startedAt: now - 600 },
    deviceId: "phone", revision: "r1", updatedAt: 0, baselined: true, seen: {}, activitySent: {}, ...patch };
}
const working = session("one", "working", { activityAt: ms(now - 60) });
const blocked = session("one", "blocked", { activityAt: ms(now - 1) });
async function pass(r: PushRecord, sessions: SessionSignal[], reply: (d: Delivery) => DeliveryResult = () => ({ status: 200 })) {
  const sent: Delivery[] = [];
  const next = await deliverRecord(r, sessions, async d => { sent.push(d); return reply(d); }, now);
  return { sent, next };
}

describe("a session that newly needs the person", () => {
  const watching = record({ seen: { one: signalKey(working) } });

  test("alerts on the live card, with the sound, at priority 10, and sends no separate push", async () => {
    const { sent, next } = await pass(watching, [blocked]);
    expect(sent.map(d => d.kind)).toEqual(["liveactivity"]);
    expect(sent[0]!.payload.aps.alert).toEqual({ title: "Title one", body: "A session needs your input or approval.", sound: "telar-felt-needs.caf" });
    expect(apnsPriority(sent[0]!)).toBe("10");
    expect(v2Body(sent[0]!)?.urgent).toBe(true);
    expect(next!.seen.one).toBe(signalKey(blocked));
  });

  test("falls back to the normal push when no card is live or Live Activities are off", async () => {
    for (const r of [record({ seen: watching.seen, card: undefined, pushToStartToken: undefined }), record({ seen: watching.seen, liveActivities: false })]) {
      const { sent } = await pass(r, [blocked]);
      const alerts = sent.filter(d => d.kind === "alert");
      expect(alerts).toHaveLength(1);
      expect(sent.filter(d => d.kind === "liveactivity" && d.payload.aps.alert !== undefined && d.payload.aps.event !== "start")).toHaveLength(0);
    }
  });

  test("falls back to the normal push when the card update does not land", async () => {
    const { sent, next } = await pass(watching, [blocked], d => ({ status: d.kind === "liveactivity" ? 500 : 200 }));
    expect(sent.map(d => d.kind)).toEqual(["liveactivity", "alert"]);
    expect(next!.seen.one).toBe(signalKey(blocked));
  });

  test("keeps the actionable push for an approvable request, and the card redraws silently", async () => {
    const { sent } = await pass(watching, [{ ...blocked, approvable: "request_1" }]);
    expect(sent.map(d => d.kind)).toEqual(["alert", "liveactivity"]);
    expect(sent[0]!.payload.request).toBe("request_1");
    expect(sent[1]!.payload.aps.alert).toBeUndefined();
    expect(apnsPriority(sent[1]!)).toBe("5");
  });

  test("a replay or reconnect that finds it already blocked does not alert again", async () => {
    const first = await pass(watching, [blocked]);
    const again = await pass({ ...first.next!, activitySent: {} }, [blocked]);
    expect(again.sent.every(d => d.payload.aps.alert === undefined)).toBe(true);
    const fresh = await pass(record({ baselined: false }), [blocked]);
    expect(fresh.sent.every(d => d.payload.aps.alert === undefined)).toBe(true);
  });

  test("muted sessions and sub-session rules still decide who alerts", async () => {
    const muted = await pass(record({ seen: watching.seen, mutedSessions: ["one"] }), [blocked]);
    expect(muted.sent.every(d => d.payload.aps.alert === undefined)).toBe(true);
    const child = await pass(record({ seen: { one: signalKey({ ...working, hasParent: true }) } }), [{ ...blocked, hasParent: true }]);
    expect(child.sent.filter(d => d.payload.aps.alert !== undefined)).toHaveLength(1);
  });
});

describe("priorities per update kind", () => {
  test("routine redraws go at 5; alerting updates, start and end at 10", () => {
    const r = record();
    expect(apnsPriority(automaticActivityDelivery(r, [working], "d".repeat(64), now, now))).toBe("5");
    expect(apnsPriority(automaticActivityDelivery(r, [blocked], "d".repeat(64), now, now))).toBe("5");
    expect(apnsPriority(automaticActivityDelivery(r, [blocked], "d".repeat(64), now, now, "update", { title: "t", body: "b" }))).toBe("10");
    expect(apnsPriority(automaticActivityDelivery(r, [working], "b".repeat(64), now, now, "start"))).toBe("10");
    expect(apnsPriority(automaticActivityDelivery(r, [], "d".repeat(64), now, now, "end"))).toBe("10");
  });
});
