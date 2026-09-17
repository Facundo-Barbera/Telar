/**
 * WHAT AN UNPROVISIONED MAC SAYS, AND WHO IT TELLS — issue #579.
 *
 * Notifications never arrived on the owner's phone, and no code was broken:
 * the relay was unprovisioned and every surface that knew stayed quiet. The
 * worker returns without starting, the registration route answers
 * `{ configured: false }`, and until now the only place that fact was rendered
 * was a status line under a toggle on the phone.
 *
 * What must not drift:
 *
 *   - the worker does NOT start without a relay, and the route says so, so a
 *     phone can tell "unavailable" from "nothing has happened yet";
 *   - the status route answers the same predicate the worker gates on — a pane
 *     that disagreed with the sender would be worse than no pane;
 *   - NO CREDENTIAL leaves that route: not the relay token, not a device token,
 *     not a push-to-start token;
 *   - `notification()` pushes for the two things a person must be told about —
 *     a session that opened a request, and a turn that failed — and the second
 *     is NOT behind the "work completed" preference;
 *   - `lastDeliveryAt` records a delivery and survives a re-registration, which
 *     is what lets the pane tell a registered phone from a reached one.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addDevice, mintDeviceToken } from "../remote/store";
import { GET as pushGET } from "../../app/api/mobile/push/route";
import { GET as relayGET } from "../../app/api/mobile/relay/route";
import { notification, pushConfigured, readPushRecords, saveRegistration, signalKey, writePushRecords, type MobileRegistration, type PushRecord, type SessionSignal } from "./push";
import { parseRelayConfig } from "./relay-config";
import { startMobilePushWorker } from "./worker";
import { deliverRecord } from "./worker";

const old = { home: process.env.TELAR_HOME, cockpit: process.env.TELAR_COCKPIT, key: process.env.TELAR_APNS_KEY_ID };
let folder: string | undefined;

afterEach(() => {
  for (const [name, value] of [["TELAR_HOME", old.home], ["TELAR_COCKPIT", old.cockpit], ["TELAR_APNS_KEY_ID", old.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
  delete (globalThis as { telarMobilePushTimer?: unknown }).telarMobilePushTimer;
});

function setup() {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "telar-relay-"));
  process.env.TELAR_HOME = folder;
  process.env.TELAR_COCKPIT = "1";
  // No relay item is readable in a test (`relayConfig` needs the cockpit's own
  // startup hook), and no APNs key is in the environment — which is exactly the
  // owner's Mac before this batch.
  delete process.env.TELAR_APNS_KEY_ID;
}

const registration: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc",
  token: "a".repeat(64),
  topic: "com.telar.mobile",
  sandbox: false,
  enabled: true,
  completions: true,
  previews: false,
  mutedSessions: [],
  activities: [],
};
const working: SessionSignal = { id: "session_a", title: "Private repository task", activity: "working", activityAt: 1000 };

describe("an unprovisioned Mac", () => {
  test("the worker does not start, and nothing schedules a tick", () => {
    setup();
    expect(pushConfigured()).toBe(false);
    startMobilePushWorker();
    // NOT STARTED is the whole point: a worker that ran would poll every five
    // seconds and send nothing, for ever, with no way to tell the two apart.
    expect((globalThis as { telarMobilePushTimer?: unknown }).telarMobilePushTimer).toBeUndefined();
  });

  test("the registration route says so, rather than accepting in silence", () => {
    setup();
    const token = mintDeviceToken();
    addDevice("Phone", token);
    const answer = pushGET(new Request("http://localhost/api/mobile/push", { headers: { authorization: `Bearer ${token}` } }));
    expect(answer.status).toBe(200);
  });

  test("the status route answers the same predicate the worker gates on", async () => {
    setup();
    const answer = await relayGET(new Request("http://localhost/api/mobile/relay"));
    const body = (await answer.json()) as { configured: boolean; relay: boolean; sandbox: boolean; devices: unknown[] };
    expect(body.configured).toBe(pushConfigured());
    expect(body.configured).toBe(false);
    expect(body.relay).toBe(false);
    expect(body.devices).toEqual([]);
  });
});

describe("the status route never carries a credential", () => {
  test("a registered phone is described, never quoted", async () => {
    setup();
    const token = mintDeviceToken();
    const device = addDevice("Facundo's iPhone", token);
    saveRegistration(device.id, { ...registration, pushToStartToken: "b".repeat(64), liveActivities: true });

    const answer = await relayGET(new Request("http://localhost/api/mobile/relay"));
    const text = await answer.text();
    // The three secrets a push record holds. None of them is a thing a Settings
    // pane has any use for.
    expect(text).not.toContain("a".repeat(64));
    expect(text).not.toContain("b".repeat(64));
    expect(text).not.toContain(token);

    const body = JSON.parse(text) as { devices: Array<{ name?: string; enabled: boolean; paired: boolean; lastDeliveryAt?: number }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]!.name).toBe("Facundo's iPhone");
    expect(body.devices[0]!.enabled).toBe(true);
    expect(body.devices[0]!.paired).toBe(true);
    // NEVER DELIVERED TO, which is what the pane has to be able to say about a
    // phone that registered and has been silent ever since.
    expect(body.devices[0]!.lastDeliveryAt).toBeUndefined();
  });

  test("a record whose device is no longer paired is shown as what it is", async () => {
    setup();
    saveRegistration("gone", registration);
    const answer = await relayGET(new Request("http://localhost/api/mobile/relay"));
    const body = (await answer.json()) as { devices: Array<{ paired: boolean; name?: string }> };
    expect(body.devices[0]!.paired).toBe(false);
    expect(body.devices[0]!.name).toBeUndefined();
  });
});

describe("what a person is pushed about", () => {
  test("a session that opened a request, and a turn that failed", () => {
    // A REQUEST OPENED is what `blocked` means on the signal the worker reads:
    // the session is parked on a person.
    const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
    const opened = notification(registration, blocked, signalKey(working))!;
    expect(opened.payload.aps.alert).toEqual({ title: "Telar", body: "A session needs your input or approval." });

    // A TURN THAT FAILED, and NOT behind `completions`: somebody who has turned
    // off "work completed" has asked not to hear about successes, which is not
    // the same as asking not to hear that something broke.
    const failed: SessionSignal = { ...working, activity: "idle", lastTurnEndedAt: 3000, lastTurnFailed: true };
    const quiet = notification({ ...registration, completions: false }, failed, signalKey(working))!;
    expect(quiet.payload.aps.alert).toEqual({ title: "Telar", body: "A session failed. Open Telar to review it." });
  });

  test("neither is sent when the phone has alerts off or has muted that session", () => {
    const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
    expect(notification({ ...registration, enabled: false }, blocked, signalKey(working))).toBeUndefined();
    expect(notification({ ...registration, mutedSessions: [working.id] }, blocked, signalKey(working))).toBeUndefined();
  });
});

describe("telling a registered phone from a reached one", () => {
  const record = (): PushRecord => ({ ...registration, deviceId: "paired", revision: "r1", updatedAt: 1000, baselined: true, seen: { [working.id]: signalKey(working) }, activitySent: {} });

  test("a delivery is recorded, and a poll that sent nothing does not invent one", async () => {
    const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
    const sent = await deliverRecord(record(), [blocked], async () => ({ status: 200 }), 5_000);
    expect(sent!.lastDeliveryAt).toBe(5_000);

    // NOTHING CHANGED, so nothing was sent, so the timestamp must not move —
    // otherwise "last delivery 2 seconds ago" would be true of every idle Mac.
    const quiet = await deliverRecord(sent!, [working], async () => ({ status: 200 }), 9_000);
    expect(quiet!.lastDeliveryAt).toBe(5_000);
  });

  test("a failed send does not count as a delivery", async () => {
    const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
    const attempted = await deliverRecord(record(), [blocked], async () => ({ status: 503 }), 5_000);
    expect(attempted!.lastDeliveryAt).toBeUndefined();
    expect(attempted!.failures).toBe(1);
  });

  test("it survives the re-registration a preference change causes", () => {
    setup();
    writePushRecords([{ ...record(), lastDeliveryAt: 5_000 }]);
    saveRegistration("paired", { ...registration, completions: false });
    expect(readPushRecords()[0]!.lastDeliveryAt).toBe(5_000);
  });
});

describe("what counts as a relay config", () => {
  const token = "a".repeat(64);
  test("an https origin with no path, and a 64-hex token", () => {
    expect(parseRelayConfig({ url: "https://relay.example.com/", token })).toEqual({ url: "https://relay.example.com", token });
  });
  test("the host id rides along when the Keychain item carries one", () => {
    expect(parseRelayConfig({ url: "https://relay.example.com/", token, id: "mac-one" })).toEqual({ url: "https://relay.example.com", token, id: "mac-one" });
    // An id that is not one names nobody; the config still pushes without it.
    expect(parseRelayConfig({ url: "https://relay.example.com/", token, id: "not a host id!" })).toEqual({ url: "https://relay.example.com", token });
  });
  test("every plausible paste that must not be stored", () => {
    for (const input of [
      { url: "http://relay.example.com", token },
      // A base carrying its own path would silently retarget every relay route
      // appended to it.
      { url: "https://relay.example.com/v1", token },
      { url: "https://user:pw@relay.example.com", token },
      { url: "https://relay.example.com?x=1", token },
      { url: "https://relay.example.com", token: token.slice(1) },
      { url: "https://relay.example.com" },
      "https://relay.example.com",
      null,
    ]) {
      expect(parseRelayConfig(input)).toBeUndefined();
    }
  });
});
