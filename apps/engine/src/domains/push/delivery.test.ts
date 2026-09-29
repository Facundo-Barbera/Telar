import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTIVITY_STALE_S } from "./card";
import { ACTIVITY_REFRESH_S, isDeadToken, readPushRecords, saveRegistration, signalKey, writePushRecords, type Delivery, type DeliveryResult, type MobileRegistration, type PushRecord, type RelayCredential, type SessionSignal } from "./push";
import { relayV2Delivery } from "./relay-v2";
import { canReach, changedSessions, deliverRecord, heartbeatDue, heartbeatWanted, pauseHost, pushPausedUntil, PARK_AFTER_FAILURES, PARKED_TTL_MS, sendableRecords, stalePushRecords } from "./worker";

const registration: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "io.github.novarix.telar", sandbox: false,
  enabled: true, completions: true, previews: false, mutedSessions: [],
};
const working: SessionSignal = { id: "one", title: "A task", activity: "working", activityAt: 1000 };
const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
const other: SessionSignal = { id: "two", title: "Another task", activity: "working", activityAt: 1000 };
const otherBlocked: SessionSignal = { ...other, activity: "blocked", activityAt: 2000 };
const record = (patch: Partial<PushRecord> = {}): PushRecord => ({
  ...registration, deviceId: "paired", revision: "r1", updatedAt: 1000, baselined: true,
  seen: { [working.id]: signalKey(working), [other.id]: signalKey(other) }, activitySent: {}, ...patch,
});

describe("a rejected device token is dropped, never retried", () => {
  test("the four reasons Apple names, and the 410 it does not", async () => {
    for (const result of [
      { status: 410 },
      { status: 400, reason: "BadDeviceToken" },
      { status: 400, reason: "DeviceTokenNotForTopic" },
      { status: 400, reason: "Unregistered" },
      { status: 400, reason: "ExpiredToken" },
    ] as DeliveryResult[]) {
      expect(isDeadToken(result)).toBe(true);
      expect(await deliverRecord(record(), [blocked], async () => result, 5000)).toBeUndefined();
    }
  });

  test("a provider or relay refusal is transient, and never deletes a phone", async () => {
    for (const result of [
      { status: 403, reason: "ExpiredProviderToken" },
      { status: 400, reason: "PayloadTooLarge" },
      { status: 429, reason: "TooManyRequests" },
      { status: 503 },
      { status: 400, relay: true },
      { status: 401, relay: true },
      { status: 409, relay: true },
    ] as DeliveryResult[]) {
      expect(isDeadToken(result)).toBe(false);
      const next = await deliverRecord(record(), [blocked], async () => result, 5000);
      expect(next).toBeDefined();
      expect(next!.failures).toBe(1);
      expect(next!.parked).toBeUndefined();
    }
  });

  test("backoff runs 30s to an hour, and the last status is kept for Settings", async () => {
    let next = record();
    const seen: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const at = 10_000 + attempt * 10_000;
      next = (await deliverRecord(next, [blocked], async () => ({ status: 503, reason: "ServiceUnavailable" }), at))!;
      seen.push(next.retryAt! - at);
    }
    expect(seen.slice(0, 8)).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600]);
    expect(seen.every(delay => delay <= 3600)).toBe(true);
    expect(next.lastStatus).toBe(503);
    expect(next.lastReason).toBe("ServiceUnavailable");
  });

  test("twenty failures in a row parks the record until the phone registers again", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "telar-park-"));
    const file = path.join(folder, "push.json");
    try {
      let next = record();
      for (let attempt = 0; attempt < PARK_AFTER_FAILURES; attempt++) {
        next = (await deliverRecord(next, [blocked], async () => ({ status: 503 }), 10_000 + attempt * 4000))!;
      }
      expect(next.failures).toBe(PARK_AFTER_FAILURES);
      expect(next.parked).toBe(true);
      let sent = 0;
      await deliverRecord(next, [blocked], async () => { sent++; return { status: 200 }; }, 10_000_000);
      expect(sent).toBe(0);

      writePushRecords([next], file);
      saveRegistration("paired", registration, file);
      const revived = readPushRecords(file)[0]!;
      expect(revived.parked).toBeUndefined();
      expect(revived.failures).toBeUndefined();
      expect(revived.retryAt).toBeUndefined();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});

const credential: RelayCredential = { handle: "h".repeat(43), keyId: "k".repeat(22), sendKey: "s".repeat(43) };

describe("which records this Mac sends to", () => {
  test("a parked record is pruned once superseded or left for two weeks, and nothing else is", () => {
    const now = PARKED_TTL_MS * 2;
    const live = record({ deviceId: "phone", topic: "io.github.novarix.telar", updatedAt: 1 });
    const superseded = record({ deviceId: "phone", topic: "io.github.novarix.telar.dev", sandbox: true, parked: true, updatedAt: now });
    const abandoned = record({ deviceId: "gone", parked: true, updatedAt: now - PARKED_TTL_MS });
    const recent = record({ deviceId: "lonely", parked: true, updatedAt: now - 1000 });
    expect(stalePushRecords([live, superseded, abandoned, recent], now)).toEqual([superseded, abandoned]);
  });

  test("a record stamped by relay v1 still parses and is still served", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "telar-v1-"));
    const file = path.join(folder, "push.json");
    try {
      writeFileSync(file, JSON.stringify([{ ...record({ relay: credential }), relayHostId: "mac-one", relayRevision: "r0" }]));
      const [stamped] = readPushRecords(file);
      expect(stamped!.relay).toEqual(credential);
      expect(sendableRecords([stamped!], false)).toEqual([stamped!]);

      let sent = 0;
      const next = await deliverRecord(stamped!, [blocked, other], async () => { sent++; return { status: 200 }; }, 5000);
      expect(sent).toBe(1);
      expect(next!.failures).toBe(0);
      writePushRecords([next!], file);
      expect(readPushRecords(file)[0]!.seen[working.id]).toBe(signalKey(blocked));

      saveRegistration("paired", { ...registration, relay: credential }, file);
      expect(Object.keys(readPushRecords(file)[0]!)).not.toContain("relayHostId");
      expect(Object.keys(readPushRecords(file)[0]!)).not.toContain("relayRevision");
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test("a phone with no relay credential is sent nothing unless this Mac has a direct key", () => {
    const unregistered = record({ deviceId: "phone-a" });
    const registered = record({ deviceId: "phone-b", relay: credential });
    expect(canReach(unregistered, false)).toBe(false);
    expect(sendableRecords([unregistered, registered], false)).toEqual([registered]);
    expect(sendableRecords([unregistered, registered], true)).toEqual([unregistered, registered]);
    expect(sendableRecords([record({ relay: credential, parked: true })], true)).toEqual([]);
  });
});

describe("waking on what moved, not on a timer", () => {
  test("an event evaluates exactly the session it is about", async () => {
    let sent = 0;
    const send = async (delivery: Delivery) => { sent++; expect(delivery.payload.url).toContain(other.id); return { status: 200 } as DeliveryResult; };
    const next = await deliverRecord(record(), [blocked, otherBlocked], send, 5000, { changed: new Set([other.id]) });
    expect(sent).toBe(1);
    expect(next!.seen[working.id]).toBe(signalKey(working));
    expect(next!.seen[other.id]).toBe(signalKey(otherBlocked));
  });

  test("a quiet hour makes no calls at all", async () => {
    let sent = 0;
    const send = async () => { sent++; return { status: 200 } as DeliveryResult; };
    expect(changedSessions([working, other], [working, other]).size).toBe(0);
    await deliverRecord(record(), [working, other], send, 5000, { changed: new Set<string>() });
    expect(sent).toBe(0);
  });

  test("a session this record has never seen is still baselined", async () => {
    let sent = 0;
    const fresh = record({ seen: {} });
    const next = await deliverRecord(fresh, [working], async () => { sent++; return { status: 200 }; }, 5000, { changed: new Set<string>() });
    expect(sent).toBe(0);
    expect(next!.seen[working.id]).toBe(signalKey(working));
  });

  test("changedSessions names what moved, and what is new", () => {
    expect([...changedSessions([blocked, other], [working, other])]).toEqual([working.id]);
    expect([...changedSessions([working, other], [working])]).toEqual([other.id]);
    expect([...changedSessions([working], undefined)]).toEqual([working.id]);
  });

  test("the heartbeat runs while the host card shows work, or waits to be closed, every two minutes", () => {
    const idle = record();
    const withCard = record({ liveActivities: true, card: { token: "d".repeat(64), startedAt: 1 } });
    expect(heartbeatDue([idle], [working], undefined, 120_000)).toBe(false);
    expect(heartbeatDue([withCard], [{ ...working, activity: "idle" }], undefined, 120_000)).toBe(false);
    expect(heartbeatDue([withCard], [working], undefined, 120_000)).toBe(true);
    expect(heartbeatDue([withCard], [working], 60_000, 120_000)).toBe(false);
    expect(heartbeatDue([withCard], [working], 0, 120_000)).toBe(true);
    expect(heartbeatWanted([{ ...withCard, cardFinishedAt: 1 }], [])).toBe(true);
    expect(ACTIVITY_REFRESH_S * 2).toBeLessThan(ACTIVITY_STALE_S);
  });
});

describe("the relay's daily budget is honoured, not discovered per push", () => {
  test("a 429 carries Retry-After through to the pause Settings shows", async () => {
    const fetchImpl = (async () => Response.json({ error: "daily_budget" }, { status: 429, headers: { "retry-after": "3600" } })) as unknown as typeof fetch;
    const result = await relayV2Delivery(credential, { token: registration.token, topic: registration.topic, sandbox: false, kind: "alert", collapseId: "c".repeat(64), payload: { aps: { alert: "Test" } } }, fetchImpl);
    expect(result).toMatchObject({ status: 429, relay: true, retryAfter: 3600 });
  });

  test("once the budget is spent, the rest of a record's sends cost nothing", async () => {
    let sent = 0;
    const next = await deliverRecord(record(), [blocked, otherBlocked], async () => {
      sent++;
      return { status: 429, relay: true, retryAfter: 3600 };
    }, 5000);
    expect(sent).toBe(1);
    expect(next!.failures).toBe(1);
  });

  test("the pause expires on its own", () => {
    const now = 1_000_000;
    pauseHost(60, now);
    expect(pushPausedUntil(now)).toBe(now + 60_000);
    expect(pushPausedUntil(now + 60_001)).toBeUndefined();
    expect(pushPausedUntil(now)).toBeUndefined();
  });
});
