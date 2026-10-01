import { describe, expect, test } from "bun:test";
import { apnsPriority, signalKey, type Delivery, type DeliveryResult, type PushRecord, type SessionSignal } from "./push";
import { v2Body } from "./relay-v2";
import type { LiveSessionRow, Project } from "@telar/engine-client";
import { deliverRecord, signals } from "./worker";
import { CARD_ROWS, ROW_DONE_S, automaticActivityDelivery, cardRows, type CardRow } from "./card";

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

describe("sub-sessions on the card", () => {
  const state = (sessions: SessionSignal[], r = record()) => automaticActivityDelivery(r, sessions, "d".repeat(64), now, now).payload.aps["content-state"] as { title: string; activeCount: number; sessionId?: string; rows: CardRow[] };
  const orchestrator = session("orch", "working", { title: "Ship the release" });
  const worker = (id: string, activity: string, patch: Partial<SessionSignal> = {}) => session(id, activity, { parentId: "orch", hasParent: true, project: "ozom-gv", ...patch });

  test("workers fold into their orchestrator's row, which counts as one active session", () => {
    const card = state([orchestrator, worker("a", "working"), worker("b", "working"), worker("c", "queued"), session("solo", "working")]);
    expect(card.rows).toEqual([
      { id: "orch", status: "Working", title: "Ship the release", project: "web", workers: 3 },
      { id: "solo", status: "Working", title: "Title solo", project: "web" },
    ]);
    expect(card.activeCount).toBe(2);
    expect(card.title).toBe("2 active sessions");
  });

  test("the row takes the most urgent state of the family, and a child's request points at the root", () => {
    const status = (sessions: SessionSignal[]) => cardRows(sessions, now, true).map(r => [r.id, r.status]);
    expect(status([orchestrator, worker("a", "blocked")])).toEqual([["orch", "Needs you"]]);
    expect(status([orchestrator, worker("a", "idle", { lastTurnEndedAt: ms(now - 30), lastTurnFailed: true })])).toEqual([["orch", "Failed"]]);
    expect(status([session("orch", "idle", { lastTurnEndedAt: ms(now - 60) }), worker("a", "working")])).toEqual([["orch", "Working"]]);
    expect(status([session("orch", "idle"), worker("a", "idle", { lastTurnEndedAt: ms(now - 60) })])).toEqual([["orch", "Done"]]);
    expect(state([orchestrator, worker("a", "blocked")]).sessionId).toBe("orch");
  });

  test("a row is named by its title only when titles may leave the Mac, otherwise by its project", () => {
    const sessions = [orchestrator, worker("a", "working"), session("solo", "working")];
    expect(cardRows(sessions, now, true).map(r => [r.title, r.project])).toEqual([["Ship the release", "web"], ["Title solo", "web"]]);
    expect(cardRows(sessions, now, false)).toEqual([
      { id: "orch", status: "Working", project: "web", workers: 1 },
      { id: "solo", status: "Working", project: "web" },
    ]);
  });

  test("workers counts only live children, not finished or settled ones", () => {
    const sessions = [orchestrator, worker("a", "working"), worker("b", "blocked"), worker("done", "idle", { lastTurnEndedAt: ms(now - 60) }),
      worker("failed", "idle", { lastTurnEndedAt: ms(now - 30), lastTurnFailed: true }), worker("shelved", "working", { settled: true })];
    expect(cardRows(sessions, now, true)[0]!.workers).toBe(2);
    const [, settled] = signals([{ id: "p", title: "p", activity: "working", state: "active" }, { id: "c", title: "c", activity: "working", state: "active", startedFrom: { sessionId: "p" }, settledOverride: "settled" }] as LiveSessionRow[]);
    expect(settled!.settled).toBe(true);
  });

  test("the card's header names the Mac without its domain suffix", () => {
    const header = (hostName?: string) => (automaticActivityDelivery({ ...record(), hostName }, [orchestrator], "b".repeat(64), now, now, "start").payload.aps.attributes as { hostName: string }).hostName;
    expect(header("mini-fbarbera.snakebird-cardassia.ts.net")).toBe("mini-fbarbera");
    expect(header("Studio")).toBe("Studio");
    expect(header(undefined)).toBe("Computer");
  });

  test("a child whose parent is not on the card's list stands as its own row", () => {
    expect(cardRows([worker("a", "working", { title: "Fix login" })], now, true)).toEqual([{ id: "a", status: "Working", title: "Fix login", project: "ozom-gv" }]);
  });

  test("an untitled session is named by its project, or its workers' project", () => {
    expect(cardRows([session("u", "working", { title: "  " })], now, true)).toEqual([{ id: "u", status: "Working", project: "web" }]);
    const bare = session("orch", "working", { title: "", project: undefined });
    expect(cardRows([bare, worker("a", "working")], now, true)).toEqual([{ id: "orch", status: "Working", project: "ozom-gv", workers: 1 }]);
    expect(state([bare, worker("a", "working")]).title).toBe("Telar work");
  });

  test("only a live parent adopts: settled, archived, snoozed or deleted parents leave the child a root", () => {
    const row = (id: string, patch: Partial<LiveSessionRow> = {}) => ({ id, title: id, activity: "working", state: "active", ...patch }) as LiveSessionRow;
    const child = row("child", { startedFrom: { sessionId: "parent" } });
    const parentOf = (parent?: Partial<LiveSessionRow>) => signals(parent ? [row("parent", parent), child] : [child], {}, [], ms(now)).find(s => s.id === "child")!.parentId;
    expect(parentOf({})).toBe("parent");
    expect(parentOf({ settledOverride: "settled" })).toBeUndefined();
    expect(parentOf({ state: "archived" } as Partial<LiveSessionRow>)).toBeUndefined();
    expect(parentOf({ snoozedUntil: ms(now + 60) })).toBeUndefined();
    expect(parentOf()).toBeUndefined();
    const assigned = signals([row("parent"), row("child")], { child: [{ fromSessionId: "parent", receivedAt: 1, taskRunId: "r", runId: "r" }] }, [], ms(now));
    expect(assigned.find(s => s.id === "child")!.parentId).toBe("parent");
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
