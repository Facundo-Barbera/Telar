import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALERT_BODY, legacyPushFile, notification, parseRegistration, pushFile, readPushRecords, saveRegistration, signalKey, type MobileRegistration, type PushRecord, type SessionSignal } from "./push";
import type { LiveSessionRow, SessionAssignment } from "@telar/engine-client";
import { desktopNotices, emptyDesktopState } from "./desktop";
import { deliverRecord, signals } from "./worker";

const registration: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "io.github.novarix.telar", sandbox: true,
  enabled: true, completions: true, previews: false, mutedSessions: [],
};
const working: SessionSignal = { id: "session/a?b", title: "Private repository task", activity: "working", activityAt: 1000 };
const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
const record = (): PushRecord => ({ ...registration, deviceId: "paired", revision: "r1", updatedAt: 1000, seen: {}, activitySent: {} });

describe("mobile push delivery", () => {
  test("rejects arbitrary topics, malformed tokens and oversized subscriptions", () => {
    expect(parseRegistration(registration)).toEqual(registration);
    for (const patch of [{ topic: "com.someone.else" }, { token: "not-a-token" }, { hostId: "wrong" }, { enabled: "yes" }, { activities: Array(9).fill({}) }]) {
      expect(() => parseRegistration({ ...registration, ...patch })).toThrow();
    }
  });
  test("a registration keeps only the host card, never a session's own card", () => {
    const card = { sessionId: "__automatic__", token: "c".repeat(64), startedAt: 5 };
    const session = { sessionId: "session_1", token: "d".repeat(64), startedAt: 6 };
    expect(parseRegistration({ ...registration, activities: [session, card] }).card).toEqual({ token: card.token, startedAt: 5 });
    expect(parseRegistration({ ...registration, activities: [session] })).not.toHaveProperty("card");
  });
  test("still accepts the pre-#1042 app's topics, so phones paired with it keep working", () => {
    for (const topic of ["com.telar.mobile", "com.telar.mobile.dev", "io.github.novarix.telar.dev"]) {
      expect(parseRegistration({ ...registration, topic }).topic).toBe(topic);
    }
  });
  test("baseline and duplicate polls do not alert; attention transitions do", () => {
    expect(notification(registration, blocked, undefined)).toBeUndefined();
    expect(notification(registration, blocked, signalKey(blocked))).toBeUndefined();
    const delivery = notification(registration, blocked, signalKey(working))!;
    expect(delivery.payload.aps.alert).toEqual({ title: "Telar", body: "A session needs your input or approval." });
    expect(JSON.stringify(delivery.payload)).not.toContain(working.title);
    expect(new URL(delivery.payload.url!).searchParams.get("id")).toBe(working.id);
    expect(new URL(delivery.payload.url!).searchParams.get("host")).toBe(registration.hostId);
  });
  test("sessions created after the initial baseline can alert on their first sight", async () => {
    const initial = await deliverRecord(record(), [], async()=>({status:200}));
    let sent = 0;
    await deliverRecord(initial!, [blocked], async () => { sent++; return { status: 200 }; });
    expect(sent).toBe(1);
  });
  test("mute and completion preferences are enforced independently", () => {
    expect(notification({ ...registration, mutedSessions: [working.id] }, blocked, signalKey(working))).toBeUndefined();
    const done = { ...working, activity: "idle", lastTurnEndedAt: 3000 };
    expect(notification({ ...registration, completions: false }, done, signalKey(working))).toBeUndefined();
    expect(notification({ ...registration, completions: false }, { ...done, lastTurnFailed: true }, signalKey(working))).toBeDefined();
    expect(notification({ ...registration, enabled: false }, blocked, signalKey(working))).toBeUndefined();
  });
  test("the phone's chosen set names the bundled file; an app that sent no choice keeps the default sound", () => {
    const sound = (patch: Partial<MobileRegistration>, session = blocked) => notification({ ...registration, ...patch }, session, signalKey(working))!.payload.aps.sound;
    expect(sound({ sounds: "armonico" })).toBe("telar-armonico-needs.caf");
    expect(sound({})).toBe("default");
    const off = notification({ ...registration, sounds: "off" }, blocked, signalKey(working))!;
    expect(off.payload.aps.alert).toBeDefined();
    expect(off.payload.aps).not.toHaveProperty("sound");
  });
  test("on the phone only a request interrupts with a sound; a failure shows silently and a finish goes quietly to the notification centre", () => {
    const ended = { ...working, activity: "idle", lastTurnEndedAt: 3000 };
    const aps = (session: SessionSignal, patch: Partial<MobileRegistration> = {}) => notification({ ...registration, ...patch }, session, signalKey(working))!.payload.aps;
    for (const patch of [{}, { sounds: "felt" as const }]) {
      expect(aps(blocked, patch)).toMatchObject({ "interruption-level": "active", sound: expect.any(String) });
      expect(aps({ ...ended, lastTurnFailed: true }, patch)).toMatchObject({ "interruption-level": "active" });
      expect(aps({ ...ended, lastTurnFailed: true }, patch)).not.toHaveProperty("sound");
      expect(aps(ended, patch)).toMatchObject({ "interruption-level": "passive" });
      expect(aps(ended, patch)).not.toHaveProperty("sound");
    }
  });
  test("a registration carries its sound choice, and refuses one it doesn't know", () => {
    expect(parseRegistration({ ...registration, sounds: "hilo" }).sounds).toBe("hilo");
    expect(() => parseRegistration({ ...registration, sounds: "kazoo" })).toThrow();
  });
  test("failed delivery retries and successful delivery checkpoints", async () => {
    const initial = record(); initial.seen[working.id] = signalKey(working);
    const failed = await deliverRecord(initial, [blocked], async()=>({status:503}), 1000);
    expect(failed?.seen[working.id]).toBe(signalKey(working));
    let retries = 0;
    await deliverRecord(failed!, [blocked], async () => { retries++; return { status: 200 }; }, 1001);
    expect(retries).toBe(0);
    expect(failed?.retryAt).toBe(1030);
    const sent = await deliverRecord(failed!, [blocked], async()=>({status:200}), 1040);
    expect(sent?.seen[working.id]).toBe(signalKey(blocked));
    let count = 0;
    await deliverRecord(sent!, [blocked], async () => { count++; return { status: 200 }; });
    expect(count).toBe(0);
    expect(await deliverRecord(initial, [blocked], async()=>({status:410}))).toBeUndefined();
  });
  test("registrations are device scoped, private on disk, and preserve checkpoints", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "telar-push-")); const file = path.join(folder, "push.json");
    try {
      saveRegistration("one", registration, file);
      saveRegistration("two", registration, file);
      expect(readPushRecords(file).length).toBe(2);
      const revision = readPushRecords(file)[0].revision;
      saveRegistration("one", { ...registration, enabled: false }, file);
      const rows = readPushRecords(file);
      expect(rows.length).toBe(2);
      expect(rows.find(r => r.deviceId === "one")?.revision).not.toBe(revision);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  test("an upgrade finds the phones registered under the old doubled path, and writes the new one", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "telar-remote-"));
    const previous = { home: process.env.TELAR_HOME };
    process.env.TELAR_HOME = home;
    try {
      const legacy = legacyPushFile();
      mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
      writeFileSync(legacy, JSON.stringify([{ ...record(), deviceId: "from-the-old-path" }]), { mode: 0o600 });
      expect(pushFile()).not.toBe(legacy);
      expect(readPushRecords().map((row) => row.deviceId)).toEqual(["from-the-old-path"]);
      saveRegistration("newly-paired", registration);
      expect(existsSync(pushFile())).toBe(true);
      expect(existsSync(legacy)).toBe(true);
      expect(readPushRecords().map((row) => row.deviceId).sort()).toEqual(["from-the-old-path", "newly-paired"]);
    } finally {
      if (previous.home === undefined) delete process.env.TELAR_HOME;
      else process.env.TELAR_HOME = previous.home;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("an alert goes to the person only for what is theirs", () => {
  const ended = (patch: Partial<SessionSignal>): SessionSignal => ({ ...working, activity: "idle", activityAt: 3000, lastTurnEndedAt: 3000, ...patch });
  const alerted = (session: SessionSignal) => notification(registration, session, signalKey(working))?.payload.aps.alert;
  const row = (patch: Partial<LiveSessionRow>) => ({ id: "child", title: "Builder", activity: "idle", activityAt: 3000, lastTurnEndedAt: 3000, ...patch }) as LiveSessionRow;
  const task = (outcome?: SessionAssignment["outcome"]) => ({ taskRunId: "run_task", fromSessionId: "orchestrator", ...(outcome ? { outcome } : {}) }) as SessionAssignment;

  test("a turn the person or a schedule started alerts when it finishes or fails", () => {
    expect(alerted(ended({}))).toMatchObject({ body: ALERT_BODY.finished });
    expect(alerted(ended({ lastTurnOrigin: "user", lastTurnFailed: true }))).toMatchObject({ body: ALERT_BODY.failed });
    expect(alerted(ended({ lastTurnOrigin: "schedule" }))).toMatchObject({ body: ALERT_BODY.finished });
  });

  test("an orchestrator's wake, restart or provider turn alerts once nothing is left in flight", () => {
    for (const lastTurnOrigin of ["session", "restart", "provider"] as const) {
      expect(alerted(ended({ lastTurnOrigin }))).toMatchObject({ body: ALERT_BODY.finished });
      expect(alerted(ended({ lastTurnOrigin, lastTurnFailed: true }))).toMatchObject({ body: ALERT_BODY.failed });
    }
  });

  test("an orchestrator's wake turn stays silent while builders still work for it", () => {
    const [orchestrator] = signals([row({ id: "orchestrator", lastTurnOrigin: "session" }), row({})], { child: [task()] });
    expect(orchestrator.delegating).toBe(true);
    expect(alerted(orchestrator)).toBeUndefined();
    expect(alerted(ended({ lastTurnOrigin: "session", activity: "waiting" }))).toBeUndefined();
    expect(alerted(ended({ lastTurnOrigin: "session", activity: "scheduled" }))).toBeUndefined();
    const [done] = signals([row({ id: "orchestrator", lastTurnOrigin: "session" })], { child: [task("completed")] });
    expect(alerted(done)).toMatchObject({ body: ALERT_BODY.finished });
  });

  test("the person's turn followed straight away by a wake still reaches the Mac", () => {
    const state = { seen: { orchestrator: signalKey({ ...working, id: "orchestrator" }) }, baselined: true, offered: {} };
    const afterWake = { ...working, id: "orchestrator", activity: "idle", activityAt: 5000, lastTurnEndedAt: 5000, lastTurnOrigin: "session" as const };
    expect(desktopNotices(state, [afterWake], undefined).notices.map(n => n.kind)).toEqual(["finished"]);
  });

  test("a sub-session's finish or failure goes to its orchestrator, not the phone or the Mac", () => {
    const [started, tasked] = signals([row({ startedFrom: { sessionId: "orchestrator" } }), row({ id: "tasked" })], { tasked: [task()] });
    for (const child of [started, tasked]) {
      expect(alerted({ ...child, lastTurnOrigin: "user" })).toBeUndefined();
      expect(alerted({ ...child, lastTurnFailed: true })).toBeUndefined();
    }
    const seen = { seen: { child: signalKey(working) }, baselined: true, offered: {} };
    expect(desktopNotices(seen, [started], undefined).notices).toEqual([]);
  });

  test("a session the person took back from its orchestrator alerts again", () => {
    const [detached] = signals([row({})], { child: [task("detached")] });
    expect(detached.hasParent).toBeUndefined();
    expect(alerted(detached)).toMatchObject({ body: ALERT_BODY.finished });
  });

  test("a request parked for a person alerts from any session, sub-sessions included", () => {
    const [child] = signals([row({ activity: "blocked", startedFrom: { sessionId: "orchestrator" } })]);
    expect(alerted({ ...child, lastTurnOrigin: "session" })).toMatchObject({ body: ALERT_BODY.blocked });
    expect(desktopNotices({ ...emptyDesktopState(), baselined: true }, [child], undefined).notices.map(n => n.kind)).toEqual(["blocked"]);
  });
});
