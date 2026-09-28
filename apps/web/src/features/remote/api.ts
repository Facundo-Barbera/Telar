import type { DeviceIdentity, DeviceRole, ExposureMode, RemoteState } from "@telar/engine-client";
import { request } from "@/platform/engine/transport";
import type { QrMatrix } from "./qr";
import type { TailscaleServeError } from "./tailscale-serve";

/** The engine's answer plus what only this cockpit knows: its own host row, the caller, and where it listens. */
export type RemoteStatus = RemoteState & {
  tailscaleServeError?: TailscaleServeError;
  host?: { name: string; identity?: DeviceIdentity; isCaller?: boolean };
  callerDeviceId?: string;
  callerRole?: DeviceRole;
  endpoints: Array<{ kind: string; label: string; url: string; qrSafe: boolean }>;
};

export type MintedPairing = { code: string; expiresAt: number; qrByUrl: Record<string, QrMatrix> };

const device = (deviceId: string) => `/api/remote/devices/${encodeURIComponent(deviceId)}`;

export const remoteStatus = () => request<RemoteStatus>(fetch, "GET", "/api/remote");

export const setRemote = (patch: { requireAuth: boolean } | { exposure: ExposureMode } | { tailscaleServe: boolean }) =>
  request<Record<string, unknown>>(fetch, "PATCH", "/api/remote", patch);

export const mintPairing = () => request<MintedPairing>(fetch, "POST", "/api/remote/pairing");

export const updateDevice = (deviceId: string, patch: { name?: string; role?: DeviceRole }) => request<unknown>(fetch, "PATCH", device(deviceId), patch);

export const revokeDevice = (deviceId: string) => request<unknown>(fetch, "DELETE", device(deviceId));

export const revokeOtherDevices = () => request<unknown>(fetch, "DELETE", "/api/remote/devices");
