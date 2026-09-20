import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http2 from "node:http2";
import { relayConfig, relayHostId } from "./relay";
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
  automaticStarts?: number;
  automaticSignal?: string;
  /** CONSECUTIVE failures; reset by any success. Twenty of them parks the
   *  record — see `PARK_AFTER_FAILURES` in worker.ts. */
  failures?: number;
  retryAt?: number;
  /**
   * STOPPED UNTIL THE PHONE ASKS AGAIN — issue #584.
   *
   * A record that has failed twenty times running is not having a bad minute;
   * something about it is wrong in a way no amount of retrying fixes, and the
   * relay bill for finding that out again every hour is real. A parked record
   * is skipped entirely and comes back the moment the phone PUTs a fresh
   * registration, which every app open does.
   */
  parked?: true;
  /** Seconds, when APNs last took something for this phone. Written only on a
   *  200 (#579) — it is what Settings shows to tell a phone that is registered
   *  from one that is actually being reached. Absent until the first one. */
  lastDeliveryAt?: number;
  /** The last send's status and Apple's word for it, for the Settings pane
   *  (#584). A status only: never a token, never a payload. */
  lastStatus?: number;
  lastReason?: string;
  /**
   * THE REVISION THE RELAY LAST ACCEPTED A REGISTRATION FOR — issue #584.
   *
   * Every push used to be TWO relay calls: a PUT of the device registration
   * followed by the POST. The registration only changes when the record does,
   * so re-sending it per push doubled the invocation count for nothing. When
   * this equals `revision`, a push is the single POST.
   */
  relayRevision?: string;
  /**
   * WHICH MAC OWNS THIS PHONE — issue #584, and the "one sender per relay host"
   * half of it. Both the MacBook and the mini held the same three records and
   * each sent everything, so every alert went twice and every dead token was
   * retried twice. This is the relay host id of the Mac the registration
   * arrived at; a Mac serves only its own.
   *
   * NOT `hostId`: that one is the PHONE's local UUID for this Mac, minted on
   * the phone (`apps/ios/TelarMobile/Stores/Host.swift`), so it is the same
   * value in both copies of the file and identifies nothing from here.
   */
  relayHostId?: string;
  updatedAt: number;
  seen: Record<string, string>;
  activitySent: Record<string, number>;
}
export type PushPayload = { aps: Record<string, unknown>; url?: string };
export type Delivery = { token: string; topic: string; sandbox: boolean; kind: "alert" | "liveactivity"; collapseId: string; payload: PushPayload };

/**
 * WHAT CAME BACK FROM A SEND — issue #584.
 *
 * A bare status was not enough to tell a DEAD device token from a bad hour.
 * Apple says which it is in the `reason` of its JSON body, and without that the
 * worker treated every 4xx as transient and retried two rejected tokens 627 and
 * 17 times over, which is most of the 173k relay invocations that exhausted the
 * account's daily quota.
 *
 * `relay` IS THE OTHER HALF OF THE SAME PROBLEM. A relay that refuses (revoked
 * host credential, expired registration, daily budget) answers with its own
 * status, and a relay 400 must never be read as Apple's verdict on a phone.
 * Absent means the status IS Apple's — which is what `sendAPNs` returns
 * directly, so the default cannot silently mislabel a direct send.
 */
export type DeliveryResult = {
  /** Apple's status — or the relay's own, when `relay` is set. */
  status: number;
  /** Apple's rejection reason, e.g. `BadDeviceToken`. A bare enum word: never a
   *  token, a payload or a provider body. */
  reason?: string;
  /** The RELAY refused, so `status` is not Apple's answer about this token. */
  relay?: true;
  /** The relay accepted a fresh device registration during this delivery, so
   *  the record's `relayRevision` may advance (#584). */
  registered?: true;
  /** Seconds from a relay 429's `Retry-After`: this host's daily budget is
   *  spent and nothing more may be sent until it resets. */
  retryAfter?: number;
};

/**
 * THE FOUR WAYS APPLE SAYS "THIS TOKEN IS GONE", plus the 410 that says it
 * without words. The owner's decision (#584): drop the record and let the app
 * re-register on its next open. Never retry a rejected token.
 *
 * 403 IS DELIBERATELY NOT HERE. It is `ExpiredProviderToken` — the relay's
 * signing key, not the phone — and treating it as terminal would delete every
 * record on the Mac the hour a key rotated. It is transient, and so is every
 * status the relay answers with itself.
 */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "ExpiredToken"]);
export function isDeadToken(result: DeliveryResult): boolean {
  if (result.relay) return false;
  return result.status === 410 || (result.status === 400 && result.reason !== undefined && DEAD_TOKEN_REASONS.has(result.reason));
}
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

/**
 * WHERE THE REGISTERED PHONES ARE KEPT — `<TELAR_HOME>/remote/mobile-push.json`.
 *
 * IT USED TO BE `remote/remote/`, AND THAT IS NOT A TYPO ANYONE MADE TWICE ON
 * PURPOSE (#665). `remoteHome()` already returns `<TELAR_HOME>/remote`, and this
 * joined `"remote"` onto it again — so every install with a phone registered
 * grew a `remote/remote/` directory nobody intended. Nothing was lost (it is
 * inside a store subtree, so a migration carries it), and nothing was broken:
 * the path was wrong consistently, which is why it survived. Its sibling
 * `storePath()` has always been `remoteHome()/remote.json`, one segment, right.
 *
 * READ BOTH, WRITE THE NEW ONE. See `legacyPushFile`.
 */
export function pushFile(): string { return path.join(remoteHome(), "mobile-push.json"); }
/**
 * The doubled path, still read so an upgrade does not un-register somebody's
 * phone — a person who had notifications would simply stop getting them, with
 * nothing on screen to say why.
 *
 * NOT DELETED WHEN IT IS READ. The first write after this lands goes to the new
 * path and the old file becomes inert; removing it would be a delete performed
 * on a read path, which is the shape that turns a downgrade into data loss. It
 * is a few hundred bytes, and `docs/storage-shape.md` names it as litter a
 * later pass may sweep once no shipped build reads it.
 */
export function legacyPushFile(): string { return path.join(remoteHome(), "remote", "mobile-push.json"); }
/**
 * `file` IS OPTIONAL RATHER THAN DEFAULTED, and that is the migration's whole
 * shape: absent means "wherever this install keeps them", which is the new path
 * and then the doubled one; present means that exact file and nothing else. A
 * caller that names a file means it, and silently reading a different one
 * because the named one was absent would make a fixture depend on the state of
 * the machine it ran on.
 */
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
export function saveRegistration(deviceId: string, registration: MobileRegistration, file?: string, ownHostId = relayHostId()): void {
  // `file` UNRESOLVED ON THE READ and resolved on the write: absent means read
  // the legacy path too and write only the new one, which is the whole of the
  // migration. See `readPushRecords`.
  const records = readPushRecords(file);
  const old = records.find(r => r.deviceId === deviceId && r.topic === registration.topic);
  // A start receipt belongs to the token it was sent to. A reinstall mints a fresh
  // pushToStartToken, so a receipt for the previous one proves nothing about this install
  // and must not close the start gate; the attempt count travels with it for the same reason.
  const keepStart = registration.liveActivities === true && old?.liveActivities === true
    && registration.pushToStartToken !== undefined && registration.pushToStartToken === old.pushToStartToken;
  // `lastDeliveryAt` TRAVELS ACROSS A RE-REGISTRATION. The phone re-registers on
  // every preference change and every token refresh; forgetting when it was
  // last reached would make Settings say "never" about a phone being pushed to
  // all day.
  // A FRESH REGISTRATION IS THE WAY BACK (#584). It un-parks the record, clears
  // the consecutive-failure count and drops any pending backoff — an app open is
  // exactly the evidence that the phone is reachable again, and it is what the
  // dead-token drop relies on to bring a re-registered phone back.
  //
  // `relayRevision` is deliberately NOT carried: the revision below is new, so
  // the relay has not seen this registration and must be sent it once.
  const next: PushRecord = { ...registration, deviceId, revision: crypto.randomUUID(), updatedAt: Date.now(), automaticStartedAt: keepStart ? old?.automaticStartedAt : undefined, automaticStarts: keepStart ? old?.automaticStarts : undefined, automaticSignal: old?.automaticSignal, lastDeliveryAt: old?.lastDeliveryAt, lastStatus: old?.lastStatus, lastReason: old?.lastReason, ...(ownHostId === undefined ? {} : { relayHostId: ownHostId }), seen: old?.seen ?? {}, baselined: old?.baselined ?? false, activitySent: old?.activitySent ?? {} };
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
/** Apple answers a rejection with `{"reason":"BadDeviceToken"}`. Only that word is
 *  taken, and only when it looks like one — no provider body travels further. */
export function appleReason(body: string): string | undefined {
  try {
    const value = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof value === "string" && /^[A-Za-z]{1,64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** APNs tokens and payloads never enter logs. Callers see only delivery status
 *  and Apple's own rejection reason. */
export async function sendAPNs(delivery: Delivery): Promise<DeliveryResult> {
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
    // BOUNDED: Apple's rejection body is a few dozen bytes. Anything past the
    // bound is dropped rather than buffered, and never logged either way.
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
