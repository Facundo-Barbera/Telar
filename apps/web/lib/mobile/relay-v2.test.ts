/**
 * THE MAC'S HALF OF RELAY v2.
 *
 * What must not drift:
 *
 *   - a phone's relay credential is kept when well formed and DROPPED, not
 *     refused, when not, so the rest of the registration still works on v1;
 *   - a send is signed over exactly the bytes sent, goes to the compiled-in
 *     relay and names WHAT to send, never a device token or a topic;
 *   - a new key earns one test alert, and its outcome is what Settings shows;
 *   - the status route never carries the send key or the handle;
 *   - a Mac with nothing provisioned still starts pushing for a v2 phone.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addDevice, mintDeviceToken } from "../remote/store";
import { PUT as pushPUT } from "../../app/api/mobile/push/route";
import { GET as relayGET } from "../../app/api/mobile/relay/route";
import { activityDelivery, automaticActivityDelivery, notification, parseRegistration, pushAvailable, readPushRecords, saveRegistration, type Delivery, type MobileRegistration } from "./push";
import { nextStamp, parseRelayCredential, RELAY_V2_URL, relayV2Delivery } from "./relay-v2";
import { sendRelayTest } from "./worker";

const old = { home: process.env.TELAR_HOME, cockpit: process.env.TELAR_COCKPIT, key: process.env.TELAR_APNS_KEY_ID };
const originalFetch = globalThis.fetch;
let folder: string | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [["TELAR_HOME", old.home], ["TELAR_COCKPIT", old.cockpit], ["TELAR_APNS_KEY_ID", old.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
  delete (globalThis as { telarMobilePushTimer?: unknown }).telarMobilePushTimer;
});
function setup() {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "telar-relay-v2-"));
  process.env.TELAR_HOME = folder;
  process.env.TELAR_COCKPIT = "1";
  delete process.env.TELAR_APNS_KEY_ID;
}

const credential = { handle: "h".repeat(43), keyId: "k".repeat(22), sendKey: crypto.randomBytes(32).toString("base64url") };
const registration: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "com.telar.mobile", sandbox: false,
  enabled: true, completions: true, previews: false, mutedSessions: [],
  activities: [{ sessionId: "session_1", token: "c".repeat(64), startedAt: 1 }], relay: credential,
};
const wire = { ...registration, relay: { url: "https://elsewhere.example", ...credential } };

/** Records what reached the relay and answers as it would. */
function relay(answer: () => Response = () => Response.json({ status: 200 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("the phone's credential", () => {
  test("is kept when well formed, and the phone's own copy of the URL is not", () => {
    expect(parseRegistration(wire).relay).toEqual(credential);
  });

  test("a malformed one is dropped and the registration still stands", () => {
    for (const bad of [{ ...credential, handle: "short" }, { ...credential, sendKey: 7 }, "x", null]) {
      const parsed = parseRegistration({ ...wire, relay: bad });
      expect(parsed.relay).toBeUndefined();
      expect(parsed.token).toBe(registration.token);
    }
    expect(parseRelayCredential({ ...credential, keyId: "k".repeat(23) })).toBeUndefined();
  });
});

describe("a send", () => {
  const alert = notification(registration, { id: "session_1", title: "Private", activity: "blocked" }, "working:0:0:false")!;

  test("is signed over exactly the bytes sent, to the compiled-in relay, by handle", async () => {
    const { calls, fetchImpl } = relay(() => Response.json({ status: 400, reason: "BadDeviceToken" }));
    expect(await relayV2Delivery(credential, alert, fetchImpl)).toEqual({ status: 400, reason: "BadDeviceToken" });
    const [{ url, init }] = calls;
    const pathname = `/v2/devices/${credential.handle}/push`;
    expect(url).toBe(`${RELAY_V2_URL}${pathname}`);
    const headers = init.headers as Record<string, string>;
    const expected = crypto.createHmac("sha256", Buffer.from(credential.sendKey, "base64url")).update(`${headers["x-telar-timestamp"]}\nPOST\n${pathname}\n${init.body}`).digest("hex");
    expect(headers["x-telar-signature"]).toBe(expected);
    expect(headers["x-telar-key"]).toBe(credential.keyId);
    // WHAT, never WHERE: no device token and no topic leave this Mac.
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["collapseId", "kind", "payload"]);
    expect(String(init.body)).not.toContain(registration.token);
  });

  test("a Live Activity is named by its session, a start by being one", async () => {
    const { calls, fetchImpl } = relay();
    await relayV2Delivery(credential, activityDelivery(registration, registration.activities[0], undefined, 100), fetchImpl);
    await relayV2Delivery(credential, automaticActivityDelivery({ ...registration, liveActivities: true }, [], "b".repeat(64), 1, 100, true), fetchImpl);
    await relayV2Delivery(credential, automaticActivityDelivery({ ...registration, liveActivities: true }, [], "d".repeat(64), 1, 100), fetchImpl);
    const bodies = calls.map(call => JSON.parse(String(call.init.body)));
    expect(bodies.map(b => [b.kind, b.activity, b.start])).toEqual([
      ["liveactivity", "session_1", undefined],
      ["liveactivity", undefined, true],
      ["liveactivity", "__automatic__", undefined],
    ]);
    expect(calls.every(call => !String(call.init.body).includes("b".repeat(64)) && !String(call.init.body).includes("c".repeat(64)))).toBe(true);
  });

  test("an activity with no name is refused here, without a request", async () => {
    const { calls, fetchImpl } = relay();
    const nameless: Delivery = { ...activityDelivery(registration, registration.activities[0], undefined, 100), activityId: undefined };
    expect(await relayV2Delivery(credential, nameless, fetchImpl)).toEqual({ status: 400, relay: true });
    expect(calls).toEqual([]);
  });

  test("a relay refusal is the relay's, and its Retry-After pauses this Mac", async () => {
    const { fetchImpl } = relay(() => new Response(null, { status: 503, headers: { "retry-after": "120" } }));
    expect(await relayV2Delivery(credential, alert, fetchImpl)).toEqual({ status: 503, relay: true, retryAfter: 120 });
  });

  test("timestamps only rise, so two identical sends are never one replay", () => {
    const first = nextStamp(5), second = nextStamp(5);
    expect(second).toBeGreaterThan(first);
  });
});

describe("the test alert after pairing", () => {
  test("is sent once per key, and its answer is what Settings shows", async () => {
    setup();
    const device = addDevice("Phone", mintDeviceToken());
    saveRegistration(device.id, registration);
    const sent: Delivery[] = [];
    const send = async (_: unknown, delivery: Delivery) => { sent.push(delivery); return { status: 200 }; };
    await sendRelayTest(device.id, registration.topic, send);
    await sendRelayTest(device.id, registration.topic, send);
    expect(sent.length).toBe(1);
    expect(readPushRecords()[0].relayTest).toMatchObject({ keyId: credential.keyId, status: 200 });

    // A preference change keeps the key: no new test. A new key earns one.
    saveRegistration(device.id, { ...registration, previews: true });
    await sendRelayTest(device.id, registration.topic, send);
    expect(sent.length).toBe(1);
    const rotated = { ...credential, keyId: "r".repeat(22) };
    saveRegistration(device.id, { ...registration, relay: rotated });
    await sendRelayTest(device.id, registration.topic, async () => ({ status: 401, relay: true }));
    expect(readPushRecords()[0].relayTest).toEqual({ keyId: rotated.keyId, at: expect.any(Number), status: 401, relay: true });
  });

  test("waits until alerts are allowed", async () => {
    setup();
    const device = addDevice("Phone", mintDeviceToken());
    saveRegistration(device.id, { ...registration, enabled: false });
    let sends = 0;
    await sendRelayTest(device.id, registration.topic, async () => { sends++; return { status: 200 }; });
    expect(sends).toBe(0);
  });

  test("Settings shows the outcome and the transport, and never the key or the handle", async () => {
    setup();
    const device = addDevice("Phone", mintDeviceToken());
    saveRegistration(device.id, registration);
    await sendRelayTest(device.id, registration.topic, async () => ({ status: 400, reason: "BadDeviceToken" }));
    const text = await (await relayGET(new Request("http://localhost/api/mobile/relay"))).text();
    const body = JSON.parse(text);
    expect(body.v2).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.devices[0]).toMatchObject({ transport: "v2", test: { status: 400, reason: "BadDeviceToken", relay: false } });
    for (const secret of [credential.sendKey, credential.handle, credential.keyId, registration.token]) expect(text).not.toContain(secret);
  });
});

describe("a Mac with nothing provisioned", () => {
  test("is told a v2 phone can be reached, and starts pushing for it", async () => {
    setup();
    const token = mintDeviceToken();
    addDevice("Phone", token);
    expect(pushAvailable()).toBe(false);
    // The registration's test alert must not reach the real relay from a test,
    // and the worker it would start must not open a feed to a real engine: a
    // timer already set is how `startMobilePushWorker` knows one is running.
    const { calls, fetchImpl } = relay();
    globalThis.fetch = fetchImpl;
    (globalThis as { telarMobilePushTimer?: unknown }).telarMobilePushTimer = setTimeout(() => {}, 0);
    const answer = await pushPUT(new Request("http://localhost/api/mobile/push", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(wire) }));
    expect(await answer.json()).toMatchObject({ configured: true });
    expect(pushAvailable()).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(calls.every(call => call.url.startsWith(RELAY_V2_URL))).toBe(true);
  });
});
