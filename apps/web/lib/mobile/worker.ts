import { relayConfig, relayDelivery, revokeRelayDevice } from "./relay";
import { engineClient } from "../engine/engine-server";
import { readRemote } from "../remote/store";
import { activityDelivery, notification, pushConfigured, readPushRecords, sendAPNs, signalKey, writePushRecords, type Delivery, type PushRecord, type SessionSignal } from "./push";

/** Fold after successful delivery only. First sight baselines history, not a burst of old alerts. */
export async function deliverRecord(record: PushRecord, sessions: SessionSignal[], send: (delivery: Delivery) => Promise<number>, now = Date.now() / 1000): Promise<PushRecord | undefined> {
  if ((record.retryAt ?? 0) > now) return record;
  let failed = false;
  const safeSend = async (delivery: Delivery) => {
    let status: number;
    try { status = await send(delivery); } catch { status = 0; }
    if (status !== 200 && status !== 410) failed = true;
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
  for (const follow of record.activities) {
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
        const { sessions } = await (await engineClient()).liveSessions();
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
