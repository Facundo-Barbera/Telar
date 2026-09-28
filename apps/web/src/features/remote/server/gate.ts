import { engineCall } from "@/platform/engine/server";
import { readDeviceCookie } from "./cookie";
import { HOST_HEADER } from "./host-token";

export type Caller = { host: boolean; device?: { id: string; role: "full" | "observer" } };
export type GateDecision = { allow: true; deviceId?: string; role?: "full" | "observer" } | { allow: false; code: "cockpit_unauthorized" | "cockpit_forbidden" };

const credentialsOf = (request: Request) => ({
  authorization: request.headers.get("authorization"),
  deviceCookie: readDeviceCookie(request),
  hostHeader: request.headers.get(HOST_HEADER),
});

/** Who is calling, as the engine sees it: the host that runs this cockpit, a paired device, or neither. */
export async function identifyCaller(request: Request): Promise<Caller> {
  return (await engineCall("POST", "/v2/auth/identify", credentialsOf(request))).body as Caller;
}

export async function decideAccess(request: Request, pathname: string): Promise<GateDecision> {
  return (await engineCall("POST", "/v2/auth/decide", { ...credentialsOf(request), pathname, method: request.method })).body as GateDecision;
}
