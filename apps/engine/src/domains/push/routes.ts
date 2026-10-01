import { EngineClientError, type EngineClient, type PushRelayStatus } from "@telar/engine-client";
import { fail, ok, type Route } from "../../platform/http/route";
import { desktopInUse, desktopStream, handleDesktopMessage, noteConnectedMac } from "./desktop";
import { isNotificationSounds, isNotifyOn, readNotifyOn, readSounds, writeNotifyOn, writeSounds } from "./prefs";
import { activityReport, parseRegistration, pushAvailable, pushConfigured, PushInputError, readPushRecords, saveRegistration } from "./push";
import { clearedSessions, parseReadStateIds } from "./read-sync";
import { pushPausedUntil, sendRelayTest, startMobilePushWorker } from "./worker";

export type PushRouteDeps = {
  client: () => EngineClient;
  pairedDevices: () => { id: string; name: string; role: string }[];
};

function activityFor(deviceId: string, topic?: string) {
  const record = readPushRecords().find((r) => r.deviceId === deviceId && (topic === undefined || r.topic === topic));
  return record ? { activity: activityReport(record) } : {};
}

function relayStatus(pairedDevices: PushRouteDeps["pairedDevices"]): PushRelayStatus {
  const paired = new Map(pairedDevices().map((device) => [device.id, device]));
  const direct = pushConfigured();
  const pausedUntil = pushPausedUntil();
  return {
    ...(pausedUntil === undefined ? {} : { pausedUntil }),
    configured: pushAvailable(),
    devices: readPushRecords().map((record) => ({
      deviceId: record.deviceId,
      name: paired.get(record.deviceId)?.name,
      paired: paired.has(record.deviceId),
      topic: record.topic,
      sandbox: record.sandbox,
      enabled: record.enabled,
      liveActivities: record.liveActivities === true,
      updatedAt: record.updatedAt,
      lastDeliveryAt: record.lastDeliveryAt,
      lastStatus: record.lastStatus,
      lastReason: record.lastReason,
      consecutiveFailures: record.failures ?? 0,
      parked: record.parked === true,
      transport: record.relay ? "v2" : direct ? "direct" : "none",
      activity: activityReport(record),
      ...(record.relayTest && record.relayTest.keyId === record.relay?.keyId
        ? { test: { at: record.relayTest.at, status: record.relayTest.status, reason: record.relayTest.reason, relay: record.relayTest.relay === true } }
        : {}),
    })),
  };
}

export function pushRoutes(deps: PushRouteDeps): Route[] {
  const start = () => startMobilePushWorker({ client: deps.client, fullDevices: () => deps.pairedDevices().filter((d) => d.role === "full").map((d) => d.id) });
  return [
    {
      method: "GET",
      path: /^\/v2\/push\/devices\/([^/]+)$/,
      auth: "engine",
      handle: ({ params: [deviceId] }) => ok({ configured: pushConfigured(), ...activityFor(deviceId!) }),
    },
    {
      method: "PUT",
      path: /^\/v2\/push\/devices\/([^/]+)$/,
      auth: "engine",
      handle({ body, params: [deviceId] }) {
        let registration;
        try {
          registration = parseRegistration(body);
        } catch (error) {
          if (error instanceof PushInputError) return fail(400, "invalid_request", "Invalid push registration.");
          throw error;
        }
        saveRegistration(deviceId!, registration);
        start();
        if (registration.relay) void sendRelayTest(deviceId!, registration.topic);
        return ok({ configured: registration.relay !== undefined || pushConfigured(), ...activityFor(deviceId!, registration.topic) });
      },
    },
    {
      method: "GET",
      path: "/v2/push/relay",
      auth: "engine",
      handle() {
        try {
          return ok(relayStatus(deps.pairedDevices));
        } catch {
          return ok({ configured: false, devices: [] });
        }
      },
    },
    {
      method: "GET",
      path: "/v2/push/read-state",
      auth: "engine",
      async handle({ query }) {
        const ids = parseReadStateIds(query.get("ids"));
        if (!ids) return fail(400, "invalid_request", "Name between 1 and 64 session ids.");
        const cleared = await clearedSessions(ids, async (id) => {
          try {
            return (await deps.client().session(id, { turns: 1 })).session;
          } catch (error) {
            if (error instanceof EngineClientError && error.code === "not_found") return undefined;
            throw error;
          }
        });
        return ok({ cleared });
      },
    },
    {
      method: "GET",
      path: "/v2/push/notify-on",
      auth: "engine",
      handle: () => ok({ notifyOn: readNotifyOn() }),
    },
    {
      method: "PUT",
      path: "/v2/push/notify-on",
      auth: "engine",
      handle({ body }) {
        if (!isNotifyOn(body.notifyOn)) return fail(400, "invalid_request", "notifyOn must be mac, iphone or both.");
        writeNotifyOn(body.notifyOn);
        return ok({ notifyOn: body.notifyOn });
      },
    },
    {
      method: "GET",
      path: "/v2/push/sounds",
      auth: "engine",
      handle: () => ok({ sounds: readSounds() }),
    },
    {
      method: "PUT",
      path: "/v2/push/sounds",
      auth: "engine",
      handle({ body }) {
        if (!isNotificationSounds(body.sounds)) return fail(400, "invalid_request", "sounds must be hilo, armonico, felt or off.");
        writeSounds(body.sounds);
        return ok({ sounds: body.sounds });
      },
    },
    {
      method: "PUT",
      path: /^\/v2\/push\/desktop\/presence\/([^/]+)$/,
      auth: "engine",
      handle({ body, params: [deviceId] }) {
        if (typeof body.active !== "boolean") return fail(400, "invalid_request", "active must be true or false.");
        noteConnectedMac(deviceId!, body.active);
        return ok({ hostInUse: desktopInUse() });
      },
    },
    {
      method: "POST",
      path: "/v2/push/desktop/messages",
      auth: "engine",
      async handle({ body }) {
        await handleDesktopMessage(body, (sessionId, requestId, input) => deps.client().resolveRequest(sessionId, requestId, input));
        return ok({ ok: true });
      },
    },
  ];
}

const BEAT_MS = 25_000;

export function serveDesktopStream(
  response: { writeHead(status: number, headers: Record<string, string>): unknown; write(chunk: string): unknown },
  deps: PushRouteDeps,
): () => void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  response.write(": open\n\n");
  const unsubscribe = desktopStream.subscribe(response);
  const beat = setInterval(() => response.write(": beat\n\n"), BEAT_MS);
  beat.unref();
  startMobilePushWorker({ client: deps.client, fullDevices: () => deps.pairedDevices().filter((d) => d.role === "full").map((d) => d.id) });
  return () => {
    clearInterval(beat);
    unsubscribe();
  };
}
