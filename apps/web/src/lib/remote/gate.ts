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
 * audited (2026-09): the read-ish POSTs (/api/browse opens a native dialog) are
 * mutations too. Don't add exceptions
 * speculatively. There are no Server Actions in this app, so page requests
 * (always GET) need no method rule.
 */
export const EXEMPT_API_PATHS = new Set(["/api/ping", "/api/pair"]);

export const OBSERVER_METHODS = new Set(["GET", "HEAD"]);

export type GateDenial = { allow: false; code: "cockpit_unauthorized" | "cockpit_forbidden" };

export type GateDecision = { allow: true; deviceId?: string; role?: DeviceRole } | GateDenial;

/**
 * What a caller can prove about itself. `hostHeader` is OPTIONAL because most
 * callers are guests and have none; a caller that omits it is exactly a caller
 * that does not have it.
 */
export type GateCredentials = { authorization: string | null; deviceCookie: string | null; hostHeader?: string | null };

/**
 * Which paired device is making this request — bearer first, then cookie,
 * the same precedence as the gate. For routes that report or scope by the
 * caller ("This device", revoke-all-others).
 */
export function identifyCaller(request: GateCredentials, file: RemoteFile): PairedDevice | undefined {
  const bearer = request.authorization?.match(/^Bearer\s+(tlr_[A-Za-z0-9_-]+)$/)?.[1];
  const candidate = bearer ?? request.deviceCookie;
  return candidate ? matchDevice(file, candidate) : undefined;
}

/**
 * Is this request the process that launched the server? Header first, cookie
 * second — the header is the carrier that survives a network-service restart
 * and a change of loopback spelling (host-token.ts). Both comparisons are
 * `isHostToken`'s constant-time one, and a missing secret matches nothing.
 */
export function isHostCaller(request: GateCredentials): boolean {
  return isHostToken(request.hostHeader) || isHostToken(request.deviceCookie);
}

export function decideApiAccess(
  request: GateCredentials & { pathname: string; method: string },
  file: RemoteFile,
): GateDecision {
  if (!file.requireAuth) return { allow: true };
  if (EXEMPT_API_PATHS.has(request.pathname)) return { allow: true };

  // THE PROCESS THAT LAUNCHED THE SERVER IS NOT A GUEST. It carries a
  // per-launch secret rather than a device record — see host-token.ts for why
  // pairing the host with itself was the wrong shape, and why the secret
  // travels as a header as well as a cookie.
  if (isHostCaller(request)) return { allow: true, role: "full" };

  const device = identifyCaller(request, file);
  if (!device) return { allow: false, code: "cockpit_unauthorized" };
  if (device.role === "observer" && !OBSERVER_METHODS.has(request.method.toUpperCase())) {
    return { allow: false, code: "cockpit_forbidden" };
  }
  return { allow: true, deviceId: device.id, role: device.role };
}
