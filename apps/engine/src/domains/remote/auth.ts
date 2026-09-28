import crypto from "node:crypto";
import { fail, ok, type Route } from "../../platform/http/route";
import { matchDevice, type DeviceRole, type PairedDevice, type RemoteFile, type RemoteStore } from "./store";

export const EXEMPT_PATHS = new Set(["/api/ping", "/api/pair"]);
const OBSERVER_METHODS = new Set(["GET", "HEAD"]);

export type Credentials = { authorization?: string | null; deviceCookie?: string | null; hostHeader?: string | null };
export type AccessDecision =
  | { allow: true; deviceId?: string; role?: DeviceRole }
  | { allow: false; code: "cockpit_unauthorized" | "cockpit_forbidden" };

function isHostSecret(candidate: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || typeof candidate !== "string" || candidate.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(secret, "utf8"));
}

function identifyDevice(file: RemoteFile, credentials: Credentials): PairedDevice | undefined {
  const bearer = credentials.authorization?.match(/^Bearer\s+(tlr_[A-Za-z0-9_-]+)$/)?.[1];
  const candidate = bearer ?? credentials.deviceCookie;
  return candidate ? matchDevice(file, candidate) : undefined;
}

const isHostCaller = (credentials: Credentials, secret: string | undefined): boolean =>
  isHostSecret(credentials.hostHeader, secret) || isHostSecret(credentials.deviceCookie, secret);

export function decideAccess(file: RemoteFile, request: Credentials & { pathname: string; method: string }, hostSecret: string | undefined): AccessDecision {
  if (!file.requireAuth || EXEMPT_PATHS.has(request.pathname)) return { allow: true };
  if (isHostCaller(request, hostSecret)) return { allow: true, role: "full" };
  const device = identifyDevice(file, request);
  if (!device) return { allow: false, code: "cockpit_unauthorized" };
  if (device.role === "observer" && !OBSERVER_METHODS.has(request.method.toUpperCase())) return { allow: false, code: "cockpit_forbidden" };
  return { allow: true, deviceId: device.id, role: device.role };
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const credentialsOf = (body: Record<string, unknown>): Credentials => ({
  authorization: text(body.authorization),
  deviceCookie: text(body.deviceCookie),
  hostHeader: text(body.hostHeader),
});

export function authRoutes(store: RemoteStore, hostSecret: () => string | undefined = () => process.env.TELAR_HOST_TOKEN): Route[] {
  return [
    {
      method: "POST",
      path: "/v2/auth/decide",
      auth: "engine",
      handle({ body }) {
        const pathname = text(body.pathname);
        const method = text(body.method);
        if (!pathname || !method) return fail(400, "invalid_request", "pathname and method are required.");
        const decision = decideAccess(store.read(), { ...credentialsOf(body), pathname, method }, hostSecret());
        if (decision.allow && decision.deviceId) store.touchDevice(decision.deviceId);
        return ok(decision);
      },
    },
    {
      method: "POST",
      path: "/v2/auth/identify",
      auth: "engine",
      handle({ body }) {
        const credentials = credentialsOf(body);
        const device = identifyDevice(store.read(), credentials);
        return ok({ host: isHostCaller(credentials, hostSecret()), ...(device ? { device: { id: device.id, role: device.role } } : {}) });
      },
    },
  ];
}
