import pkg from "../../../package.json" with { type: "json" };
import {
  mintDeviceToken,
  RemoteStoreError,
  type DeviceIdentity,
  type DevicePlatform,
  type PairedDevice,
  type PairingRefusal,
  type RemoteStore,
} from "./store";
import { fail, ok, type Route } from "../../platform/http/route";
import { authRoutes } from "./auth";

type Body = Record<string, unknown>;

const REFUSAL: Record<PairingRefusal, string> = {
  "none-pending": "No pairing code is waiting. Generate one in Settings → Remote access — a code is single-use, so one that already paired a device is spent.",
  expired: "That pairing code has expired. They last five minutes; generate a fresh one.",
  mismatch: "That is not the pending pairing code. Check the digits — or, if you have more than one Telar running, generate the code from the same one you are pairing against.",
  burned: "Too many wrong tries; that pairing code has been destroyed. Generate a fresh one in Settings → Remote access.",
};

const text = (value: unknown, limit = 64): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit) : undefined;

function identityOf(value: unknown): DeviceIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const identity: DeviceIdentity = { kind: text(raw.kind) ?? "unknown" };
  for (const key of ["client", "machine", "os", "address", "origin"] as const) {
    const field = text(raw[key], 256);
    if (field) identity[key] = field;
  }
  return identity;
}

const publicDevice = ({ id, name, createdAt, lastSeenAt, role, platform, identity }: PairedDevice) => ({
  id,
  name,
  createdAt,
  lastSeenAt,
  role,
  platform,
  identity,
});

export function remoteRoutes(store: RemoteStore): Route[] {
  const routes: Route[] = [
    {
      method: "GET",
      path: "/v2/ping",
      auth: "engine",
      handle: () => ok({ ok: true, proto: 1, appVersion: pkg.version }),
    },
    {
      method: "GET",
      path: "/v2/remote",
      auth: "engine",
      handle() {
        const file = store.read();
        return ok({
          requireAuth: file.requireAuth,
          exposure: file.exposure ?? "local-only",
          tailscaleServe: file.tailscaleServe === true,
          devices: file.devices.map(publicDevice),
          ...(file.pairing ? { pairing: { expiresAt: file.pairing.expiresAt } } : {}),
        });
      },
    },
    {
      method: "PATCH",
      path: "/v2/remote",
      auth: "engine",
      handle({ body }) {
        if (body.tailscaleServe !== undefined) {
          if (typeof body.tailscaleServe !== "boolean") return fail(400, "invalid_request", "tailscaleServe must be a boolean.");
          return ok({ tailscaleServe: store.setTailscaleServe(body.tailscaleServe).tailscaleServe === true, restartRequired: true });
        }
        if (body.exposure !== undefined) {
          if (body.exposure !== "local-only" && body.exposure !== "network-accessible") {
            return fail(400, "invalid_request", "exposure must be local-only or network-accessible.");
          }
          return ok({ exposure: store.setExposure(body.exposure).exposure, restartRequired: true });
        }
        if (typeof body.requireAuth !== "boolean") return fail(400, "invalid_request", "requireAuth must be a boolean.");
        if (!body.requireAuth) {
          store.setRequireAuth(false);
          return ok({ requireAuth: false });
        }
        const caller = (body.device ?? {}) as Body;
        const deviceToken = mintDeviceToken();
        const identity = identityOf(caller.identity);
        const device = store.addDevice(text(caller.name) ?? "Unnamed device", deviceToken, identity ? { identity } : {});
        store.setRequireAuth(true);
        return ok({ requireAuth: true, device: { id: device.id, name: device.name }, deviceToken });
      },
    },
    {
      method: "POST",
      path: "/v2/remote/pairing",
      auth: "engine",
      handle: () => ok(store.mintPairing()),
    },
    {
      method: "DELETE",
      path: "/v2/remote/pairing",
      auth: "engine",
      handle() {
        store.clearPairing();
        return ok({ ok: true });
      },
    },
    {
      method: "POST",
      path: "/v2/remote/pair",
      auth: "engine",
      handle({ body }) {
        const code = typeof body.code === "string" ? body.code : "";
        const outcome = code ? store.consumePairing(code) : "none-pending";
        if (outcome !== true) return { status: 401, body: { error: { code: "cockpit_unauthorized", reason: outcome, message: REFUSAL[outcome] } } };
        const platform: DevicePlatform | undefined = body.platform === "ios" || body.platform === "browser" ? body.platform : undefined;
        const identity = identityOf(body.identity);
        const deviceToken = mintDeviceToken();
        const device = store.addDevice(text(body.name) ?? "Unnamed device", deviceToken, {
          ...(platform ? { platform } : {}),
          ...(identity ? { identity } : {}),
        });
        return ok({ deviceToken, deviceId: device.id, deviceName: device.name });
      },
    },
    {
      method: "DELETE",
      path: "/v2/remote/devices",
      auth: "engine",
      handle({ query }) {
        const keep = query.get("keep");
        if (!keep) return fail(400, "invalid_request", "keep must name the device to keep.");
        return ok({ revoked: store.revokeOtherDevices(keep) });
      },
    },
    {
      method: "PATCH",
      path: /^\/v2\/remote\/devices\/([^/]+)$/,
      auth: "engine",
      handle({ body, params: [id] }) {
        const name = typeof body.name === "string" ? body.name : undefined;
        const role = body.role === "full" || body.role === "observer" ? body.role : undefined;
        if (name === undefined && role === undefined) return fail(400, "invalid_request", "Provide a name and/or a role of full|observer.");
        let device: PairedDevice | undefined;
        if (name !== undefined) device = store.renameDevice(id!, name);
        if (role !== undefined) {
          try {
            device = store.setDeviceRole(id!, role);
          } catch (error) {
            if (error instanceof RemoteStoreError) return fail(409, "cockpit_last_full_device", error.message);
            throw error;
          }
        }
        if (!device) return fail(404, "not_found", "No such device.");
        const { identity: _identity, ...visible } = publicDevice(device);
        return ok({ device: visible });
      },
    },
    {
      method: "DELETE",
      path: /^\/v2\/remote\/devices\/([^/]+)$/,
      auth: "engine",
      handle: ({ params: [id] }) => (store.revokeDevice(id!) ? ok({ ok: true }) : fail(404, "not_found", "No such device.")),
    },
  ];
  return [...routes, ...authRoutes(store)].map((route) => ({ ...route, handle: (input) => refusalsAsBadRequest(() => route.handle(input)) }));
}

function refusalsAsBadRequest(run: () => ReturnType<Route["handle"]>): ReturnType<Route["handle"]> {
  try {
    return run();
  } catch (error) {
    if (error instanceof RemoteStoreError) return fail(400, "invalid_request", error.message);
    throw error;
  }
}
