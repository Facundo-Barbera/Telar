import { execFileSync } from "node:child_process";
import type { Delivery, DeliveryResult, PushRecord } from "./push";
import { parseRelayConfig, type RelayConfig } from "./relay-config";

/** The shape lives in `relay-config.ts` so a browser can validate a pasted one
 *  without importing this module's Keychain read (#579). Re-exported here so
 *  every existing caller keeps its import. */
export { parseRelayConfig, type RelayConfig };
const relayGlobal = globalThis as typeof globalThis & { telarPushRelayInitialized?: boolean };
/** Called only by the cockpit startup hook, never by route imports or tests. */
export function initializePushRelay(): void { relayGlobal.telarPushRelayInitialized = true; }
let cached: { at: number; value?: RelayConfig } | undefined;
export function relayConfig(): RelayConfig | undefined {
  if (!relayGlobal.telarPushRelayInitialized) return undefined;
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  let value: RelayConfig | undefined;
  try {
    // Keychain provisioning is explicit. Do not read credentials while building.
    if (process.platform === "darwin" && process.env.TELAR_COCKPIT === "1") {
      const raw = execFileSync("/usr/bin/security", ["find-generic-password", "-s", "com.telar.push-relay", "-a", "host", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
      value = parseRelayConfig(JSON.parse(raw));
    }
  } catch { /* Unprovisioned hosts simply report push unavailable. */ }
  cached = { at: Date.now(), value }; return value;
}
/** Drop the 30s cache, so a read taken straight after the Keychain item was
 *  written sees it (#579). Without this, Settings would tell somebody who has
 *  just provisioned the relay that this Mac has none, for half a minute. */
export function forgetRelayConfig(): void { cached = undefined; }
export async function relayRequest(config: RelayConfig, path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${config.url}${path}`, { method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(15000) });
}
/** This Mac's relay host id, when it has one — see `RelayConfig.id`. */
export function relayHostId(): string | undefined { return relayConfig()?.id; }

/**
 * ONE CALL PER PUSH — issue #584.
 *
 * This registered the device and then sent, every single time, so the relay saw
 * two invocations per notification and re-stored an identical registration for
 * each one. The registration only changes when the RECORD does, so it is sent
 * only when `relayRevision` has fallen behind `revision`; the ordinary push is
 * the one POST it always should have been.
 *
 * THE RELAY EXPIRES A REGISTRATION AFTER 24 HOURS and answers 409, which is the
 * one case a skipped PUT has to recover from: re-register once, retry the POST,
 * and give up rather than loop if it happens again.
 */
export async function relayDelivery(config: RelayConfig, record: PushRecord, delivery: Delivery): Promise<DeliveryResult> {
  // The available Apple key is production-only. Never claim sandbox readiness.
  if (record.sandbox || record.topic !== "com.telar.mobile") return { status: 400, relay: true };
  const path = `/v1/devices/${encodeURIComponent(record.deviceId)}`;
  let registered = false;
  /** Refusals here are the RELAY's, never Apple's verdict on the token. */
  const register = async (): Promise<DeliveryResult | undefined> => {
    const response = await relayRequest(config, path, "PUT", { token: record.token, topic: record.topic, sandbox: record.sandbox, activities: record.activities.map(a => a.token), pushToStartToken: record.liveActivities ? record.pushToStartToken : undefined });
    await response.body?.cancel();
    if (response.ok) { registered = true; return undefined; }
    return relayRefusal(response);
  };
  const send = async (): Promise<DeliveryResult> => {
    const response = await relayRequest(config, `${path}/push`, "POST", delivery);
    if (!response.ok) { await response.body?.cancel(); return relayRefusal(response); }
    const result = await response.json() as { status?: number; reason?: string };
    if (typeof result.status !== "number") return { status: 503, relay: true };
    // APPLE'S OWN ANSWER, and the only place `relay` is absent: this is what
    // tells a dead device token from a bad hour (#584).
    return { status: result.status, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
  };

  if (record.relayRevision !== record.revision) {
    const refused = await register();
    if (refused) return refused;
  }
  let result = await send();
  if (result.relay && result.status === 409 && !registered) {
    const refused = await register();
    if (refused) return refused;
    result = await send();
  }
  return registered ? { ...result, registered: true } : result;
}

/** A relay status, marked as the relay's own. `Retry-After` rides along on the
 *  429 that says this host's daily budget is spent (#584). */
function relayRefusal(response: Response): DeliveryResult {
  const after = Number(response.headers.get("retry-after"));
  return {
    status: response.status, relay: true,
    ...(Number.isFinite(after) && after > 0 ? { retryAfter: Math.min(Math.floor(after), 86400) } : {}),
  };
}
export async function revokeRelayDevice(config: RelayConfig, deviceId: string): Promise<void> {
  const response = await relayRequest(config, `/v1/devices/${encodeURIComponent(deviceId)}`, "DELETE");
  await response.body?.cancel();
  if (!response.ok) throw new Error("Push relay unavailable");
}
