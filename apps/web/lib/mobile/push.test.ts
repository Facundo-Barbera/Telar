// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { activityDelivery, legacyPushFile, notification, parseRegistration, pushFile, readPushRecords, saveRegistration, signalKey, type MobileRegistration, type PushRecord, type SessionSignal } from "./push";
import { deliverRecord } from "./worker";

const registration: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "com.telar.mobile", sandbox: true,
  enabled: true, completions: true, previews: false, mutedSessions: [], activities: [],
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
  test("failed delivery retries and successful delivery checkpoints", async () => {
    const initial = record(); initial.seen[working.id] = signalKey(working);
    const failed = await deliverRecord(initial, [blocked], async()=>({status:503}), 1000);
    expect(failed?.seen[working.id]).toBe(signalKey(working));
    let retries = 0;
    await deliverRecord(failed!, [blocked], async () => { retries++; return { status: 200 }; }, 1001);
    expect(retries).toBe(0);
    // Thirty seconds, not five: a retry floor that cost 173k relay calls a day (#584).
    expect(failed?.retryAt).toBe(1030);
    const sent = await deliverRecord(failed!, [blocked], async()=>({status:200}), 1040);
    expect(sent?.seen[working.id]).toBe(signalKey(blocked));
    let count = 0;
    await deliverRecord(sent!, [blocked], async () => { count++; return { status: 200 }; });
    expect(count).toBe(0);
    expect(await deliverRecord(initial, [blocked], async()=>({status:410}))).toBeUndefined();
  });
  test("Live Activity uses the widget contract, separate topic and ends on completion", async () => {
    const follow = { sessionId: working.id, token: "b".repeat(64), startedAt: 1800000000 };
    const r = { ...record(), activities: [follow] };
    const payload = activityDelivery(r, follow, working, 1800000060);
    expect(payload.topic).toBe("com.telar.mobile.push-type.liveactivity");
    expect(payload.payload.aps.event).toBe("update");
    expect(payload.payload.aps["content-state"]).toMatchObject({ title: "Telar session", updatedAt: 821692860, ended: false });
    expect(activityDelivery(r, follow, undefined, 1800000060).payload.aps.event).toBe("end");
    const ended = await deliverRecord(r, [{ ...working, activity: "idle" }], async()=>({status:200}), 1800000060);
    expect(ended?.activities).toEqual([]);
  });
  test("a turn that ended into waiting or a schedule is finished; background work is named as such", async () => {
    const follow = { sessionId: working.id, token: "b".repeat(64), startedAt: 1800000000 };
    const r = { ...record(), activities: [follow] };
    for (const activity of ["waiting", "scheduled"] as const) {
      expect(activityDelivery(r, follow, { ...working, activity }, 1800000060).payload.aps.event).toBe("end");
      expect((await deliverRecord(r, [{ ...working, activity }], async()=>({status:200}), 1800000060))?.activities).toEqual([]);
    }
    expect(activityDelivery(r, follow, { ...working, activity: "monitoring" }, 1800000060).payload.aps["content-state"]).toMatchObject({ status: "Background", ended: false });
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
  /**
   * THE DOUBLED PATH, AND WHY THE READ STILL LOOKS THERE — issue #665.
   *
   * `remoteHome()` is already `<TELAR_HOME>/remote`, and `pushFile()` joined
   * `"remote"` onto it again, so every install with a phone registered grew a
   * `remote/remote/` directory nobody intended. Moving the file without reading
   * the old one would un-register somebody's phone on upgrade: notifications
   * would simply stop, with nothing on screen to say why.
   *
   * ASSERTED ON THE RECORDS, NOT ON A PATH. A test that compared two strings
   * would pass on a build that read the legacy file and never wrote the new
   * one — which is the half that actually migrates.
   */
  test("an upgrade finds the phones registered under the old doubled path, and writes the new one", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "telar-remote-"));
    // `remoteHome()` refuses outside the cockpit — ordinary web mode has no
    // pairing store at all — so the scratch home needs both variables.
    const previous = { home: process.env.TELAR_HOME, cockpit: process.env.TELAR_COCKPIT };
    process.env.TELAR_HOME = home;
    process.env.TELAR_COCKPIT = "1";
    try {
      const legacy = legacyPushFile();
      mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
      writeFileSync(legacy, JSON.stringify([{ ...record(), deviceId: "from-the-old-path" }]), { mode: 0o600 });
      expect(pushFile()).not.toBe(legacy);
      // Read through the default path: the new file does not exist yet.
      expect(readPushRecords().map((row) => row.deviceId)).toEqual(["from-the-old-path"]);
      // The next write lands on the new path, and the old file is left alone —
      // a delete performed on a read path is how a downgrade becomes data loss.
      saveRegistration("newly-paired", registration);
      expect(existsSync(pushFile())).toBe(true);
      expect(existsSync(legacy)).toBe(true);
      // And from then on the new file is authoritative: both records are there,
      // read from it rather than from the legacy one.
      expect(readPushRecords().map((row) => row.deviceId).sort()).toEqual(["from-the-old-path", "newly-paired"]);
    } finally {
      if (previous.home === undefined) delete process.env.TELAR_HOME;
      else process.env.TELAR_HOME = previous.home;
      if (previous.cockpit === undefined) delete process.env.TELAR_COCKPIT;
      else process.env.TELAR_COCKPIT = previous.cockpit;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
