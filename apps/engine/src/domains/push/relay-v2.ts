import crypto from "node:crypto";
import type { Delivery, DeliveryResult, PushRecord, RelayCredential } from "./push";

export const RELAY_V2_URL = process.env.TELAR_PUSH_RELAY_URL ?? "https://telar-push-relay.facundo-barbera.workers.dev";

const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9_-]{22}$/;
const SEND_KEY = /^[A-Za-z0-9_-]{43}$/;
const ACTIVITY = /^[a-zA-Z0-9_-]{1,128}$/;

export function parseRelayCredential(input: unknown): RelayCredential | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const x = input as Record<string, unknown>;
  if (typeof x.handle !== "string" || !HANDLE.test(x.handle) || typeof x.keyId !== "string" || !KEY_ID.test(x.keyId)
    || typeof x.sendKey !== "string" || !SEND_KEY.test(x.sendKey)) return;
  return { handle: x.handle, keyId: x.keyId, sendKey: x.sendKey };
}

let lastStamp = 0;
export function nextStamp(now = Date.now()): number {
  lastStamp = Math.max(now, lastStamp + 1);
  return lastStamp;
}
function signV2(sendKey: string, stamp: string, path: string, body: string): string {
  return crypto.createHmac("sha256", Buffer.from(sendKey, "base64url")).update(`${stamp}\nPOST\n${path}\n${body}`).digest("hex");
}

export function v2Body(delivery: Delivery): Record<string, unknown> | undefined {
  const base = { kind: delivery.kind, collapseId: delivery.collapseId, payload: delivery.payload };
  if (delivery.kind === "alert" || delivery.kind === "background") return base;
  if (delivery.payload.aps.event === "start") return { ...base, start: true };
  return delivery.activityId !== undefined && ACTIVITY.test(delivery.activityId) ? { ...base, activity: delivery.activityId, ...(delivery.urgent ? { urgent: true } : {}) } : undefined;
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
  if (!response.ok) return relayRefusal(response, await relayErrorWord(response));
  const result = await response.json() as { status?: number; reason?: string };
  if (typeof result.status !== "number") return { status: 503, relay: true };
  return { status: result.status, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
}

async function relayErrorWord(response: Response): Promise<string | undefined> {
  try {
    const value = (JSON.parse((await response.text()).slice(0, 256)) as { error?: unknown }).error;
    return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

function relayRefusal(response: Response, reason?: string): DeliveryResult {
  const after = Number(response.headers.get("retry-after"));
  return {
    status: response.status, relay: true, ...(reason === undefined ? {} : { reason }),
    ...(Number.isFinite(after) && after > 0 ? { retryAfter: Math.min(Math.floor(after), 86400) } : {}),
  };
}

export function relayTestDelivery(record: PushRecord): Delivery {
  return { token: record.token, topic: record.topic, sandbox: record.sandbox, kind: "alert",
    collapseId: crypto.createHash("sha256").update(`relay-test:${record.relay?.keyId ?? ""}`).digest("hex"),
    payload: { aps: { alert: { title: "Telar", body: "Notifications from this computer will arrive here." }, sound: "default" } } };
}
export function needsRelayTest(record: PushRecord): boolean {
  return record.relay !== undefined && record.enabled && record.relayTest?.keyId !== record.relay.keyId;
}
