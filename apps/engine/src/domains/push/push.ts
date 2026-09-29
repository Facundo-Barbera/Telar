import crypto from "node:crypto";
import { NOTIFICATION_SOUNDS_VALUES, type ActivityReport, type NotificationSounds, type Turn } from "@telar/engine-client";
import fs from "node:fs";
import path from "node:path";
import http2 from "node:http2";
import { parseRelayCredential } from "./relay-v2";
import type { ReadSyncState } from "./read-sync";

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
  sounds?: NotificationSounds;
  mutedSessions: string[];
  card?: HostCard;
  relay?: RelayCredential;
}
type HostCard = { token: string; startedAt: number };
export type RelayCredential = { handle: string; keyId: string; sendKey: string };
export interface SessionSignal {
  id: string; title: string; activity: string; activityAt?: number;
  lastTurnEndedAt?: number; lastTurnFailed?: boolean; lastTurnOrigin?: Turn["origin"];
  hasParent?: boolean;
  projectId?: string;
  lastTurnSequence?: number; lastReadTurnSequence?: number;
  approvable?: string;
}
export interface PushRecord extends MobileRegistration {
  deviceId: string;
  revision: string;
  baselined?: boolean;
  automaticStartedAt?: number;
  cardFinishedAt?: number;
  automaticSignal?: string;
  failures?: number;
  retryAt?: number;
  parked?: true;
  lastDeliveryAt?: number;
  lastStatus?: number;
  lastReason?: string;
  relayTest?: { keyId: string; at: number; status: number; reason?: string; relay?: true };
  automaticStart?: { at: number; status: number; reason?: string; relay?: true; token?: string };
  updatedAt: number;
  readSync?: ReadSyncState;
  seen: Record<string, string>;
  activitySent: Record<string, number>;
}
type PushPayload = { aps: Record<string, unknown>; url?: string; request?: string; read?: { host: string; sessions: string[] } };
export const CATEGORY_REQUEST = "TELAR_REQUEST", CATEGORY_SESSION = "TELAR_SESSION";
export type Delivery = { token: string; topic: string; sandbox: boolean; kind: "alert" | "liveactivity" | "background"; collapseId: string; payload: PushPayload; activityId?: string; urgent?: boolean };
export function apnsPriority(delivery: Delivery): "5" | "10" {
  if (delivery.kind === "background") return "5";
  return delivery.kind === "alert" || delivery.urgent === true || ["start", "end"].includes(String(delivery.payload.aps.event)) ? "10" : "5";
}

export type DeliveryResult = {
  status: number;
  reason?: string;
  relay?: true;
  retryAfter?: number;
};

const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "ExpiredToken"]);
export function isDeadToken(result: DeliveryResult): boolean {
  if (result.relay) return false;
  return result.status === 410 || (result.status === 400 && result.reason !== undefined && DEAD_TOKEN_REASONS.has(result.reason));
}
export class PushInputError extends Error {}
const LEGACY_BUNDLE_IDS = { until: "2026-11-01", ids: ["com.telar.mobile", "com.telar.mobile.dev"] };
const MOBILE_TOPICS = new Set(["io.github.novarix.telar", "io.github.novarix.telar.dev", ...LEGACY_BUNDLE_IDS.ids]);
const hex = /^[a-fA-F0-9]{32,512}$/;
const uuid = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

export function parseRegistration(input: unknown): MobileRegistration {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PushInputError("Invalid registration");
  const x = input as Record<string, unknown>;
  if (typeof x.hostId !== "string" || !uuid.test(x.hostId) || typeof x.token !== "string" || !hex.test(x.token)
      || !MOBILE_TOPICS.has(String(x.topic))
      || ["sandbox", "enabled", "completions", "previews"].some(k => typeof x[k] !== "boolean")
      || !Array.isArray(x.mutedSessions) || x.mutedSessions.length > 1000 || !x.mutedSessions.every(v => typeof v === "string" && v.length > 0 && v.length <= 256)
      || (x.activities !== undefined && (!Array.isArray(x.activities) || x.activities.length > 8))) throw new PushInputError("Invalid registration");
  if ((x.liveActivities !== undefined && typeof x.liveActivities !== "boolean")
    || (x.pushToStartToken !== undefined && (typeof x.pushToStartToken !== "string" || !hex.test(x.pushToStartToken)))
    || (x.hostName !== undefined && (typeof x.hostName !== "string" || x.hostName.length > 160))) throw new PushInputError("Invalid automatic activity registration");
  if (x.sounds !== undefined && !NOTIFICATION_SOUNDS_VALUES.includes(x.sounds as NotificationSounds)) throw new PushInputError("Invalid sounds");
  const activities = (x.activities ?? []) as (HostCard & { sessionId: string })[];
  for (const a of activities) {
    if (!a || typeof a.sessionId !== "string" || !a.sessionId || a.sessionId.length > 256 || typeof a.token !== "string" || !hex.test(a.token)
      || typeof a.startedAt !== "number" || !Number.isFinite(a.startedAt) || a.startedAt <= 0) throw new PushInputError("Invalid activity");
  }
  const card = activities.find(a => a.sessionId === AUTOMATIC_ACTIVITY);
  const relay = parseRelayCredential(x.relay);
  return { ...(x.liveActivities === undefined ? {} : { liveActivities: x.liveActivities as boolean }),
    ...(relay === undefined ? {} : { relay }),
    ...(x.pushToStartToken === undefined ? {} : { pushToStartToken: x.pushToStartToken as string }),
    ...(x.hostName === undefined ? {} : { hostName: x.hostName as string }),
    ...(x.sounds === undefined ? {} : { sounds: x.sounds as NotificationSounds }),
    ...(card === undefined ? {} : { card: { token: card.token, startedAt: card.startedAt } }),
    hostId: x.hostId, token: x.token, topic: x.topic as string, sandbox: x.sandbox as boolean,
    enabled: x.enabled as boolean, completions: x.completions as boolean, previews: x.previews as boolean,
    mutedSessions: [...x.mutedSessions] };
}

let configuredHome: string | undefined;

export function setPushHome(dir: string | undefined): void {
  configuredHome = dir;
}

function remoteHome(): string {
  if (configuredHome) return configuredHome;
  const home = process.env.TELAR_HOME?.trim();
  if (!home || !path.isAbsolute(home)) throw new Error("Set an absolute TELAR_HOME.");
  return path.join(fs.realpathSync.native(home), "remote");
}
export function pushFile(): string { return path.join(remoteHome(), "mobile-push.json"); }
export function legacyPushFile(): string { return path.join(remoteHome(), "remote", "mobile-push.json"); }
export function readPushRecords(file?: string): PushRecord[] {
  const read = (at: string): PushRecord[] | undefined => {
    try { return JSON.parse(fs.readFileSync(at, "utf8")) as PushRecord[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  if (file !== undefined) return read(file) ?? [];
  return read(pushFile()) ?? read(legacyPushFile()) ?? [];
}
export function writePushRecords(records: PushRecord[], file = pushFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function saveRegistration(deviceId: string, registration: MobileRegistration, file?: string): void {
  const records = readPushRecords(file);
  const old = records.find(r => r.deviceId === deviceId && r.topic === registration.topic);
  const sameCard = registration.card !== undefined && registration.card.token === old?.card?.token;
  const next: PushRecord = { ...registration, deviceId, revision: crypto.randomUUID(), updatedAt: Date.now(), automaticStartedAt: old?.automaticStartedAt, cardFinishedAt: sameCard ? old?.cardFinishedAt : undefined, automaticSignal: old?.automaticSignal, lastDeliveryAt: old?.lastDeliveryAt, lastStatus: old?.lastStatus, lastReason: old?.lastReason, relayTest: old?.relayTest, automaticStart: old?.automaticStart, readSync: old?.readSync, seen: old?.seen ?? {}, baselined: old?.baselined ?? false, activitySent: old?.activitySent ?? {} };
  writePushRecords([...records.filter(r => r.deviceId !== deviceId || r.topic !== registration.topic), next], file);
}
function turnIsOver(activity: SessionSignal["activity"]): boolean {
  return activity === "idle" || activity === "waiting" || activity === "scheduled";
}
export function signalKey(session: SessionSignal): string {
  return `${session.activity}:${session.activityAt ?? 0}:${session.lastTurnEndedAt ?? 0}:${session.lastTurnFailed === true}`;
}
function sessionURL(hostId: string, sessionId: string): string {
  const url = new URL("telar://session"); url.searchParams.set("host", hostId); url.searchParams.set("id", sessionId); return url.toString();
}
export type AlertKind = "blocked" | "failed" | "finished";
export const ALERT_BODY: Record<AlertKind, string> = {
  blocked: "A session needs your input or approval.",
  failed: "A session failed. Open Telar to review it.",
  finished: "A session finished. Its result is ready to review.",
};
const SOUND_EVENT: Record<AlertKind, string> = { finished: "done", blocked: "needs", failed: "error" };

export function soundFor(sounds: NotificationSounds, kind: AlertKind): string | undefined {
  return sounds === "off" ? undefined : `telar-${sounds}-${SOUND_EVENT[kind]}`;
}

const PERSON_ORIGINS = new Set<Turn["origin"]>([undefined, "user", "schedule"]);

export function alertKind(session: SessionSignal, previous: string | undefined, completions: boolean): AlertKind | undefined {
  if (previous === undefined || previous === signalKey(session)) return;
  if (session.activity === "blocked") return "blocked";
  if (session.hasParent || !PERSON_ORIGINS.has(session.lastTurnOrigin)) return;
  if (turnIsOver(session.activity) && session.lastTurnEndedAt && String(session.lastTurnEndedAt) !== previous.split(":")[2]) {
    if (session.lastTurnFailed) return "failed";
    if (completions) return "finished";
  }
}
export function notification(record: MobileRegistration, session: SessionSignal, previous: string | undefined): Delivery | undefined {
  if (!record.enabled || record.mutedSessions.includes(session.id)) return;
  const kind = alertKind(session, previous, record.completions);
  if (!kind) return;
  const body = ALERT_BODY[kind];
  const approvable = session.activity === "blocked" ? session.approvable : undefined;
  const collapseId = crypto.createHash("sha256").update(session.id).digest("hex");
  const named = record.sounds && soundFor(record.sounds, kind);
  const sound = record.sounds === undefined ? "default" : named && `${named}.caf`;
  return { token: record.token, topic: record.topic, sandbox: record.sandbox, kind: "alert", collapseId,
    payload: { aps: { alert: { title: record.previews ? session.title.slice(0, 160) : "Telar", body }, ...(sound ? { sound } : {}), "thread-id": `${record.hostId}:${session.id}`,
      category: approvable ? CATEGORY_REQUEST : CATEGORY_SESSION }, url: sessionURL(record.hostId, session.id), ...(approvable ? { request: approvable } : {}) } };
}
export function pushConfigured(): boolean {
  if (!process.env.TELAR_APNS_KEY_ID || !process.env.TELAR_APNS_TEAM_ID || !process.env.TELAR_APNS_KEY_PATH) return false;
  try {
    const key = crypto.createPrivateKey(fs.readFileSync(process.env.TELAR_APNS_KEY_PATH));
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch { return false; }
}
export function pushAvailable(): boolean {
  if (pushConfigured()) return true;
  try { return readPushRecords().some(record => record.relay !== undefined); } catch { return false; }
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
function appleReason(body: string): string | undefined {
  try {
    const value = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof value === "string" && /^[A-Za-z]{1,64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function sendAPNs(delivery: Delivery): Promise<DeliveryResult> {
  const authorization = `bearer ${bearer()}`;
  return new Promise((resolve, reject) => {
    const client = http2.connect(delivery.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
    const timer = setTimeout(() => { client.destroy(); reject(new Error("APNs timeout")); }, 10000);
    const fail = () => { clearTimeout(timer); client.destroy(); reject(new Error("APNs transport failed")); };
    client.on("error", fail);
    const request = client.request({ ":method": "POST", ":path": `/3/device/${delivery.token}`, authorization,
      "apns-topic": delivery.topic, "apns-push-type": delivery.kind, "apns-priority": apnsPriority(delivery),
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600), ...(delivery.kind === "background" ? {} : { "apns-collapse-id": delivery.collapseId }) });
    let status = 0;
    let body = "";
    request.on("response", headers => { status = Number(headers[":status"]); });
    request.on("data", chunk => { if (body.length < 512) body += String(chunk); });
    request.on("error", fail);
    request.on("end", () => {
      clearTimeout(timer); client.close();
      const reason = status === 200 ? undefined : appleReason(body);
      resolve({ status, ...(reason === undefined ? {} : { reason }) });
    });
    request.end(JSON.stringify(delivery.payload));
  });
}

export const AUTOMATIC_ACTIVITY = "__automatic__";
export const ACTIVITY_REFRESH_S = 120;
export const CARD_LINGER_S = 300;

export function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}
export function activityReport(record: PushRecord): ActivityReport {
  const card = record.card !== undefined;
  const blocker = !record.liveActivities ? "off" : !record.pushToStartToken ? "no-start-token" : undefined;
  const start = record.automaticStart;
  return { card, ...(blocker ? { blocker } : {}),
    ...(start ? { lastStart: { at: start.at, status: start.status, ...(start.reason ? { reason: start.reason } : {}), relay: start.relay === true, ...(start.token ? { token: start.token } : {}) } } : {}) };
}
export const ACTIVITY_STALE_S = 300;
export function automaticSessions(sessions: SessionSignal[]): SessionSignal[] {
  const rank: Record<string, number> = { blocked: 0, working: 1, queued: 2, monitoring: 3 };
  return sessions.filter(s => s.activity in rank).sort((a,b) => rank[a.activity]! - rank[b.activity]! || a.id.localeCompare(b.id));
}
export type CardEvent = "start" | "update" | "end";
export function automaticActivityDelivery(record: MobileRegistration, sessions: SessionSignal[], token: string, startedAt: number, now: number, event: CardEvent = "update"): Delivery {
  const start = event === "start";
  const active = record.liveActivities ? automaticSessions(sessions) : [];
  const focus = active[0];
  const ended = !focus;
  const state = {
    title: record.previews && active.length === 1 ? focus!.title.slice(0,160) : active.length > 1 ? `${active.length} active sessions` : ended ? "Work finished" : "Telar work",
    status: ended ? "Finished" : focus.activity === "blocked" ? "Needs you" : focus.activity === "queued" ? "Queued" : focus.activity === "monitoring" ? "Background" : "Working",
    startedAt: startedAt - 978307200, updatedAt: now - 978307200, ended,
    sessionId: focus?.id, activeCount: active.length,
  };
  return { token, topic: `${record.topic}.push-type.liveactivity`, sandbox: record.sandbox, kind: "liveactivity", ...(start ? {} : { activityId: AUTOMATIC_ACTIVITY }),
    collapseId: crypto.createHash("sha256").update(`automatic:${record.hostId}:${start ? startedAt : token}`).digest("hex"),
    payload: { aps: { timestamp: Math.floor(now), event, "content-state": state,
      "stale-date": Math.floor(now + ACTIVITY_STALE_S + (ended ? CARD_LINGER_S : 0)), ...(event === "end" ? {"dismissal-date":Math.floor(now)} : {}),
      ...(start ? { "attributes-type":"SessionActivityAttributes", attributes:{hostId:record.hostId,sessionId:AUTOMATIC_ACTIVITY,hostName:record.hostName ?? "Mac"},
        "input-push-token":1, alert:{title:"Telar",body:"Agent work in progress"} } : {}),
    } } };
}
