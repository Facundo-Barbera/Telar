import { matchDevice, type RemoteFile } from "./store";

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
 */
export const EXEMPT_API_PATHS = new Set(["/api/ping", "/api/pair"]);

export type GateDecision = { allow: true; deviceId?: string } | { allow: false };

export function decideApiAccess(
  request: { pathname: string; authorization: string | null; deviceCookie: string | null },
  file: RemoteFile,
): GateDecision {
  if (!file.requireAuth) return { allow: true };
  if (EXEMPT_API_PATHS.has(request.pathname)) return { allow: true };

  const bearer = request.authorization?.match(/^Bearer\s+(tlr_[A-Za-z0-9_-]+)$/)?.[1];
  const candidate = bearer ?? request.deviceCookie;
  if (!candidate) return { allow: false };

  const device = matchDevice(file, candidate);
  return device ? { allow: true, deviceId: device.id } : { allow: false };
}
