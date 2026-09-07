import { execFileSync } from "node:child_process";
import type { Delivery, PushRecord } from "./push";

/** Runtime identity belongs to this Mac, never to a release artifact. */
export interface RelayConfig { url: string; token: string }
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
export function parseRelayConfig(input: unknown): RelayConfig | undefined {
  if (!input || typeof input !== "object") return;
  const x = input as Record<string, unknown>;
  if (typeof x.url !== "string" || typeof x.token !== "string" || !/^[a-f0-9]{64}$/i.test(x.token)) return;
  try {
    const url = new URL(x.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return;
    return { url: url.origin, token: x.token };
  } catch { return; }
}
export async function relayRequest(config: RelayConfig, path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${config.url}${path}`, { method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(15000) });
}
/** Register only a host-authenticated phone, then send to that registered destination. */
export async function relayDelivery(config: RelayConfig, record: PushRecord, delivery: Delivery): Promise<number> {
  // The available Apple key is production-only. Never claim sandbox readiness.
  if (record.sandbox || record.topic !== "com.telar.mobile") return 400;
  const path = `/v1/devices/${encodeURIComponent(record.deviceId)}`;
  const registered = await relayRequest(config, path, "PUT", { token: record.token, topic: record.topic, sandbox: record.sandbox, activities: record.activities.map(a => a.token) });
  await registered.body?.cancel();
  if (!registered.ok) return registered.status === 410 ? 503 : registered.status;
  const response = await relayRequest(config, `${path}/push`, "POST", delivery);
  // Relay/auth failures are not Apple's terminal device-token expiration.
  if (!response.ok) { await response.body?.cancel(); return response.status === 410 ? 503 : response.status; }
  const result = await response.json() as { status?: number };
  return typeof result.status === "number" ? result.status : 503;
}
export async function revokeRelayDevice(config: RelayConfig, deviceId: string): Promise<void> {
  const response = await relayRequest(config, `/v1/devices/${encodeURIComponent(deviceId)}`, "DELETE");
  await response.body?.cancel();
  if (!response.ok) throw new Error("Push relay unavailable");
}
