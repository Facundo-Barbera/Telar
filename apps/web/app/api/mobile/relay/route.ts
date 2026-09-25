import { forgetRelayConfig, relayConfig } from "@/lib/mobile/relay";
import { activityReport, pushAvailable, pushConfigured, readPushRecords } from "@/lib/mobile/push";
import { pushPausedUntil, startMobilePushWorker } from "@/lib/mobile/worker";
import { readRemote } from "@/lib/remote/store";

/**
 * WHETHER THIS MAC CAN PUSH AT ALL, AND TO WHOM — issue #579.
 *
 * ── THE FAILURE THIS EXISTS TO END ──────────────────────────────────────────
 * Push on this machine was not broken; it was UNPROVISIONED and invisible. The
 * worker refuses to start without a relay (`worker.ts`), `PUT /api/mobile/push`
 * answers `{ configured: false }`, and the only place that fact surfaced was a
 * status line under a toggle on the phone — which nobody had switched on,
 * because nothing ever asked. Nowhere on the Mac said anything at all.
 *
 * ── NO CREDENTIAL LEAVES THIS ROUTE ─────────────────────────────────────────
 * Not the relay token, not a device token, not a push-to-start token. The
 * answer is three booleans and a list of phones described by what a person
 * would recognise: the name they paired it under, whether alerts are on, and
 * when APNs last took something for it. `configured` is the same predicate the
 * worker gates on, so the pane cannot disagree with the thing that sends.
 *
 * `?fresh=1` DROPS THE 30s CACHE, and exists for exactly one caller: the read
 * taken straight after the Keychain item was written. Without it, Settings
 * would tell somebody who has just provisioned the relay that this Mac has
 * none, for half a minute.
 *
 * THAT SAME READ STARTS THE WORKER. Otherwise a Mac provisioned from Settings
 * sent nothing until a phone next registered or the app restarted. Starting is
 * a no-op when the relay is still missing or the worker already runs.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.get("fresh") === "1") {
      forgetRelayConfig();
      startMobilePushWorker();
    }
    const paired = new Map(readRemote().devices.map((device) => [device.id, device]));
    const records = readPushRecords();
    const ownHostId = relayConfig()?.id;
    const pausedUntil = pushPausedUntil();
    return Response.json({
      // WHEN THIS MAC MAY SEND AGAIN (#584). The relay answers 429 with a
      // `Retry-After` once a host is past its daily budget, and the worker
      // honours it; without this the pane would show a row of phones that are
      // registered, reachable and simply not being sent to.
      ...(pausedUntil === undefined ? {} : { pausedUntil }),
      // The worker's own gate. A Mac that answers `false` here sends nothing,
      // whatever else is true.
      configured: pushAvailable(),
      // Whether a relay is what makes it configured, as opposed to a local APNs
      // key in the environment — the two are provisioned in different places
      // and the pane has to point at the right one.
      relay: relayConfig() !== undefined,
      // PLUG AND PLAY: some phone registered itself with relay v2, so this Mac
      // needs nothing provisioned to reach it.
      v2: records.some((record) => record.relay !== undefined),
      // THE AVAILABLE APPLE KEY IS PRODUCTION-ONLY (`relayDelivery`). A debug
      // build registers `sandbox: true` and can never be delivered to through
      // the relay, which is worth saying out loud beside a phone that shows up
      // registered and never rings.
      sandbox: pushConfigured(true),
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
        // Apple's own word for it — never a token, never a payload. A phone
        // that is being rejected looked identical to a quiet one before this.
        lastStatus: record.lastStatus,
        lastReason: record.lastReason,
        consecutiveFailures: record.failures ?? 0,
        parked: record.parked === true,
        // A record another Mac owns is shown as that, not as a broken one: it
        // is being served, just not from here (#584).
        mine: record.relayHostId === ownHostId,
        // HOW it is reached, and what the test alert sent after pairing
        // came back with. A status and Apple's word for it; never the key.
        transport: record.relay ? "v2" : "v1",
        activity: activityReport(record),
        ...(record.relayTest && record.relayTest.keyId === record.relay?.keyId
          ? { test: { at: record.relayTest.at, status: record.relayTest.status, reason: record.relayTest.reason, relay: record.relayTest.relay === true } }
          : {}),
      })),
    });
  } catch {
    // A push-records file that cannot be read is a pane that says nothing, not
    // a Settings screen that fails to load.
    return Response.json({ configured: false, relay: false, v2: false, sandbox: false, devices: [] }, { status: 200 });
  }
}
