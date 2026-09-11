import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http2 from "node:http2";
import { relayConfig } from "./relay";
import { remoteHome } from "../remote/store";

export interface MobileRegistration {
  hostId: string;
  hostName?: string;
  liveActivities?: boolean;
  pushToStartToken?: string;
  token: string;
  topic: string;
  sandbox: boolean;
  enabled: boolean;
  completions: boolean;
  previews: boolean;
  mutedSessions: string[];
  activities: { sessionId: string; token: string; startedAt: number }[];
}
export interface SessionSignal {
  id: string; title: string; activity: string; activityAt?: number;
  lastTurnEndedAt?: number; lastTurnFailed?: boolean;
}
export interface PushRecord extends MobileRegistration {
  deviceId: string;
  revision: string;
  baselined?: boolean;
  automaticStartedAt?: number;
  automaticSignal?: string;
  failures?: number;
  retryAt?: number;
  updatedAt: number;
  seen: Record<string, string>;
  activitySent: Record<string, number>;
}
export type PushPayload = { aps: Record<string, unknown>; url?: string };
export type Delivery = { token: string; topic: string; sandbox: boolean; kind: "alert" | "liveactivity"; collapseId: string; payload: PushPayload };
export class PushInputError extends Error {}
const hex = /^[a-fA-F0-9]{32,512}$/;
const uuid = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

export function parseRegistration(input: unknown): MobileRegistration {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PushInputError("Invalid registration");
  const x = input as Record<string, unknown>;
  if (typeof x.hostId !== "string" || !uuid.test(x.hostId) || typeof x.token !== "string" || !hex.test(x.token)
      || !["com.telar.mobile", "com.telar.mobile.dev"].includes(String(x.topic))
      || ["sandbox", "enabled", "completions", "previews"].some(k => typeof x[k] !== "boolean")
      || !Array.isArray(x.mutedSessions) || x.mutedSessions.length > 1000 || !x.mutedSessions.every(v => typeof v === "string" && v.length > 0 && v.length <= 256)
      || !Array.isArray(x.activities) || x.activities.length > 8) throw new PushInputError("Invalid registration");
  if ((x.liveActivities !== undefined && typeof x.liveActivities !== "boolean")
    || (x.pushToStartToken !== undefined && (typeof x.pushToStartToken !== "string" || !hex.test(x.pushToStartToken)))
    || (x.hostName !== undefined && (typeof x.hostName !== "string" || x.hostName.length > 160))) throw new PushInputError("Invalid automatic activity registration");
  for (const a of x.activities) {
    if (!a || typeof a.sessionId !== "string" || !a.sessionId || a.sessionId.length > 256 || typeof a.token !== "string" || !hex.test(a.token)
      || typeof a.startedAt !== "number" || !Number.isFinite(a.startedAt) || a.startedAt <= 0) throw new PushInputError("Invalid activity");
  }
  return { ...(x.liveActivities === undefined ? {} : { liveActivities: x.liveActivities as boolean }),
    ...(x.pushToStartToken === undefined ? {} : { pushToStartToken: x.pushToStartToken as string }),
    ...(x.hostName === undefined ? {} : { hostName: x.hostName as string }),
    hostId: x.hostId, token: x.token, topic: x.topic as string, sandbox: x.sandbox as boolean,
    enabled: x.enabled as boolean, completions: x.completions as boolean, previews: x.previews as boolean,
    mutedSessions: [...x.mutedSessions], activities: x.activities.map(a => ({sessionId: a.sessionId, token: a.token, startedAt: a.startedAt})) };
}

export function pushFile(): string { return path.join(remoteHome(), "remote", "mobile-push.json"); }
export function readPushRecords(file = pushFile()): PushRecord[] {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as PushRecord[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function writePushRecords(records: PushRecord[], file = pushFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function saveRegistration(deviceId: string, registration: MobileRegistration, file = pushFile()): void {
  const records = readPushRecords(file);
  const old = records.find(r => r.deviceId === deviceId && r.topic === registration.topic);
  // A start receipt belongs to the token it was sent to. A reinstall mints a fresh
  // pushToStartToken, so a receipt for the previous one proves nothing about this install
  // and must not close the start gate on an activity this install never had.
  const keepStart = registration.liveActivities === true && old?.liveActivities === true
    && registration.pushToStartToken !== undefined && registration.pushToStartToken === old.pushToStartToken;
  const next: PushRecord = { ...registration, deviceId, revision: crypto.randomUUID(), updatedAt: Date.now(), automaticStartedAt: keepStart ? old?.automaticStartedAt : undefined, automaticSignal: old?.automaticSignal, seen: old?.seen ?? {}, baselined: old?.baselined ?? false, activitySent: old?.activitySent ?? {} };
  writePushRecords([...records.filter(r => r.deviceId !== deviceId || r.topic !== registration.topic), next], file);
}
export function signalKey(session: SessionSignal): string {
  return `${session.activity}:${session.activityAt ?? 0}:${session.lastTurnEndedAt ?? 0}:${session.lastTurnFailed === true}`;
}
export function sessionURL(hostId: string, sessionId: string): string {
  const url = new URL("telar://session"); url.searchParams.set("host", hostId); url.searchParams.set("id", sessionId); return url.toString();
}
export function notification(record: MobileRegistration, session: SessionSignal, previous: string | undefined): Delivery | undefined {
  if (!record.enabled || record.mutedSessions.includes(session.id) || previous === undefined || previous === signalKey(session)) return;
  let body: string | undefined;
  if (session.activity === "blocked") body = "A session needs your input or approval.";
  else if (session.activity === "idle" && session.lastTurnEndedAt && String(session.lastTurnEndedAt) !== previous.split(":")[2]) {
    if (session.lastTurnFailed) body = "A session failed. Open Telar to review it.";
    else if (record.completions) body = "A session finished. Its result is ready to review.";
  }
  if (!body) return;
  const collapseId = crypto.createHash("sha256").update(session.id).digest("hex");
  return { token: record.token, topic: record.topic, sandbox: record.sandbox, kind: "alert", collapseId,
    payload: { aps: { alert: { title: record.previews ? session.title.slice(0, 160) : "Telar", body }, sound: "default", "thread-id": `${record.hostId}:${session.id}` }, url: sessionURL(record.hostId, session.id) } };
}
export function activityDelivery(record: MobileRegistration, follow: MobileRegistration["activities"][number], session: SessionSignal | undefined, now: number): Delivery {
  const ended = !session || session.activity === "idle";
  const status = !session ? "Session unavailable" : session.activity === "blocked" ? "Needs you" : ended ? session.lastTurnFailed ? "Failed" : "Finished" : session.activity === "queued" ? "Queued" : session.activity === "monitoring" ? "Monitoring" : "Working";
  return { token: follow.token, topic: `${record.topic}.push-type.liveactivity`, sandbox: record.sandbox, kind: "liveactivity",
    collapseId: crypto.createHash("sha256").update(follow.token).digest("hex"), payload: { aps: {
      timestamp: Math.floor(now), event: ended ? "end" : "update", "stale-date": Math.floor(now + 180),
      ...(ended ? { "dismissal-date": Math.floor(now + 300) } : {}),
      // Swift's default Date Codable representation uses the 2001 reference epoch.
      "content-state": { title: record.previews ? (session?.title ?? "Telar session").slice(0, 160) : "Telar session", status, updatedAt: now - 978307200, startedAt: follow.startedAt - 978307200, ended },
    } } };
}

export function pushConfigured(sandbox = false): boolean {
  if (relayConfig()) return !sandbox;
  if (!process.env.TELAR_APNS_KEY_ID || !process.env.TELAR_APNS_TEAM_ID || !process.env.TELAR_APNS_KEY_PATH) return false;
  try {
    const key = crypto.createPrivateKey(fs.readFileSync(process.env.TELAR_APNS_KEY_PATH));
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch { return false; }
}
let cachedJWT: { identity: string; at: number; token: string } | undefined;
function bearer(): string {
  const keyId = process.env.TELAR_APNS_KEY_ID!;
  const teamId = process.env.TELAR_APNS_TEAM_ID!;
  const keyPath = process.env.TELAR_APNS_KEY_PATH!;
  const identity = `${keyId}:${teamId}:${keyPath}`;
  const now = Math.floor(Date.now() / 1000);
  if (cachedJWT?.identity === identity && now - cachedJWT.at < 3000) return cachedJWT.token;
  const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const message = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: teamId, iat: now })}`;
  const signature = crypto.sign("sha256", Buffer.from(message), { key: fs.readFileSync(keyPath), dsaEncoding: "ieee-p1363" }).toString("base64url");
  cachedJWT = { identity, at: now, token: `${message}.${signature}` };
  return cachedJWT.token;
}
/** APNs tokens and payloads never enter logs. Callers see only delivery status. */
export async function sendAPNs(delivery: Delivery): Promise<number> {
  const authorization = `bearer ${bearer()}`;
  return new Promise((resolve, reject) => {
    const client = http2.connect(delivery.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
    const timer = setTimeout(() => { client.destroy(); reject(new Error("APNs timeout")); }, 10000);
    const fail = () => { clearTimeout(timer); client.destroy(); reject(new Error("APNs transport failed")); };
    client.on("error", fail);
    const request = client.request({ ":method": "POST", ":path": `/3/device/${delivery.token}`, authorization,
      "apns-topic": delivery.topic, "apns-push-type": delivery.kind, "apns-priority": delivery.kind === "alert" || ["start", "end"].includes(String(delivery.payload.aps.event)) ? "10" : "5",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600), "apns-collapse-id": delivery.collapseId });
    let status = 0;
    request.on("response", headers => { status = Number(headers[":status"]); });
    request.on("data", () => {});
    request.on("error", fail);
    request.on("end", () => { clearTimeout(timer); client.close(); resolve(status); });
    request.end(JSON.stringify(delivery.payload));
  });
}

export const AUTOMATIC_ACTIVITY = "__automatic__";
export function automaticSessions(sessions: SessionSignal[]): SessionSignal[] {
  const rank: Record<string, number> = { blocked: 0, working: 1, queued: 2, monitoring: 3 };
  return sessions.filter(s => s.activity in rank).sort((a,b) => rank[a.activity]! - rank[b.activity]! || a.id.localeCompare(b.id));
}
export function automaticActivityDelivery(record: MobileRegistration, sessions: SessionSignal[], token: string, startedAt: number, now: number, start = false): Delivery {
  const active = record.liveActivities ? automaticSessions(sessions) : [];
  const focus = active[0];
  const ended = !focus;
  const state = {
    title: record.previews && active.length === 1 ? focus!.title.slice(0,160) : active.length > 1 ? `${active.length} active sessions` : ended ? "Work finished" : "Telar work",
    status: ended ? "Finished" : focus.activity === "blocked" ? "Needs you" : focus.activity === "queued" ? "Queued" : focus.activity === "monitoring" ? "Monitoring" : "Working",
    startedAt: startedAt - 978307200, updatedAt: now - 978307200, ended,
    sessionId: focus?.id, activeCount: active.length,
  };
  return { token, topic: `${record.topic}.push-type.liveactivity`, sandbox: record.sandbox, kind: "liveactivity",
    collapseId: crypto.createHash("sha256").update(`automatic:${record.hostId}:${start ? startedAt : token}`).digest("hex"),
    payload: { aps: { timestamp: Math.floor(now), event: start ? "start" : ended ? "end" : "update", "content-state": state,
      "stale-date": Math.floor(now + 180), ...(ended ? {"dismissal-date":Math.floor(now + 300)} : {}),
      ...(start ? { "attributes-type":"SessionActivityAttributes", attributes:{hostId:record.hostId,sessionId:AUTOMATIC_ACTIVITY,hostName:record.hostName ?? "Mac"},
        "input-push-token":1, alert:{title:"Telar",body:"Agent work in progress"} } : {}),
    } } };
}
