import type { EngineClient, LiveSessionRow, Project, SessionAssignment } from "@telar/engine-client";
import { needsRelayTest, relayTestDelivery, relayV2Delivery } from "./relay-v2";
import { desktopAttached, macTookAlert, notifyDesktop } from "./desktop";
import { collectReads, noteAlert, READ_SYNC_BATCH, readSyncDelivery, readSyncDue, readSyncWanted } from "./read-sync";
import { ACTIVITY_REFRESH_S, CARD_LINGER_S, tokenFingerprint, isDeadToken, notification, pushAvailable, pushConfigured, readPushRecords, sendAPNs, signalKey, writePushRecords, type Delivery, type DeliveryResult, type PushRecord, type SessionSignal } from "./push";
import { automaticActivityDelivery, automaticSessions, cardAlert, cardRows, type CardAlert } from "./card";

const RETRY_FLOOR = 30;
const RETRY_CEILING = 3600;
export const PARK_AFTER_FAILURES = 20;

export async function deliverRecord(
  record: PushRecord,
  sessions: SessionSignal[],
  send: (delivery: Delivery) => Promise<DeliveryResult>,
  now = Date.now() / 1000,
  options: { changed?: ReadonlySet<string>; macTook?: (session: SessionSignal) => boolean; readSync?: boolean } = {},
): Promise<PushRecord | undefined> {
  if (record.parked || (record.retryAt ?? 0) > now) return record;
  let failed = false;
  let delivered: number | undefined;
  let last: DeliveryResult | undefined;
  let budgetSpent: DeliveryResult | undefined;
  const safeSend = async (delivery: Delivery): Promise<DeliveryResult> => {
    if (budgetSpent) return budgetSpent;
    let result: DeliveryResult;
    try { result = await send(delivery); } catch { result = { status: 0 }; }
    last = result;
    if (result.retryAfter !== undefined) budgetSpent = result;
    if (result.status === 200) delivered = now;
    else if (!isDeadToken(result)) failed = true;
    return result;
  };
  const next: PushRecord = { ...record, seen: { ...record.seen }, activitySent: { ...record.activitySent } };
  const push = async (session: SessionSignal, payload: Delivery): Promise<"dead" | boolean> => {
    const result = await safeSend(payload);
    if (isDeadToken(result)) return "dead";
    if (result.status !== 200) return false;
    if (options.readSync) next.readSync = noteAlert(next.readSync ?? { alerted: [], pending: [] }, session.id);
    return true;
  };
  const cardLive = record.liveActivities === true && record.card !== undefined;
  const held: [SessionSignal, Delivery][] = [];
  for (const session of sessions) {
    if (options.changed && !options.changed.has(session.id) && session.id in record.seen) continue;
    const payload = notification(record, session, record.seen[session.id] ?? (record.baselined ? "new:0:0:false" : undefined));
    if (payload && !options.macTook?.(session)) {
      if (cardLive && session.activity === "blocked" && payload.payload.request === undefined) held.push([session, payload]);
      else {
        const sent = await push(session, payload);
        if (sent === "dead") return undefined;
        if (!sent) continue;
      }
    }
    next.seen[session.id] = signalKey(session);
  }
  const ids = new Set(sessions.map(s => s.id));
  for (const id of Object.keys(next.seen)) if (!ids.has(id)) delete next.seen[id];
  const alerted = await deliverCard(record, next, sessions, safeSend, now, held.length ? cardAlert(record, held.map(([s]) => s)) : undefined);
  if (!alerted) for (const [session, payload] of held) {
    const sent = await push(session, payload);
    if (sent === "dead") return undefined;
    if (!sent) next.seen[session.id] = record.seen[session.id] ?? "new:0:0:false";
  }
  if (options.readSync && next.readSync) {
    next.readSync = collectReads(next.readSync, sessions);
    if (readSyncDue(next.readSync, now)) {
      const batch = next.readSync.pending.slice(0, READ_SYNC_BATCH);
      let result: DeliveryResult;
      try { result = budgetSpent ?? await send(readSyncDelivery(record, batch)); } catch { result = { status: 0 }; }
      if (isDeadToken(result)) return undefined;
      if (result.status === 200) delivered = now;
      next.readSync = { ...next.readSync, sentAt: now, pending: result.status === 200 ? next.readSync.pending.slice(batch.length) : next.readSync.pending };
    }
  } else if (!options.readSync) delete next.readSync;
  next.failures = failed ? (record.failures ?? 0) + 1 : 0;
  next.retryAt = failed ? now + Math.min(RETRY_CEILING, RETRY_FLOOR * 2 ** Math.min(next.failures - 1, 12)) : undefined;
  if (failed && next.failures >= PARK_AFTER_FAILURES) next.parked = true; else delete next.parked;
  next.lastDeliveryAt = delivered ?? record.lastDeliveryAt;
  if (last) {
    next.lastStatus = last.status;
    if (last.reason === undefined) delete next.lastReason; else next.lastReason = last.reason;
  }
  next.baselined = true;
  return next;
}

async function deliverCard(record: PushRecord, next: PushRecord, sessions: SessionSignal[], send: (delivery: Delivery) => Promise<DeliveryResult>, now: number, alert?: CardAlert): Promise<boolean> {
  const active = record.liveActivities ? automaticSessions(sessions) : [];
  const card = record.card;
  if (!active.length) next.automaticStartedAt = undefined;
  if (active.length && !card && record.automaticStartedAt === undefined && record.pushToStartToken) {
    const result = await send(automaticActivityDelivery(record, sessions, record.pushToStartToken, now, now, "start"));
    next.automaticStart = { at: now, status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.relay ? { relay: true as const } : {}), token: tokenFingerprint(record.pushToStartToken) };
    if (result.status === 200) next.automaticStartedAt = now;
    if (isDeadToken(result)) next.pushToStartToken = undefined;
  }
  if (!card) return false;
  if (active.length) { next.automaticStartedAt = card.startedAt; delete next.cardFinishedAt; }
  const signal = JSON.stringify([record.liveActivities, record.previews, active.map(s => [s.id, signalKey(s)]), cardRows(sessions, now, record.previews)]);
  const moved = signal !== record.automaticSignal;
  const close = !record.liveActivities || (!active.length && record.cardFinishedAt !== undefined && now - record.cardFinishedAt >= CARD_LINGER_S);
  const beat = active.length > 0 && now - (record.activitySent[card.token] ?? 0) >= ACTIVITY_REFRESH_S;
  if (!close && !moved && !beat && !alert) return false;
  const result = await send(automaticActivityDelivery(record, sessions, card.token, card.startedAt, now, close ? "end" : "update", close ? undefined : alert));
  if (isDeadToken(result) || (result.status === 200 && close)) {
    delete next.card; delete next.cardFinishedAt;
    delete next.activitySent[card.token];
    return false;
  }
  if (result.status !== 200) return false;
  next.activitySent[card.token] = now; next.automaticSignal = signal;
  if (!active.length) next.cardFinishedAt = record.cardFinishedAt ?? now;
  return alert !== undefined;
}

const POLL_INTERVAL = 10_000;
const RECONCILE_INTERVAL = 600_000;
const HEARTBEAT_INTERVAL = ACTIVITY_REFRESH_S * 1000;
export const FEED_COALESCE_MS = 250;
export function frameAction(dueAt: number | undefined, running: boolean, now: number): "after-pass" | "join" | "schedule" {
  if (running) return "after-pass";
  return dueAt !== undefined && dueAt - now <= FEED_COALESCE_MS ? "join" : "schedule";
}

type WorkerState = {
  telarMobilePushTimer?: ReturnType<typeof setTimeout>;
  telarMobilePushDueAt?: number;
  telarMobilePushRunning?: boolean;
  telarMobilePushNudged?: boolean;
  telarMobilePushPausedUntil?: number;
  telarMobilePushSnapshot?: SessionSignal[];
  telarMobilePushETag?: string;
  telarMobilePushReconciledAt?: number;
  telarMobilePushBeatAt?: number;
  telarMobilePushFeedOpen?: boolean;
  telarMobilePushHeartbeat?: boolean;
  telarMobilePushFeedStop?: () => void;
  telarMobilePushDeps?: PushWorkerDeps;
};
export type PushWorkerDeps = { client: () => EngineClient; fullDevices: () => string[] };
const workerGlobal = globalThis as typeof globalThis & WorkerState;
const deps = (): PushWorkerDeps => {
  if (!workerGlobal.telarMobilePushDeps) throw new Error("the push worker was not started");
  return workerGlobal.telarMobilePushDeps;
};

export function pushPausedUntil(now = Date.now()): number | undefined {
  const until = workerGlobal.telarMobilePushPausedUntil;
  if (until === undefined) return undefined;
  if (until <= now) { delete workerGlobal.telarMobilePushPausedUntil; return undefined; }
  return until;
}

export function pauseHost(seconds: number, now = Date.now()): void {
  workerGlobal.telarMobilePushPausedUntil = now + seconds * 1000;
}

export function canReach(record: PushRecord, direct: boolean): boolean {
  return record.relay !== undefined || direct;
}

export function sendableRecords(records: PushRecord[], direct: boolean): PushRecord[] {
  return records.filter(record => !record.parked && canReach(record, direct));
}

export const PARKED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function stalePushRecords(records: PushRecord[], now = Date.now()): PushRecord[] {
  const live = new Set(records.filter(record => !record.parked).map(record => record.deviceId));
  return records.filter(record =>
    record.parked && (live.has(record.deviceId) || now - record.updatedAt >= PARKED_TTL_MS));
}

export function changedSessions(sessions: SessionSignal[], previous: SessionSignal[] | undefined): Set<string> {
  const before = new Map((previous ?? []).map(session => [session.id, signalKey(session)]));
  const changed = new Set<string>();
  for (const session of sessions) if (before.get(session.id) !== signalKey(session)) changed.add(session.id);
  return changed;
}

const APPROVABLE = new Set(["command_execution", "file_change", "file_read", "tool_call"]);
export async function markApprovable(
  sessions: SessionSignal[],
  changed: ReadonlySet<string> | undefined,
  read: (sessionId: string) => Promise<{ requests: ReadonlyArray<{ id: string; state: string; detail: { kind: string } }> }>,
): Promise<void> {
  for (const session of sessions) {
    if (session.activity !== "blocked" || (changed && !changed.has(session.id))) continue;
    try {
      const open = (await read(session.id)).requests.filter(request => request.state === "open");
      if (open.length === 1 && APPROVABLE.has(open[0].detail.kind)) session.approvable = open[0].id;
    } catch { }
  }
}

function liveParent(session: LiveSessionRow, rows: ReadonlyMap<string, LiveSessionRow>, assignments: SessionAssignment[] = [], now: number): string | undefined {
  const assigned = assignments.filter(task => task.outcome !== "detached").sort((a, b) => a.receivedAt - b.receivedAt)[0];
  const parent = rows.get(session.startedFrom?.sessionId ?? assigned?.fromSessionId ?? "");
  if (!parent || parent.id === session.id || parent.state === "archived" || parent.settledOverride === "settled") return;
  return parent.snoozedUntil !== undefined && parent.snoozedUntil > now ? undefined : parent.id;
}

export function signals(sessions: readonly LiveSessionRow[], assignments: Record<string, SessionAssignment[]> = {}, projects: readonly Project[] = [], now = Date.now()): SessionSignal[] {
  const delegating = new Set(Object.values(assignments).flat().filter(task => task.outcome === undefined).map(task => task.fromSessionId));
  const names = new Map(projects.map(p => [p.id, p.name]));
  const rows = new Map(sessions.map(s => [s.id, s]));
  return sessions.map(session => {
    const { id, title, activity, activityAt, lastTurnEndedAt, lastTurnFailed, lastTurnOrigin, startedFrom, projectId, lastTurnSequence, lastReadTurnSequence } = session;
    const parentId = liveParent(session, rows, assignments[id], now);
    return {
      id, title, activity,
      ...(startedFrom !== undefined || assignments[id]?.some(task => task.outcome !== "detached") ? { hasParent: true } : {}),
      ...(parentId === undefined ? {} : { parentId }),
      ...(delegating.has(id) ? { delegating: true } : {}),
      ...(lastTurnOrigin === undefined ? {} : { lastTurnOrigin }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(projectId !== undefined && names.has(projectId) ? { project: names.get(projectId)! } : {}),
      ...(activityAt === undefined ? {} : { activityAt }),
      ...(lastTurnSequence === undefined ? {} : { lastTurnSequence }),
      ...(lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence }),
      ...(lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt }),
      ...(lastTurnFailed === undefined ? {} : { lastTurnFailed }),
    };
  });
}

export function heartbeatWanted(records: PushRecord[], sessions: SessionSignal[]): boolean {
  return records.some(record => record.card !== undefined && (record.cardFinishedAt !== undefined || automaticSessions(sessions).length > 0));
}
export function readSyncPass(records: PushRecord[], sessions: SessionSignal[], now: number): { due: boolean; waiting: boolean } {
  return {
    due: records.some(record => readSyncWanted(record.readSync, sessions, now)),
    waiting: records.some(record => !!record.readSync?.pending.length),
  };
}
export function heartbeatDue(records: PushRecord[], sessions: SessionSignal[], since: number | undefined, now: number): boolean {
  if (!heartbeatWanted(records, sessions)) return false;
  return since === undefined || now - since >= HEARTBEAT_INTERVAL;
}

export function pollDelay(feedConnected: boolean, heartbeat = false): number {
  if (feedConnected && heartbeat) return HEARTBEAT_INTERVAL;
  return feedConnected ? RECONCILE_INTERVAL : POLL_INTERVAL;
}

export function passesOver(minutes: number, feedConnected: boolean): number {
  return Math.floor((minutes * 60_000) / pollDelay(feedConnected));
}

function openSessionFeed(onFrame: () => void): void {
  if (workerGlobal.telarMobilePushFeedStop) return;
  const controller = new AbortController();
  workerGlobal.telarMobilePushFeedStop = () => {
    workerGlobal.telarMobilePushFeedOpen = false;
    delete workerGlobal.telarMobilePushFeedStop;
    controller.abort();
  };
  void (async () => {
    try {
      const stream = deps().client().sessionsStream();
      const upstream = await fetch(stream.url, { headers: stream.headers, signal: controller.signal });
      if (!upstream.ok || !upstream.body) throw new Error("the engine did not open the session feed");
      workerGlobal.telarMobilePushFeedOpen = true;
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        if (lines.some((line) => line.startsWith("data: "))) onFrame();
      }
    } catch {
    } finally {
      workerGlobal.telarMobilePushFeedOpen = false;
      delete workerGlobal.telarMobilePushFeedStop;
    }
  })();
}

export async function sendRelayTest(deviceId: string, topic: string, send = relayV2Delivery): Promise<void> {
  const record = readPushRecords().find(r => r.deviceId === deviceId && r.topic === topic);
  if (!record?.relay || !needsRelayTest(record)) return;
  let result: DeliveryResult;
  try { result = await send(record.relay, relayTestDelivery(record)); } catch { result = { status: 0, relay: true }; }
  const records = readPushRecords();
  const current = records.find(r => r.deviceId === deviceId && r.topic === topic);
  if (!current || current.relay?.keyId !== record.relay.keyId) return;
  const at = Date.now() / 1000;
  current.relayTest = { keyId: record.relay.keyId, at, status: result.status, ...(result.reason === undefined ? {} : { reason: result.reason }), ...(result.relay ? { relay: true as const } : {}) };
  if (result.status === 200 && !result.relay) current.lastDeliveryAt = at;
  writePushRecords(records);
}

export function stopMobilePushWorker(): void {
  if (workerGlobal.telarMobilePushTimer) clearTimeout(workerGlobal.telarMobilePushTimer);
  delete workerGlobal.telarMobilePushTimer;
  workerGlobal.telarMobilePushFeedStop?.();
}

export function startMobilePushWorker(given?: PushWorkerDeps): void {
  if (given) workerGlobal.telarMobilePushDeps = given;
  const desktop = desktopAttached();
  if (workerGlobal.telarMobilePushTimer || !workerGlobal.telarMobilePushDeps || (!pushAvailable() && !desktop)) return;
  const schedule = (delay: number) => {
    if (workerGlobal.telarMobilePushTimer) clearTimeout(workerGlobal.telarMobilePushTimer);
    workerGlobal.telarMobilePushDueAt = Date.now() + delay;
    workerGlobal.telarMobilePushTimer = setTimeout(tick, delay);
    workerGlobal.telarMobilePushTimer.unref();
  };
  const tick = async () => {
    workerGlobal.telarMobilePushRunning = true;
    workerGlobal.telarMobilePushNudged = false;
    delete workerGlobal.telarMobilePushDueAt;
    workerGlobal.telarMobilePushHeartbeat = false;
    try {
      const nowMs = Date.now();
      const direct = pushConfigured();
      const stored = pushPausedUntil(nowMs) === undefined ? readPushRecords() : [];

      const paired = new Set(stored.length ? deps().fullDevices() : []);
      for (const record of stored) {
        if (paired.has(record.deviceId)) continue;
        writePushRecords(readPushRecords().filter(r => r.deviceId !== record.deviceId));
      }
      if (stored.length) {
        const current = readPushRecords();
        const stale = new Set(stalePushRecords(current, nowMs));
        if (stale.size) writePushRecords(current.filter(r => !stale.has(r)));
      }
      const records = stored.length ? sendableRecords(readPushRecords(), direct) : [];
      if (!records.length && !desktopAttached()) return;

      const reconcile = nowMs - (workerGlobal.telarMobilePushReconciledAt ?? 0) >= RECONCILE_INTERVAL;
      const api = deps().client();
      const etag = reconcile ? undefined : workerGlobal.telarMobilePushETag;
      const answer = await api.liveSessionsMatching({ all: true, ...(etag === undefined ? {} : { etag }) });
      if (reconcile) workerGlobal.telarMobilePushReconciledAt = nowMs;

      let sessions: SessionSignal[];
      let changed: ReadonlySet<string> | undefined;
      if (answer.notModified) {
        sessions = workerGlobal.telarMobilePushSnapshot ?? [];
        const reads = readSyncPass(records, sessions, nowMs / 1000);
        workerGlobal.telarMobilePushHeartbeat = heartbeatWanted(records, sessions) || reads.waiting;
        if (!heartbeatDue(records, sessions, workerGlobal.telarMobilePushBeatAt, nowMs) && !reads.due) return;
        changed = new Set<string>();
      } else {
        sessions = signals(answer.sessions, answer.assignments, answer.projects);
        if (answer.etag !== undefined) workerGlobal.telarMobilePushETag = answer.etag;
        changed = reconcile ? undefined : changedSessions(sessions, workerGlobal.telarMobilePushSnapshot);
        workerGlobal.telarMobilePushSnapshot = sessions;
        await markApprovable(sessions, changed, id => api.session(id, { turns: 1 }));
        if (desktopAttached()) notifyDesktop(sessions, changed);
        const reads = readSyncPass(records, sessions, nowMs / 1000);
        workerGlobal.telarMobilePushHeartbeat = heartbeatWanted(records, sessions) || reads.waiting;
        if (changed && changed.size === 0 && !heartbeatDue(records, sessions, workerGlobal.telarMobilePushBeatAt, nowMs) && !reads.due) return;
      }
      workerGlobal.telarMobilePushBeatAt = nowMs;

      for (const record of records) {
        if (pushPausedUntil(Date.now()) !== undefined) break;
        const narrow = record.failures ? undefined : changed;
        const result = await deliverRecord(record, sessions, async delivery => {
          if (!deps().fullDevices().includes(record.deviceId)) return { status: 410 };
          if (!readPushRecords().some(r => r.revision === record.revision)) return { status: 409, relay: true };
          const sent = record.relay ? await relayV2Delivery(record.relay, delivery) : await sendAPNs(delivery);
          if (sent.retryAfter !== undefined) pauseHost(sent.retryAfter);
          return sent;
        }, Date.now() / 1000, { macTook: macTookAlert, ...(narrow === undefined ? {} : { changed: narrow }), readSync: true });
        if (result?.readSync?.pending.length) workerGlobal.telarMobilePushHeartbeat = true;
        const current = readPushRecords();
        const index = current.findIndex(r => r.revision === record.revision);
        if (index >= 0) {
          if (result) current[index] = result; else current.splice(index, 1);
          writePushRecords(current);
        } else if (result?.automaticStartedAt) {
          const refreshed = current.find(r => r.deviceId === record.deviceId && r.topic === record.topic && r.liveActivities);
          if (refreshed && !refreshed.automaticStartedAt) {
            refreshed.automaticStartedAt = result.automaticStartedAt;
            writePushRecords(current);
          }
        }
      }
    } catch {
      console.warn("[mobile-push] Delivery unavailable; retrying.");
    } finally {
      workerGlobal.telarMobilePushRunning = false;
      schedule(workerGlobal.telarMobilePushNudged ? FEED_COALESCE_MS : pollDelay(workerGlobal.telarMobilePushFeedOpen === true, workerGlobal.telarMobilePushHeartbeat === true));
    }
  };
  schedule(0);
  openSessionFeed(() => {
    const action = frameAction(workerGlobal.telarMobilePushDueAt, workerGlobal.telarMobilePushRunning === true, Date.now());
    if (action === "after-pass") workerGlobal.telarMobilePushNudged = true;
    else if (action === "schedule") schedule(FEED_COALESCE_MS);
  });
}
