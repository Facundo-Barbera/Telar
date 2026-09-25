import { relayConfig, relayDelivery, relayHostId, revokeRelayDevice } from "./relay";
import { engineClient } from "../engine/engine-server";
import { readRemote } from "../remote/store";
import { needsRelayTest, relayTestDelivery, relayV2Delivery } from "./relay-v2";
import { desktopAttached, listenForDesktop, notifyDesktop } from "./desktop";
import { ACTIVITY_REFRESH_S, AUTOMATIC_ACTIVITY, AUTOMATIC_START_ATTEMPTS, automaticSessions, automaticActivityDelivery, activityDelivery, isDeadToken, notification, pushAvailable, pushConfigured, readPushRecords, sendAPNs, signalKey, writePushRecords, type Delivery, type DeliveryResult, type PushRecord, type SessionSignal } from "./push";

/** A phone that actually ran the start reports the activity's token within seconds: iOS delivers it
 *  on `activityUpdates` and the app re-registers straight away. A receipt still standing alone after
 *  300s therefore means the start never landed — Apple accepted it for a token from a previous
 *  install, or Live Activities are off in Settings — so the receipt is dropped and the start retried. */
const AUTOMATIC_START_STALE = 300;

/**
 * BACKOFF FOR A BAD HOUR, NOT FOR A DEAD PHONE — issue #584.
 *
 * The old ceiling was five minutes, which is 288 attempts a day per record and
 * — with two relay calls per attempt and a rate limiter at 120/minute — exactly
 * the shape of the 173k invocations that exhausted the Cloudflare account's
 * daily quota. Thirty seconds to an hour is fast enough that a phone which was
 * briefly unreachable still gets its alert, and slow enough that one which is
 * permanently unreachable costs 24 calls a day rather than thousands.
 */
const RETRY_FLOOR = 30;
const RETRY_CEILING = 3600;
/**
 * …AND AFTER TWENTY IN A ROW, STOP ASKING. One of the owner's three records had
 * failed 627 times running. Nothing about the twentieth attempt is more likely
 * to work than the six-hundredth; a parked record waits for the phone to PUT a
 * fresh registration, which every app open does.
 */
export const PARK_AFTER_FAILURES = 20;

/** Fold after successful delivery only. First sight baselines history, not a burst of old alerts. */
export async function deliverRecord(
  record: PushRecord,
  sessions: SessionSignal[],
  send: (delivery: Delivery) => Promise<DeliveryResult>,
  now = Date.now() / 1000,
  options: { changed?: ReadonlySet<string> } = {},
): Promise<PushRecord | undefined> {
  if (record.parked || (record.retryAt ?? 0) > now) return record;
  let failed = false;
  // WHEN APNS LAST TOOK SOMETHING, for the Settings pane that has to tell a
  // phone which is merely registered from one which is actually being reached
  // (#579). A 410 is the device saying it is gone; that is not a delivery.
  let delivered: number | undefined;
  let last: DeliveryResult | undefined;
  /** Advances only when the relay accepts a registration, so the next push can
   *  skip the PUT and be one call (#584). */
  let relayRevision = record.relayRevision;
  /** The relay's daily budget is spent. Spending further calls to be told so
   *  again is the failure this guard exists to prevent, so the rest of this
   *  record's sends are answered from here without touching the network. */
  let budgetSpent: DeliveryResult | undefined;
  const safeSend = async (delivery: Delivery): Promise<DeliveryResult> => {
    if (budgetSpent) return budgetSpent;
    let result: DeliveryResult;
    try { result = await send(delivery); } catch { result = { status: 0 }; }
    last = result;
    if (result.retryAfter !== undefined) budgetSpent = result;
    if (result.registered) relayRevision = record.revision;
    if (result.status === 200) delivered = now;
    // A DEAD TOKEN IS NOT A FAILURE TO RETRY, it is an answer: the caller drops
    // what it names. Counting it would park a record that is already going away.
    else if (!isDeadToken(result)) failed = true;
    return result;
  };
  const next: PushRecord = { ...record, seen: { ...record.seen }, activitySent: { ...record.activitySent }, activities: [...record.activities] };
  for (const session of sessions) {
    // ONLY WHAT MOVED (#584). A session whose signal has not changed since the
    // last pass has nothing to say, and its checkpoint already equals its
    // signal — so skipping it changes no state. One this record has never seen
    // is the exception: it still has to be baselined.
    if (options.changed && !options.changed.has(session.id) && session.id in record.seen) continue;
    const payload = notification(record, session, record.seen[session.id] ?? (record.baselined ? "new:0:0:false" : undefined));
    if (payload) {
      const result = await safeSend(payload);
      // Apple has rejected this phone's token for good. The record goes; the
      // app re-registers on its next open and pairing is untouched.
      if (isDeadToken(result)) return undefined;
      if (result.status !== 200) continue;
    }
    next.seen[session.id] = signalKey(session);
  }
  const ids = new Set(sessions.map(s => s.id));
  for (const id of Object.keys(next.seen)) if (!ids.has(id)) delete next.seen[id];
  const active = automaticSessions(sessions);
  const automatic = record.activities.filter(a => a.sessionId === AUTOMATIC_ACTIVITY);
  const aggregateSignal = JSON.stringify([record.liveActivities, record.previews, active.map(s => [s.id, signalKey(s)])]);
  // A receipt with no activity registered against it is evidence of nothing; it must not gate
  // the start forever. Failed sends are held off by retryAt instead and never spend an attempt.
  const staleStart = record.automaticStartedAt !== undefined && !automatic.length && now - record.automaticStartedAt >= AUTOMATIC_START_STALE;
  if (!active.length) { next.automaticStartedAt = undefined; next.automaticStarts = undefined; }
  if (record.liveActivities && active.length && !automatic.length && (!record.automaticStartedAt || staleStart)
      && record.pushToStartToken && (record.automaticStarts ?? 0) < AUTOMATIC_START_ATTEMPTS) {
    const result = await safeSend(automaticActivityDelivery(record, sessions, record.pushToStartToken, now, now, true));
    next.automaticStart = { at: now, status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.relay ? { relay: true as const } : {}) };
    if (result.status === 200) { next.automaticStartedAt = now; next.automaticStarts = (record.automaticStarts ?? 0) + 1; }
    // Expiration of a start token must never unregister ordinary phone notifications.
    if (isDeadToken(result)) next.pushToStartToken = undefined;
  }
  for (const follow of automatic) {
    // The activity exists, so the start it came from worked: the attempt count has done its job.
    if (active.length && record.liveActivities) { next.automaticStartedAt = follow.startedAt; next.automaticStarts = undefined; }
    if (aggregateSignal === record.automaticSignal && now - (record.activitySent[follow.token] ?? 0) < ACTIVITY_REFRESH_S) continue;
    const result = await safeSend(automaticActivityDelivery(record, sessions, follow.token, follow.startedAt, now));
    if (isDeadToken(result) || (result.status === 200 && (!active.length || !record.liveActivities))) {
      next.activities = next.activities.filter(a => a.token !== follow.token);
      delete next.activitySent[follow.token];
    } else if (result.status === 200) { next.activitySent[follow.token] = now; next.automaticSignal = aggregateSignal; }
  }
  for (const follow of record.activities.filter(a => a.sessionId !== AUTOMATIC_ACTIVITY)) {
    const session = sessions.find(s => s.id === follow.sessionId);
    const changed = session && record.seen[session.id] !== signalKey(session);
    if (!changed && now - (record.activitySent[follow.token] ?? 0) < ACTIVITY_REFRESH_S) continue;
    const result = await safeSend(activityDelivery(record, follow, session, now));
    if (isDeadToken(result) || (result.status === 200 && (!session || session.activity === "idle"))) {
      next.activities = next.activities.filter(a => a.token !== follow.token);
      delete next.activitySent[follow.token];
    } else if (result.status === 200) next.activitySent[follow.token] = now;
  }
  next.failures = failed ? (record.failures ?? 0) + 1 : 0;
  next.retryAt = failed ? now + Math.min(RETRY_CEILING, RETRY_FLOOR * 2 ** Math.min(next.failures - 1, 12)) : undefined;
  if (failed && next.failures >= PARK_AFTER_FAILURES) next.parked = true; else delete next.parked;
  next.lastDeliveryAt = delivered ?? record.lastDeliveryAt;
  if (last) {
    next.lastStatus = last.status;
    if (last.reason === undefined) delete next.lastReason; else next.lastReason = last.reason;
  }
  next.relayRevision = relayRevision;
  next.baselined = true;
  return next;
}

/**
 * HOW OFTEN THIS MAC LOOKS, AND WHAT IT COSTS TO LOOK — issue #584.
 *
 * The old loop woke every 5 seconds and asked the engine to fold EVERY session
 * (`liveSessions({all:true})`, 407 rows on the owner's store) to discover that
 * nothing had happened. `liveSessionsMatching` is the same wide read with an
 * ETag on it: a quiet tick is a 304 with no body and no fold, and the records
 * are not touched at all — so a quiet hour now costs zero relay calls, which is
 * the whole point.
 *
 * TEN SECONDS, NOT FIVE. An alert about a session that needs you can be ten
 * seconds late; what it cannot be is a per-record relay call every five.
 *
 * ── AND SINCE #586 IT IS A SUBSCRIPTION ─────────────────────────────────────
 *
 * The note here used to read "NOT YET A SUBSCRIPTION… the engine has none to
 * give". The engine has one now: `/v2/sessions/stream`, emitted at
 * `appendEvent`, which is the single chokepoint every session event passes
 * through. So this worker stops asking every ten seconds whether anything
 * happened and is TOLD.
 *
 * THE TEN-MINUTE RECONCILE STAYS, and it is what makes the feed safe to rely
 * on. A frame is never the record: it names a fact re-derivable from a read,
 * so a worker that missed one — a dropped connection, a daemon restart, a
 * frame written while this process was busy — loses latency and nothing else,
 * because the unconditional wide pass still comes round. Removing it would
 * turn a latency optimisation into a second source of truth, which is exactly
 * what this feed's design refuses.
 *
 * SO THE TIMER'S CADENCE FOLLOWS THE FEED. Connected, it is the reconcile and
 * nothing else; disconnected, it falls straight back to the ten seconds it
 * always was. See `pollDelay`.
 */
const POLL_INTERVAL = 10_000;
/** The safety net, not the mechanism: an unconditional wide pass that re-reads
 *  every record against every session, in case an ETag or a snapshot ever drifts
 *  out of step with the truth. Ten minutes, not five seconds. */
const RECONCILE_INTERVAL = 600_000;
/** A Live Activity whose timestamp stops moving goes stale on the lock screen,
 *  so one that is REGISTERED and has live work behind it is refreshed on this
 *  cadence even when no signal changed. Nothing else wakes on it. */
const HEARTBEAT_INTERVAL = ACTIVITY_REFRESH_S * 1000;
/** How long a frame waits for its neighbours before the pass runs. A turn
 *  ending writes several events at once, and one wide pass for the burst is
 *  the point — long enough to coalesce, short enough that "immediate" is still
 *  the honest word for it. */
const FEED_COALESCE_MS = 250;

type WorkerState = {
  telarMobilePushTimer?: ReturnType<typeof setTimeout>;
  /** Milliseconds. The relay answered 429 with a `Retry-After`: this host's
   *  daily budget is spent and nothing is sent until it resets (#584). */
  telarMobilePushPausedUntil?: number;
  /** The session list as of the last pass. The diff against it is what
   *  "evaluate only the affected session" is made of — and on a 304 it is what
   *  a Live Activity heartbeat refreshes from, so an unchanged tick never asks
   *  the engine to fold the list a second time. */
  telarMobilePushSnapshot?: SessionSignal[];
  telarMobilePushETag?: string;
  telarMobilePushReconciledAt?: number;
  telarMobilePushBeatAt?: number;
  /** The session feed is connected, so the timer below is a safety net rather
   *  than the mechanism — see `pollDelay` (#586). */
  telarMobilePushFeedOpen?: boolean;
  /** A Live Activity with work behind it needs refreshing before it goes stale. */
  telarMobilePushHeartbeat?: boolean;
  telarMobilePushFeedStop?: () => void;
};
const workerGlobal = globalThis as typeof globalThis & WorkerState;

/** When this host may send again, or undefined when it is not paused. Read by
 *  Settings so "push paused until…" is the relay's own answer, not a guess. */
export function pushPausedUntil(now = Date.now()): number | undefined {
  const until = workerGlobal.telarMobilePushPausedUntil;
  if (until === undefined) return undefined;
  if (until <= now) { delete workerGlobal.telarMobilePushPausedUntil; return undefined; }
  return until;
}

/** The relay said how long to wait. Honour it for every record on this host. */
export function pauseHost(seconds: number, now = Date.now()): void {
  workerGlobal.telarMobilePushPausedUntil = now + seconds * 1000;
}

/**
 * WHICH RECORDS ARE THIS MAC'S TO SEND — issue #584.
 *
 * Two Macs held the same three records and each served all of them, so every
 * alert arrived twice and every dead token was retried twice. A record is
 * stamped at registration with the relay host id of the Mac it registered
 * against; a Mac serves only its own, and leaves every other record untouched
 * rather than deleting it — the other Mac is still using it.
 *
 * A Mac with no relay id serves the records that carry none, which is the
 * single-Mac install and the local-APNs-key one. A record stamped for another
 * host on a Mac that has no id of its own is NOT served: it plainly belongs to
 * somebody else.
 */
export function ownRecords(records: PushRecord[], ownHostId: string | undefined): PushRecord[] {
  return records.filter(record => record.relayHostId === ownHostId);
}

/** The sessions whose signal moved since the last pass, plus every one this Mac
 *  has not seen before. Everything else is, by definition, nothing to say. */
export function changedSessions(sessions: SessionSignal[], previous: SessionSignal[] | undefined): Set<string> {
  const before = new Map((previous ?? []).map(session => [session.id, signalKey(session)]));
  const changed = new Set<string>();
  for (const session of sessions) if (before.get(session.id) !== signalKey(session)) changed.add(session.id);
  return changed;
}

/**
 * WHICH BLOCKED SESSIONS CAN BE APPROVED FROM THE NOTIFICATION ITSELF.
 *
 * Only when exactly one request is open and it is an approval (a command, an
 * edit, a read, a tool call). A question needs an answer typed on the phone,
 * and a secret is never released from a lock screen, so both keep Open only.
 * The alert names THAT request; the phone resolves it and nothing else, so a
 * tap on a stale notification cannot approve something newer. Read only for
 * sessions whose signal moved, which is when an alert can go at all.
 */
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
    } catch { /* The alert still goes, with Open only. */ }
  }
}

/** Only the fields a notification is made of. Keeping the engine's whole row in
 *  a module global would hold a copy of every session's state for ever. */
function signals(sessions: readonly SessionSignal[]): SessionSignal[] {
  return sessions.map(({ id, title, activity, activityAt, lastTurnEndedAt, lastTurnFailed, projectId }) => ({
    id, title, activity,
    ...(projectId === undefined ? {} : { projectId }),
    ...(activityAt === undefined ? {} : { activityAt }),
    ...(lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt }),
    ...(lastTurnFailed === undefined ? {} : { lastTurnFailed }),
  }));
}

/** Whether some Live Activity has to be kept fresh: one registered, and work
 *  actually behind it. ANY registered card, not only the automatic one: a
 *  followed session's card is kept fresh even with the automatic one off. */
export function heartbeatWanted(records: PushRecord[], sessions: SessionSignal[]): boolean {
  return records.some(record => record.activities.length > 0) && automaticSessions(sessions).length > 0;
}
/** Whether a Live Activity has to be refreshed on a tick where no session
 *  signal moved. */
export function heartbeatDue(records: PushRecord[], sessions: SessionSignal[], since: number | undefined, now: number): boolean {
  if (!heartbeatWanted(records, sessions)) return false;
  return since === undefined || now - since >= HEARTBEAT_INTERVAL;
}

/**
 * HOW LONG UNTIL THE NEXT UNCONDITIONAL PASS — issue #586.
 *
 * CONNECTED, THE TIMER IS THE SAFETY NET AND NOT THE MECHANISM: frames wake
 * the work, so the only reason left to tick is the reconcile that catches
 * whatever a frame failed to deliver. DISCONNECTED, it is the ten seconds this
 * worker always ran at — the feed being unavailable must cost latency, never
 * correctness.
 *
 * A FUNCTION RATHER THAN A TERNARY AT THE CALL SITE, so the saving can be
 * counted in a test: over ten simulated minutes this is one pass connected
 * against sixty disconnected, and that ratio is the whole of what #586 buys
 * this worker.
 */
export function pollDelay(feedConnected: boolean, heartbeat = false): number {
  // A LIVE ACTIVITY IS THE EXCEPTION. Connected, nothing else would wake this
  // worker for ten minutes, and a card waiting on a blocked session emits no
  // frames: it went stale after three and read "Waiting for an update" for
  // the rest. While one needs refreshing the timer runs at the heartbeat.
  if (feedConnected && heartbeat) return HEARTBEAT_INTERVAL;
  return feedConnected ? RECONCILE_INTERVAL : POLL_INTERVAL;
}

/** How many unconditional passes a given stretch of time costs at that
 *  cadence. Pure, and exported so the proof is arithmetic over the REAL
 *  constants rather than over numbers a test restated. */
export function passesOver(minutes: number, feedConnected: boolean): number {
  return Math.floor((minutes * 60_000) / pollDelay(feedConnected));
}

/**
 * OPEN THE SESSION FEED AND NUDGE ON EVERY FRAME — issue #586.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FRAME IS NOT READ FOR ITS CONTENT, and that is deliberate. A frame names
 * which session moved and which event id; this worker's pass already re-reads
 * the wide list conditionally and diffs it, so all a frame has to do is say
 * "now" — the work of deciding what changed stays in one place rather than
 * being half in the feed and half in the pass.
 *
 * WHICH ALSO MAKES A MISSED FRAME HARMLESS. The reconcile comes round either
 * way, so the worst a dropped connection costs is the latency it was bought to
 * remove.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * RECONNECTION IS THE TIMER'S JOB, NOT A LOOP'S. On any end — a daemon
 * restart, a severed socket — the flag goes down and the next tick falls back
 * to the ten-second cadence, which is also what re-opens this. So there is no
 * backoff to tune and no reconnect storm to have: the feed is an optimisation
 * that reapplies itself when it can.
 */
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
      const stream = (await engineClient()).sessionsStream();
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
        // `: open` and `: beat` are comments and carry nothing; only a data
        // frame is a reason to look.
        if (lines.some((line) => line.startsWith("data: "))) onFrame();
      }
    } catch {
      // Including the abort on shutdown. Nothing is logged: a feed that is not
      // there is a latency cost, not an error a person can act on.
    } finally {
      workerGlobal.telarMobilePushFeedOpen = false;
      delete workerGlobal.telarMobilePushFeedStop;
    }
  })();
}

/**
 * SEND THE TEST ALERT FOR A NEW RELAY KEY, AND KEEP WHAT APPLE SAID.
 *
 * Called when a phone registers: straight after pairing, and again whenever it
 * mints a new key. Settings reads the answer back as "working" or the exact
 * reason, so a phone that cannot be reached says so the moment it is paired
 * rather than the first time something important goes missing.
 */
export async function sendRelayTest(deviceId: string, topic: string, send = relayV2Delivery): Promise<void> {
  const record = readPushRecords().find(r => r.deviceId === deviceId && r.topic === topic);
  if (!record?.relay || !needsRelayTest(record)) return;
  let result: DeliveryResult;
  try { result = await send(record.relay, relayTestDelivery(record)); } catch { result = { status: 0, relay: true }; }
  const records = readPushRecords();
  const current = records.find(r => r.deviceId === deviceId && r.topic === topic);
  // The phone re-registered with another key while this was in flight: that key earns its own test.
  if (!current || current.relay?.keyId !== record.relay.keyId) return;
  const at = Date.now() / 1000;
  current.relayTest = { keyId: record.relay.keyId, at, status: result.status, ...(result.reason === undefined ? {} : { reason: result.reason }), ...(result.relay ? { relay: true as const } : {}) };
  if (result.status === 200 && !result.relay) current.lastDeliveryAt = at;
  writePushRecords(records);
}

export function startMobilePushWorker(): void {
  // THE MAC'S OWN NOTIFICATIONS RIDE THIS PASS (`desktop.ts`): the same feed,
  // the same diff, the same `markApprovable` — so a Mac with no phone still
  // runs it when the shell asked for desktop notices.
  const desktop = desktopAttached();
  if (workerGlobal.telarMobilePushTimer || (!pushAvailable() && !desktop) || process.env.TELAR_COCKPIT !== "1") return;
  if (desktop) listenForDesktop(async (sessionId, requestId, input) => (await engineClient()).resolveRequest(sessionId, requestId, input));
  const tick = async () => {
    // Recomputed every pass; any early return below leaves the ordinary cadence.
    workerGlobal.telarMobilePushHeartbeat = false;
    try {
      const nowMs = Date.now();
      const relay = relayConfig();
      const ownHostId = relayHostId();
      // PAUSED MEANS PAUSED — for the phones. Not a cheaper tick, not the
      // activities only: the relay has said this host is over its daily
      // budget, and the one useful thing to do with that is stop until it says
      // otherwise. The Mac's own notices spend no relay budget and carry on.
      const stored = pushPausedUntil(nowMs) === undefined ? readPushRecords() : [];

      // Sweep revoked devices first — it is the one thing that must happen
      // whether or not a session moved, and it touches only this Mac's records.
      const paired = new Set(stored.length ? readRemote().devices.filter(d => d.role === "full").map(d => d.id) : []);
      for (const record of ownRecords(stored, ownHostId)) {
        if (paired.has(record.deviceId)) continue;
        // A v2 phone revokes its own key at the relay when it unpairs; there is nothing here to revoke.
        if (relay && !record.relay) await revokeRelayDevice(relay, record.deviceId);
        writePushRecords(readPushRecords().filter(r => r.deviceId !== record.deviceId));
      }
      const records = stored.length ? ownRecords(readPushRecords(), ownHostId).filter(record => !record.parked) : [];
      if (!records.length && !desktop) return;

      const reconcile = nowMs - (workerGlobal.telarMobilePushReconciledAt ?? 0) >= RECONCILE_INTERVAL;
      const api = await engineClient();
      // THE WIDE LIST, CONDITIONALLY (#457 wanted all of it; #584 wants it to
      // cost nothing when it has not moved). A reconcile hands back no ETag, so
      // it is the same call made unconditionally — and it mints a fresh tag.
      const etag = reconcile ? undefined : workerGlobal.telarMobilePushETag;
      const answer = await api.liveSessionsMatching({ all: true, ...(etag === undefined ? {} : { etag }) });
      if (reconcile) workerGlobal.telarMobilePushReconciledAt = nowMs;

      let sessions: SessionSignal[];
      let changed: ReadonlySet<string> | undefined;
      if (answer.notModified) {
        // Nothing moved, and the engine did not even fold the list to say so.
        // The one reason left to do anything is a Live Activity that would
        // otherwise go stale, refreshed from the list we already hold.
        sessions = workerGlobal.telarMobilePushSnapshot ?? [];
        workerGlobal.telarMobilePushHeartbeat = heartbeatWanted(records, sessions);
        if (!heartbeatDue(records, sessions, workerGlobal.telarMobilePushBeatAt, nowMs)) return;
        // An empty change set: the activity refresh runs, no alert can fire.
        changed = new Set<string>();
      } else {
        sessions = signals(answer.sessions);
        if (answer.etag !== undefined) workerGlobal.telarMobilePushETag = answer.etag;
        changed = reconcile ? undefined : changedSessions(sessions, workerGlobal.telarMobilePushSnapshot);
        workerGlobal.telarMobilePushSnapshot = sessions;
        await markApprovable(sessions, changed, id => api.session(id, { turns: 1 }));
        if (desktop) notifyDesktop(sessions, changed);
        workerGlobal.telarMobilePushHeartbeat = heartbeatWanted(records, sessions);
        if (changed && changed.size === 0 && !heartbeatDue(records, sessions, workerGlobal.telarMobilePushBeatAt, nowMs)) return;
      }
      workerGlobal.telarMobilePushBeatAt = nowMs;

      // A phone on v1 needs this Mac's own relay or APNs key; one on v2 needs nothing here.
      const v1Ready = pushConfigured();
      for (const record of records) {
        if (pushPausedUntil(Date.now()) !== undefined) break;
        if (!record.relay && !v1Ready) continue;
        // A RECORD THAT WAS HELD BACK GETS THE WHOLE LIST. The change set is
        // global and names what moved since the LAST PASS; a record in backoff
        // sat out several of those, so narrowing it would hide every transition
        // it missed until the next reconcile — including a session still
        // waiting on the person. Narrowing only ever saved comparisons, never a
        // relay call: an unchanged session produces no notification either way.
        const narrow = record.failures ? undefined : changed;
        const result = await deliverRecord(record, sessions, async delivery => {
          // Recheck at delivery time: revocation and preference changes can race a slow APNs connection.
          if (!readRemote().devices.some(d => d.id === record.deviceId && d.role === "full")) return { status: 410 };
          if (!readPushRecords().some(r => r.revision === record.revision)) return { status: 409, relay: true };
          const sent = record.relay ? await relayV2Delivery(record.relay, delivery) : relay ? await relayDelivery(relay, record, delivery) : await sendAPNs(delivery);
          if (sent.retryAfter !== undefined) pauseHost(sent.retryAfter);
          return sent;
        }, Date.now() / 1000, narrow === undefined ? {} : { changed: narrow });
        // A phone may change preferences while APNs is in flight. Never overwrite it.
        const current = readPushRecords();
        const index = current.findIndex(r => r.revision === record.revision);
        if (index >= 0) {
          if (result) current[index] = result; else current.splice(index, 1);
          writePushRecords(current);
        } else if (result?.automaticStartedAt) {
          // A push-start wakes the app, whose registration may arrive before
          // APNs returns. Retain only the start receipt across that refresh;
          // never overwrite newer preferences, subscriptions or alert state.
          const refreshed = current.find(r => r.deviceId === record.deviceId && r.topic === record.topic
            && r.liveActivities && r.pushToStartToken === record.pushToStartToken);
          if (refreshed && !refreshed.automaticStartedAt) {
            refreshed.automaticStartedAt = result.automaticStartedAt;
            // Carry the attempt count with the receipt, or a phone re-registering on every
            // start push would reset the cap and be pushed forever.
            refreshed.automaticStarts = result.automaticStarts;
            writePushRecords(current);
          }
        }
      }
    } catch {
      // Keep checkpoints for retry, without logging credentials or session content.
      console.warn("[mobile-push] Delivery unavailable; retrying.");
    } finally {
      // THE CADENCE FOLLOWS THE FEED (#586): the reconcile when frames are
      // arriving, the old ten seconds when they are not.
      workerGlobal.telarMobilePushTimer = setTimeout(tick, pollDelay(workerGlobal.telarMobilePushFeedOpen === true, workerGlobal.telarMobilePushHeartbeat === true));
      workerGlobal.telarMobilePushTimer.unref();
    }
  };
  workerGlobal.telarMobilePushTimer = setTimeout(tick, 0);
  workerGlobal.telarMobilePushTimer.unref();
  /**
   * A FRAME RESCHEDULES THE PASS RATHER THAN RUNNING ONE (#586). Several
   * events land together constantly — a turn completing writes more than one —
   * and running a wide pass per frame would be worse than the poll this
   * replaces. Clearing the pending timer and setting a short one coalesces a
   * burst into a single pass a moment later.
   */
  openSessionFeed(() => {
    if (workerGlobal.telarMobilePushTimer) clearTimeout(workerGlobal.telarMobilePushTimer);
    workerGlobal.telarMobilePushTimer = setTimeout(tick, FEED_COALESCE_MS);
    workerGlobal.telarMobilePushTimer.unref();
  });
}
