import { activityReport, pushAvailable, pushConfigured, readPushRecords } from "@/lib/mobile/push";
import { pushPausedUntil } from "@/lib/mobile/worker";
import { readRemote } from "@/lib/remote/store";

/**
 * WHETHER THIS MAC CAN PUSH AT ALL, AND TO WHOM — issue #579.
 *
 * STATUS ONLY. With relay v2 each phone registers itself and hands this Mac
 * the key for their pair, so there is nothing to provision here and this route
 * accepts nothing. It answers what the Settings pane shows: whether the worker
 * has anybody to send to, and for each registered phone how it is reached and
 * how that is going.
 *
 * ── NO CREDENTIAL LEAVES THIS ROUTE ─────────────────────────────────────────
 * Not a relay key, not a device token, not a push-to-start token. The answer
 * is a boolean and a list of phones described by what a person would
 * recognise: the name they paired it under, whether alerts are on, and when
 * something was last delivered to it. `configured` is the same predicate the
 * worker gates on, so the pane cannot disagree with the thing that sends.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  try {
    const paired = new Map(readRemote().devices.map((device) => [device.id, device]));
    const records = readPushRecords();
    const direct = pushConfigured();
    const pausedUntil = pushPausedUntil();
    return Response.json({
      // WHEN THIS MAC MAY SEND AGAIN (#584). The relay answers 429 with a
      // `Retry-After` once a phone's daily budget is spent, and the worker
      // honours it; without this the pane would show a row of phones that are
      // registered, reachable and simply not being sent to.
      ...(pausedUntil === undefined ? {} : { pausedUntil }),
      // The worker's own gate. A Mac that answers `false` here sends nothing,
      // whatever else is true.
      configured: pushAvailable(),
      devices: records.map((record) => ({
        deviceId: record.deviceId,
        name: paired.get(record.deviceId)?.name,
        // A record whose device is no longer paired is swept by the worker on
        // its next tick; until then it is shown as what it is.
        paired: paired.has(record.deviceId),
        topic: record.topic,
        sandbox: record.sandbox,
        enabled: record.enabled,
        liveActivities: record.liveActivities === true,
        updatedAt: record.updatedAt,
        lastDeliveryAt: record.lastDeliveryAt,
        // WHAT HAPPENED LAST, AND HOW BADLY IT IS GOING (#584). A status and
        // Apple's own word for it — never a token, never a payload.
        lastStatus: record.lastStatus,
        lastReason: record.lastReason,
        consecutiveFailures: record.failures ?? 0,
        parked: record.parked === true,
        // HOW it is reached: the key the phone gave this Mac, this Mac's own
        // direct key, or nothing yet — a phone that has not finished
        // registering, which the worker leaves alone (`canReach`).
        transport: record.relay ? "v2" : direct ? "direct" : "none",
        activity: activityReport(record),
        ...(record.relayTest && record.relayTest.keyId === record.relay?.keyId
          ? { test: { at: record.relayTest.at, status: record.relayTest.status, reason: record.relayTest.reason, relay: record.relayTest.relay === true } }
          : {}),
      })),
    });
  } catch {
    // A push-records file that cannot be read is a pane that says nothing, not
    // a Settings screen that fails to load.
    return Response.json({ configured: false, devices: [] }, { status: 200 });
  }
}
