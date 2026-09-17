import { relayConfig, relayDelivery, revokeRelayDevice } from "./relay";
import { engineClient } from "../engine/engine-server";
import { readRemote } from "../remote/store";
import { AUTOMATIC_ACTIVITY, automaticSessions, automaticActivityDelivery, activityDelivery, notification, pushConfigured, readPushRecords, sendAPNs, signalKey, writePushRecords, type Delivery, type PushRecord, type SessionSignal } from "./push";

/** A phone that actually ran the start reports the activity's token within seconds: iOS delivers it
 *  on `activityUpdates` and the app re-registers straight away. A receipt still standing alone after
 *  300s therefore means the start never landed — Apple accepted it for a token from a previous
 *  install, or Live Activities are off in Settings — so the receipt is dropped and the start retried. */
const AUTOMATIC_START_STALE = 300;
/** But a phone that can never start one must not be pushed every 5 minutes forever: at most 3
 *  accepted starts per push-to-start token. The count resets when the token changes (a reinstall)
 *  and when work goes idle, so recovering never needs a reinstall. */
const AUTOMATIC_START_ATTEMPTS = 3;

/** Fold after successful delivery only. First sight baselines history, not a burst of old alerts. */
export async function deliverRecord(record: PushRecord, sessions: SessionSignal[], send: (delivery: Delivery) => Promise<number>, now = Date.now() / 1000): Promise<PushRecord | undefined> {
  if ((record.retryAt ?? 0) > now) return record;
  let failed = false;
  // WHEN APNS LAST TOOK SOMETHING, for the Settings pane that has to tell a
  // phone which is merely registered from one which is actually being reached
  // (#579). A 410 is the device saying it is gone; that is not a delivery.
  let delivered: number | undefined;
  const safeSend = async (delivery: Delivery) => {
    let status: number;
    try { status = await send(delivery); } catch { status = 0; }
    if (status !== 200 && status !== 410) failed = true;
    if (status === 200) delivered = now;
    return status;
  };
  const next: PushRecord = { ...record, seen: { ...record.seen }, activitySent: { ...record.activitySent }, activities: [...record.activities] };
  for (const session of sessions) {
    const payload = notification(record, session, record.seen[session.id] ?? (record.baselined ? "new:0:0:false" : undefined));
    if (payload) {
      const status = await safeSend(payload);
      if (status === 410) return undefined;
      if (status !== 200) continue;
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
    const status = await safeSend(automaticActivityDelivery(record, sessions, record.pushToStartToken, now, now, true));
    if (status === 200) { next.automaticStartedAt = now; next.automaticStarts = (record.automaticStarts ?? 0) + 1; }
    // Expiration of a start token must never unregister ordinary phone notifications.
    if (status === 410) next.pushToStartToken = undefined;
  }
  for (const follow of automatic) {
    // The activity exists, so the start it came from worked: the attempt count has done its job.
    if (active.length && record.liveActivities) { next.automaticStartedAt = follow.startedAt; next.automaticStarts = undefined; }
    if (aggregateSignal === record.automaticSignal && now - (record.activitySent[follow.token] ?? 0) < 60) continue;
    const status = await safeSend(automaticActivityDelivery(record, sessions, follow.token, follow.startedAt, now));
    if (status === 410 || (status === 200 && (!active.length || !record.liveActivities))) {
      next.activities = next.activities.filter(a => a.token !== follow.token);
      delete next.activitySent[follow.token];
    } else if (status === 200) { next.activitySent[follow.token] = now; next.automaticSignal = aggregateSignal; }
  }
  for (const follow of record.activities.filter(a => a.sessionId !== AUTOMATIC_ACTIVITY)) {
    const session = sessions.find(s => s.id === follow.sessionId);
    const changed = session && record.seen[session.id] !== signalKey(session);
    if (!changed && now - (record.activitySent[follow.token] ?? 0) < 60) continue;
    const status = await safeSend(activityDelivery(record, follow, session, now));
    if (status === 410 || (status === 200 && (!session || session.activity === "idle"))) {
      next.activities = next.activities.filter(a => a.token !== follow.token);
      delete next.activitySent[follow.token];
    } else if (status === 200) next.activitySent[follow.token] = now;
  }
  next.failures = failed ? (record.failures ?? 0) + 1 : 0;
  next.retryAt = failed ? now + Math.min(300, 5 * 2 ** Math.min(next.failures - 1, 6)) : undefined;
  next.lastDeliveryAt = delivered ?? record.lastDeliveryAt;
  next.baselined = true;
  return next;
}

const workerGlobal = globalThis as typeof globalThis & { telarMobilePushTimer?: ReturnType<typeof setTimeout> };
export function startMobilePushWorker(): void {
  if (workerGlobal.telarMobilePushTimer || !pushConfigured() || process.env.TELAR_COCKPIT !== "1") return;
  const tick = async () => {
    try {
      const paired = new Set(readRemote().devices.filter(d => d.role === "full").map(d => d.id));
      const relay = relayConfig();
      const records = readPushRecords();
      if (records.length) {
        // ALL OF THEM (#457). The route's default is the unsettled rows, and a
        // notification that is never sent is the worst failure this path has —
        // so it reads the whole list rather than reasoning about which shelved
        // session might still owe somebody a push.
        const { sessions } = await (await engineClient()).liveSessions({ all: true });
        for (const record of records) {
          if (!paired.has(record.deviceId)) {
            if (relay) await revokeRelayDevice(relay, record.deviceId);
            writePushRecords(readPushRecords().filter(r => r.deviceId !== record.deviceId));
            continue;
          }
          const result = await deliverRecord(record, sessions, async delivery => {
            // Recheck at delivery time: revocation and preference changes can race a slow APNs connection.
            if (!readRemote().devices.some(d => d.id === record.deviceId && d.role === "full")) return 410;
            if (!readPushRecords().some(r => r.revision === record.revision)) return 409;
            return relay ? relayDelivery(relay, record, delivery) : sendAPNs(delivery);
          });
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
      }
    } catch {
      // Keep checkpoints for retry, without logging credentials or session content.
      console.warn("[mobile-push] Delivery unavailable; retrying.");
    } finally { workerGlobal.telarMobilePushTimer = setTimeout(tick, 5000); workerGlobal.telarMobilePushTimer.unref(); }
  };
  workerGlobal.telarMobilePushTimer = setTimeout(tick, 0);
  workerGlobal.telarMobilePushTimer.unref();
}
