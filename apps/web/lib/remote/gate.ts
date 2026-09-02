import { isHostToken } from "./host-token";
import { matchDevice, type DeviceRole, type PairedDevice, type RemoteFile } from "./store";

/**
 * The access decision, pure: given the request's credentials and the pairing
 * store, may this call proceed? Extracted from the proxy so the test and the
 * proxy cannot disagree about the rule.
 *
 * EXEMPTIONS are the two routes that must answer an UNPAIRED caller:
 *  - /api/ping   reachability probe (tailscale serve check, iOS pre-pair
 *                test) — returns {ok:true} and nothing else.
 *  - /api/pair   the pairing exchange itself.
 * Everything else — /api/health included, it names the daemon — is gated the
 * moment requireAuth is on.
 *
 * OBSERVERS may GET and HEAD, nothing else — and the allowlist of
 * observer-writable routes is EMPTY, on purpose. Every non-GET route was
 * audited (2026-09): the read-ish POSTs (/api/browse opens a native dialog,
 * /api/spool/look reconciles state) are mutations too. Don't add exceptions
 * speculatively. There are no Server Actions in this app, so page requests
 * (always GET) need no method rule.
 */
export const EXEMPT_API_PATHS = new Set(["/api/ping", "/api/pair"]);

export const OBSERVER_METHODS = new Set(["GET", "HEAD"]);

export type GateDenial = { allow: false; code: "cockpit_unauthorized" | "cockpit_forbidden" };

export type GateDecision = { allow: true; deviceId?: string; role?: DeviceRole } | GateDenial;

/**
 * Which paired device is making this request — bearer first, then cookie,
 * the same precedence as the gate. For routes that report or scope by the
 * caller ("This device", revoke-all-others).
 */
export function identifyCaller(
  request: { authorization: string | null; deviceCookie: string | null },
  file: RemoteFile,
): PairedDevice | undefined {
  const bearer = request.authorization?.match(/^Bearer\s+(tlr_[A-Za-z0-9_-]+)$/)?.[1];
  const candidate = bearer ?? request.deviceCookie;
  return candidate ? matchDevice(file, candidate) : undefined;
}

export function decideApiAccess(
  request: { pathname: string; method: string; authorization: string | null; deviceCookie: string | null },
  file: RemoteFile,
): GateDecision {
  if (!file.requireAuth) return { allow: true };
  if (EXEMPT_API_PATHS.has(request.pathname)) return { allow: true };

  // THE PROCESS THAT LAUNCHED THE SERVER IS NOT A GUEST. It carries a
  // per-launch secret rather than a device record — see host-token.ts for why
  // pairing the host with itself was the wrong shape.
  if (isHostToken(request.deviceCookie)) return { allow: true, role: "full" };

  const device = identifyCaller(request, file);
  if (!device) return { allow: false, code: "cockpit_unauthorized" };
  if (device.role === "observer" && !OBSERVER_METHODS.has(request.method.toUpperCase())) {
    return { allow: false, code: "cockpit_forbidden" };
  }
  return { allow: true, deviceId: device.id, role: device.role };
}
