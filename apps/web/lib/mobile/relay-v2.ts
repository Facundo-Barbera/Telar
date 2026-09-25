import crypto from "node:crypto";
import type { Delivery, DeliveryResult, PushRecord, RelayCredential } from "./push";

/**
 * SENDING THROUGH RELAY v2: BY HANDLE, SIGNED, AND NEVER WITH A DEVICE TOKEN.
 *
 * The phone registers itself with the relay (App Attest) and hands this Mac a
 * `{handle, keyId, sendKey}` in its `PUT /api/mobile/push`. Nothing on this Mac
 * is provisioned: no Keychain item, no host registry, no redeploy. The Mac says
 * WHAT to send (an alert, a Live Activity by session id, a push-to-start); the
 * relay picks the token, the topic and the APNs host from what the phone
 * registered. See `workers/push-relay/v2.mjs`.
 *
 * THE URL IS COMPILED IN. `TELAR_PUSH_RELAY_URL` overrides it for a relay that
 * has moved (its own account, its own domain) without a phone having to say so;
 * the phone's own copy of the URL is never trusted with where this Mac sends.
 */
export const RELAY_V2_URL = process.env.TELAR_PUSH_RELAY_URL ?? "https://telar-push-relay.facundo-barbera.workers.dev";

const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9_-]{22}$/;
const SEND_KEY = /^[A-Za-z0-9_-]{43}$/;
const ACTIVITY = /^[a-zA-Z0-9_-]{1,128}$/;

/** A phone's relay credential, or nothing. A malformed one is DROPPED rather
 *  than refusing the registration: the rest of it still works over v1. */
export function parseRelayCredential(input: unknown): RelayCredential | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const x = input as Record<string, unknown>;
  if (typeof x.handle !== "string" || !HANDLE.test(x.handle) || typeof x.keyId !== "string" || !KEY_ID.test(x.keyId)
    || typeof x.sendKey !== "string" || !SEND_KEY.test(x.sendKey)) return;
  return { handle: x.handle, keyId: x.keyId, sendKey: x.sendKey };
}

/**
 * STRICTLY INCREASING, NOT MERELY `Date.now()`. The relay refuses a signature
 * it has already seen, and two identical sends signed in the same millisecond
 * would carry the same one — the second would be refused as a replay.
 */
let lastStamp = 0;
export function nextStamp(now = Date.now()): number {
  lastStamp = Math.max(now, lastStamp + 1);
  return lastStamp;
}
export function signV2(sendKey: string, stamp: string, path: string, body: string): string {
  return crypto.createHmac("sha256", Buffer.from(sendKey, "base64url")).update(`${stamp}\nPOST\n${path}\n${body}`).digest("hex");
}

/** What the relay needs to pick the destination itself. */
export function v2Body(delivery: Delivery): Record<string, unknown> | undefined {
  const base = { kind: delivery.kind, collapseId: delivery.collapseId, payload: delivery.payload };
  if (delivery.kind === "alert") return base;
  if (delivery.payload.aps.event === "start") return { ...base, start: true };
  return delivery.activityId !== undefined && ACTIVITY.test(delivery.activityId) ? { ...base, activity: delivery.activityId } : undefined;
}

export async function relayV2Delivery(credential: RelayCredential, delivery: Delivery, fetchImpl: typeof fetch = fetch): Promise<DeliveryResult> {
  const payload = v2Body(delivery);
  if (!payload) return { status: 400, relay: true };
  const path = `/v2/devices/${credential.handle}/push`;
  const body = JSON.stringify(payload);
  const stamp = String(nextStamp());
  const response = await fetchImpl(`${RELAY_V2_URL}${path}`, {
    method: "POST", body, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", "x-telar-key": credential.keyId, "x-telar-timestamp": stamp, "x-telar-signature": signV2(credential.sendKey, stamp, path, body) },
  });
  if (!response.ok) { await response.body?.cancel(); return relayRefusal(response); }
  const result = await response.json() as { status?: number; reason?: string };
  if (typeof result.status !== "number") return { status: 503, relay: true };
  // Apple's own answer: the only case where `relay` is absent (#584).
  return { status: result.status, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
}

/** A relay status, marked as the relay's own. `Retry-After` rides along on the
 *  429 that says a daily budget is spent, and on v2's global-budget 503 (#584). */
export function relayRefusal(response: Response): DeliveryResult {
  const after = Number(response.headers.get("retry-after"));
  return {
    status: response.status, relay: true,
    ...(Number.isFinite(after) && after > 0 ? { retryAfter: Math.min(Math.floor(after), 86400) } : {}),
  };
}

/**
 * THE PROOF THAT IT WORKS, SENT THE MOMENT IT CAN — "working" or the exact
 * reason, in Settings, straight after pairing.
 *
 * A phone that registered is not a phone that can be reached, and the only way
 * to know is to send something. One alert per send key: a new key (a new pair,
 * or a re-registration) earns a new test, a preference change does not.
 */
export function relayTestDelivery(record: PushRecord): Delivery {
  return { token: record.token, topic: record.topic, sandbox: record.sandbox, kind: "alert",
    collapseId: crypto.createHash("sha256").update(`relay-test:${record.relay?.keyId ?? ""}`).digest("hex"),
    payload: { aps: { alert: { title: "Telar", body: "Notifications from this Mac will arrive here." }, sound: "default" } } };
}
export function needsRelayTest(record: PushRecord): boolean {
  return record.relay !== undefined && record.enabled && record.relayTest?.keyId !== record.relay.keyId;
}
