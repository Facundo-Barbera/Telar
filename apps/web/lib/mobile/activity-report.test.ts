/**
 * WHY NO CARD APPEARED — what the Mac tells the phone about its automatic
 * Live Activity.
 *
 * Apple answers 200 for a push-to-start that iOS then drops, so "accepted,
 * and no card came back" has to be said as itself: it is the one case that
 * looks exactly like success from here.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activityLine } from "../../components/settings/push-notifications-group";
import { PUT as pushPUT } from "../../app/api/mobile/push/route";
import { addDevice, mintDeviceToken } from "../remote/store";
import { AUTOMATIC_ACTIVITY, AUTOMATIC_START_ATTEMPTS, activityReport, type PushRecord } from "./push";
import { deliverRecord } from "./worker";

const record = (patch: Partial<PushRecord> = {}): PushRecord => ({
  hostId: "12345678-1234-1234-1234-123456789abc", hostName: "Studio", token: "a".repeat(64), pushToStartToken: "b".repeat(64),
  topic: "com.telar.mobile", sandbox: false, enabled: false, completions: false, previews: false, liveActivities: true,
  mutedSessions: [], activities: [], deviceId: "phone", revision: "r1", updatedAt: 0, seen: {}, activitySent: {}, ...patch,
});
const work = { id: "one", title: "Private task", activity: "working", activityAt: 1 };

describe("the report", () => {
  test("names each cause of a missing card", () => {
    expect(activityReport(record({ liveActivities: false })).blocker).toBe("off");
    expect(activityReport(record({ pushToStartToken: undefined })).blocker).toBe("no-start-token");
    expect(activityReport(record({ automaticStarts: AUTOMATIC_START_ATTEMPTS })).blocker).toBe("gave-up");
    expect(activityReport(record())).toEqual({ card: false });
  });

  test("a running card is a running card, whatever the attempt count", () => {
    const running = record({ automaticStarts: AUTOMATIC_START_ATTEMPTS, activities: [{ sessionId: AUTOMATIC_ACTIVITY, token: "c".repeat(64), startedAt: 1 }] });
    expect(activityReport(running)).toEqual({ card: true });
  });

  test("every start is recorded with what came back, accepted or refused", async () => {
    let next = (await deliverRecord(record(), [work], async () => ({ status: 200 }), 1000))!;
    expect(activityReport(next).lastStart).toEqual({ at: 1000, status: 200, relay: false });
    next = (await deliverRecord(record(), [work], async () => ({ status: 400, reason: "BadDeviceToken" }), 2000))!;
    expect(activityReport(next).lastStart).toEqual({ at: 2000, status: 400, reason: "BadDeviceToken", relay: false });
    next = (await deliverRecord(record(), [work], async () => ({ status: 409, relay: true }), 3000))!;
    expect(activityReport(next).lastStart).toMatchObject({ status: 409, relay: true });
  });
});

describe("in the Mac's own Settings", () => {
  test("an accepted start with no card says iOS dropped it, not that it worked", () => {
    expect(activityLine({ card: false, lastStart: { at: 1, status: 200, relay: false } })).toBe("Apple accepted the last start, but no card appeared on the phone");
    expect(activityLine({ card: false, lastStart: { at: 1, status: 400, reason: "TopicDisallowed", relay: false } })).toBe("Apple refused the last start (400 TopicDisallowed)");
    expect(activityLine({ card: false, lastStart: { at: 1, status: 401, relay: true } })).toBe("relay refused the last start (401)");
    expect(activityLine({ card: true })).toBe("card running");
    expect(activityLine({ card: false, blocker: "no-start-token" })).toContain("no push-to-start token");
    expect(activityLine({ card: false })).toBeUndefined();
  });
});

describe("to the phone", () => {
  const old = { home: process.env.TELAR_HOME, cockpit: process.env.TELAR_COCKPIT };
  let folder: string | undefined;
  afterEach(() => {
    for (const [name, value] of [["TELAR_HOME", old.home], ["TELAR_COCKPIT", old.cockpit]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
    delete (globalThis as { telarMobilePushTimer?: unknown }).telarMobilePushTimer;
  });

  test("the registration reply carries the report, so the phone can say why", async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "telar-activity-"));
    process.env.TELAR_HOME = folder;
    process.env.TELAR_COCKPIT = "1";
    // A timer already set is how `startMobilePushWorker` knows one runs: none starts here.
    (globalThis as { telarMobilePushTimer?: unknown }).telarMobilePushTimer = setTimeout(() => {}, 0);
    const token = mintDeviceToken();
    addDevice("Phone", token);
    const { deviceId: _, revision: __, updatedAt: ___, seen: ____, activitySent: _____, ...registration } = record({ pushToStartToken: undefined });
    const answer = await pushPUT(new Request("http://localhost/api/mobile/push", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(registration) }));
    expect(await answer.json()).toEqual({ configured: false, activity: { card: false, blocker: "no-start-token" } });
  });
});
