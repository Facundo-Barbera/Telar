// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeadToken, readPushRecords, saveRegistration, signalKey, writePushRecords, type Delivery, type DeliveryResult, type MobileRegistration, type PushRecord, type SessionSignal } from "./push";
import { relayDelivery } from "./relay";
import { changedSessions, deliverRecord, heartbeatDue, ownRecords, pauseHost, pushPausedUntil, PARK_AFTER_FAILURES } from "./worker";

/**
 * THE QUOTA FAILURE, COVERED — issue #584.
 *
 * One Mac made 173,000 relay invocations in a day and exhausted the Cloudflare
 * account's free quota, which took the desktop updater down with it. Four
 * things caused it and each has a test here: rejected tokens were retried for
 * ever, every push was two calls, two Macs served the same phones, and the
 * worker woke every five seconds to fold every session and find nothing.
 */

const registration: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "com.telar.mobile", sandbox: false,
  enabled: true, completions: true, previews: false, mutedSessions: [], activities: [],
};
const working: SessionSignal = { id: "one", title: "A task", activity: "working", activityAt: 1000 };
const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
const other: SessionSignal = { id: "two", title: "Another task", activity: "working", activityAt: 1000 };
const otherBlocked: SessionSignal = { ...other, activity: "blocked", activityAt: 2000 };
/** Baselined, so a signal that moves is an alert rather than a first sight. */
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
      // The record goes. The phone re-registers on its next open; pairing is untouched.
      expect(await deliverRecord(record(), [blocked], async () => result, 5000)).toBeUndefined();
    }
  });

  test("a provider or relay refusal is transient, and never deletes a phone", async () => {
    for (const result of [
      // 403/ExpiredProviderToken is the RELAY's signing key, not this phone. Treating
      // it as terminal would delete every record on the Mac the hour a key rotated.
      { status: 403, reason: "ExpiredProviderToken" },
      { status: 400, reason: "PayloadTooLarge" },
      { status: 429, reason: "TooManyRequests" },
      { status: 503 },
      // Everything the relay itself answers, including a 400 that would otherwise
      // read as Apple's verdict on the token.
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
    // Capped at an hour: 24 attempts a day for a phone that is never coming back,
    // against the 288 the old five-minute ceiling allowed.
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
        // Each pass is taken past its own backoff, or the retry gate would swallow it.
        next = (await deliverRecord(next, [blocked], async () => ({ status: 503 }), 10_000 + attempt * 4000))!;
      }
      expect(next.failures).toBe(PARK_AFTER_FAILURES);
      expect(next.parked).toBe(true);
      // Parked means parked: not one more call, however long it waits.
      let sent = 0;
      await deliverRecord(next, [blocked], async () => { sent++; return { status: 200 }; }, 10_000_000);
      expect(sent).toBe(0);

      // A fresh registration is the way back, and it is what opening the app does.
      writePushRecords([next], file);
      saveRegistration("paired", registration, file, undefined);
      const revived = readPushRecords(file)[0]!;
      expect(revived.parked).toBeUndefined();
      expect(revived.failures).toBeUndefined();
      expect(revived.retryAt).toBeUndefined();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});

describe("a push is one relay call", () => {
  const config = { url: "https://relay.example", token: "b".repeat(64) };
  const delivery: Delivery = { token: registration.token, topic: registration.topic, sandbox: false, kind: "alert", collapseId: "c".repeat(64), payload: { aps: { alert: "Test" } } };

  test("N pushes on one revision are 1 PUT and N POSTs", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    try {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(String(init?.method));
        return Response.json(init?.method === "POST" ? { status: 200 } : {});
      }) as typeof fetch;
      let held: PushRecord = record();
      for (let push = 0; push < 5; push++) {
        const result = await relayDelivery(config, held, delivery);
        expect(result.status).toBe(200);
        if (result.registered) held = { ...held, relayRevision: held.revision };
      }
      // This was 5 PUTs and 5 POSTs, which is most of the invocation count (#584).
      expect(calls).toEqual(["PUT", "POST", "POST", "POST", "POST", "POST"]);

      // A new revision — the phone changed a preference — is registered once more.
      calls.length = 0;
      await relayDelivery(config, { ...held, revision: "r2" }, delivery);
      expect(calls).toEqual(["PUT", "POST"]);
    } finally { globalThis.fetch = original; }
  });

  test("the relay's 24h registration expiry is re-registered once, then the push retried", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    try {
      let expired = true;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(String(init?.method));
        if (init?.method === "PUT") { expired = false; return Response.json({}); }
        // The relay drops a registration after 24 hours and answers 409.
        if (expired) return Response.json({ error: "expired" }, { status: 409 });
        return Response.json({ status: 200 });
      }) as typeof fetch;
      const result = await relayDelivery(config, record({ relayRevision: "r1" }), delivery);
      expect(result).toEqual({ status: 200, registered: true });
      expect(calls).toEqual(["POST", "PUT", "POST"]);
    } finally { globalThis.fetch = original; }
  });

  test("a relay that keeps answering 409 is given up on, not looped", async () => {
    const original = globalThis.fetch;
    let posts = 0;
    try {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PUT") return Response.json({});
        posts++;
        return Response.json({ error: "expired" }, { status: 409 });
      }) as typeof fetch;
      const result = await relayDelivery(config, record({ relayRevision: "r1" }), delivery);
      expect(result).toEqual({ status: 409, relay: true, registered: true });
      expect(posts).toBe(2);
    } finally { globalThis.fetch = original; }
  });
});

describe("one Mac per phone", () => {
  test("two Macs, one record each: each sends only its own", () => {
    const mine = record({ deviceId: "phone-a", relayHostId: "mac-one" });
    const theirs = record({ deviceId: "phone-b", relayHostId: "mac-two" });
    const records = [mine, theirs];
    expect(ownRecords(records, "mac-one")).toEqual([mine]);
    expect(ownRecords(records, "mac-two")).toEqual([theirs]);
    // AND NEITHER DELETES THE OTHER'S. Both Macs read the same file; a Mac that
    // swept what it does not own would take the other one's phone away.
    expect(records).toHaveLength(2);
  });

  test("a Mac with no relay id serves the records that carry none, and no others", () => {
    const unstamped = record({ deviceId: "phone-a" });
    const stamped = record({ deviceId: "phone-b", relayHostId: "mac-two" });
    expect(ownRecords([unstamped, stamped], undefined)).toEqual([unstamped]);
  });

  test("a registration is stamped with the Mac it arrived at", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "telar-host-"));
    const file = path.join(folder, "push.json");
    try {
      saveRegistration("paired", registration, file, "mac-one");
      expect(readPushRecords(file)[0]!.relayHostId).toBe("mac-one");
      // `hostId` is the PHONE's own UUID for this Mac and is the same value in
      // both copies of the file, which is why it cannot be what decides this.
      expect(readPushRecords(file)[0]!.hostId).toBe(registration.hostId);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});

describe("waking on what moved, not on a timer", () => {
  test("an event evaluates exactly the session it is about", async () => {
    let sent = 0;
    const send = async (delivery: Delivery) => { sent++; expect(delivery.payload.url).toContain(other.id); return { status: 200 } as DeliveryResult; };
    // Both sessions moved in the store's eyes, but only one is what woke us.
    const next = await deliverRecord(record(), [blocked, otherBlocked], send, 5000, { changed: new Set([other.id]) });
    expect(sent).toBe(1);
    // The one that was not evaluated keeps its checkpoint, so it alerts when its
    // own event arrives rather than being silently folded away.
    expect(next!.seen[working.id]).toBe(signalKey(working));
    expect(next!.seen[other.id]).toBe(signalKey(otherBlocked));
  });

  test("a quiet hour makes no calls at all", async () => {
    let sent = 0;
    const send = async () => { sent++; return { status: 200 } as DeliveryResult; };
    // Nothing moved: an empty change set, which is what an unchanged read yields.
    expect(changedSessions([working, other], [working, other]).size).toBe(0);
    await deliverRecord(record(), [working, other], send, 5000, { changed: new Set<string>() });
    expect(sent).toBe(0);
  });

  test("a session this record has never seen is still baselined", async () => {
    let sent = 0;
    const fresh = record({ seen: {} });
    // Not in the change set, but not in `seen` either — it must be checkpointed,
    // or its first real transition would be read as a first sight and stay silent.
    const next = await deliverRecord(fresh, [working], async () => { sent++; return { status: 200 }; }, 5000, { changed: new Set<string>() });
    expect(sent).toBe(0);
    expect(next!.seen[working.id]).toBe(signalKey(working));
  });

  test("changedSessions names what moved, and what is new", () => {
    expect([...changedSessions([blocked, other], [working, other])]).toEqual([working.id]);
    expect([...changedSessions([working, other], [working])]).toEqual([other.id]);
    expect([...changedSessions([working], undefined)]).toEqual([working.id]);
  });

  test("the 60s heartbeat runs only for a registered Live Activity with live work", () => {
    const idle = record();
    const withActivity = record({ liveActivities: true, activities: [{ sessionId: working.id, token: "d".repeat(64), startedAt: 1 }] });
    // No Live Activity: nothing wakes on a quiet tick, which is what makes a
    // quiet hour cost zero relay calls.
    expect(heartbeatDue([idle], [working], undefined, 60_000)).toBe(false);
    // Registered, but nothing is running — a card with no work behind it is over.
    expect(heartbeatDue([withActivity], [{ ...working, activity: "idle" }], undefined, 60_000)).toBe(false);
    expect(heartbeatDue([withActivity], [working], undefined, 60_000)).toBe(true);
    // And not more often than once a minute.
    expect(heartbeatDue([withActivity], [working], 30_000, 60_000)).toBe(false);
    expect(heartbeatDue([withActivity], [working], 0, 60_000)).toBe(true);
  });
});

describe("the relay's daily budget is honoured, not discovered per push", () => {
  test("a 429 carries Retry-After through to the pause Settings shows", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
        init?.method === "PUT" ? Response.json({}) : Response.json({ error: "daily_budget" }, { status: 429, headers: { "retry-after": "3600" } })) as typeof fetch;
      const result = await relayDelivery({ url: "https://relay.example", token: "b".repeat(64) }, record(), { token: registration.token, topic: registration.topic, sandbox: false, kind: "alert", collapseId: "c".repeat(64), payload: { aps: { alert: "Test" } } });
      expect(result).toMatchObject({ status: 429, relay: true, retryAfter: 3600 });
    } finally { globalThis.fetch = original; }
  });

  test("once the budget is spent, the rest of a record's sends cost nothing", async () => {
    let sent = 0;
    const next = await deliverRecord(record(), [blocked, otherBlocked], async () => {
      sent++;
      return { status: 429, relay: true, retryAfter: 3600 };
    }, 5000);
    // Two sessions had something to say; the relay was asked once and believed.
    expect(sent).toBe(1);
    expect(next!.failures).toBe(1);
  });

  test("the pause expires on its own", () => {
    const now = 1_000_000;
    pauseHost(60, now);
    expect(pushPausedUntil(now)).toBe(now + 60_000);
    expect(pushPausedUntil(now + 60_001)).toBeUndefined();
    // …and reading it past its end clears it, so nothing stays paused for ever.
    expect(pushPausedUntil(now)).toBeUndefined();
  });
});
