import { isHostToken } from "./host-token";
import { matchDevice, type DeviceRole, type PairedDevice, type RemoteFile } from "./store";

export const EXEMPT_API_PATHS = new Set(["/api/ping", "/api/pair"]);

const OBSERVER_METHODS = new Set(["GET", "HEAD"]);

type GateDenial = { allow: false; code: "cockpit_unauthorized" | "cockpit_forbidden" };

export type GateDecision = { allow: true; deviceId?: string; role?: DeviceRole } | GateDenial;

export type GateCredentials = { authorization: string | null; deviceCookie: string | null; hostHeader?: string | null };

export function identifyCaller(request: GateCredentials, file: RemoteFile): PairedDevice | undefined {
  const bearer = request.authorization?.match(/^Bearer\s+(tlr_[A-Za-z0-9_-]+)$/)?.[1];
  const candidate = bearer ?? request.deviceCookie;
  return candidate ? matchDevice(file, candidate) : undefined;
}

export function isHostCaller(request: GateCredentials): boolean {
  return isHostToken(request.hostHeader) || isHostToken(request.deviceCookie);
}

export function decideApiAccess(
  request: GateCredentials & { pathname: string; method: string },
  file: RemoteFile,
): GateDecision {
  if (!file.requireAuth) return { allow: true };
  if (EXEMPT_API_PATHS.has(request.pathname)) return { allow: true };

  if (isHostCaller(request)) return { allow: true, role: "full" };

  const device = identifyCaller(request, file);
  if (!device) return { allow: false, code: "cockpit_unauthorized" };
  if (device.role === "observer" && !OBSERVER_METHODS.has(request.method.toUpperCase())) {
    return { allow: false, code: "cockpit_forbidden" };
  }
  return { allow: true, deviceId: device.id, role: device.role };
}
