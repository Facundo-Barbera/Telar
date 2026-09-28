import { describeDevice } from "@/lib/remote/identity";
import { observeIdentity } from "@/lib/remote/observe";
import { deviceCookieHeader } from "@/lib/remote/cookie";
import { dialableAddresses } from "@/lib/remote/endpoints";
import { engineErrorResponse } from "@/lib/engine/engine-server";
import { engineCall } from "@/lib/engine/forward";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PairBody = { token?: unknown; deviceName?: unknown; platform?: unknown; kind?: unknown; client?: unknown; machine?: unknown; os?: unknown };

export async function POST(request: Request) {
  let body: PairBody;
  try {
    const text = await request.text();
    if (text.length > 1024) throw new Error("too large");
    body = JSON.parse(text) as PairBody;
  } catch {
    return Response.json({ error: { code: "invalid_request", message: "Request body must be a small JSON object." } }, { status: 400 });
  }
  const platform = body.platform === "ios" || body.platform === "browser" ? body.platform : undefined;
  const identity = observeIdentity(request, {
    kind: body.kind ?? (platform === "ios" ? "phone" : undefined),
    client: body.client,
    machine: body.machine,
    os: body.os,
  });
  try {
    const answer = await engineCall("POST", "/v2/remote/pair", {
      code: typeof body.token === "string" ? body.token : "",
      name: describeDevice(identity, typeof body.deviceName === "string" ? body.deviceName : undefined),
      identity,
      ...(platform ? { platform } : {}),
    });
    if (answer.status !== 200) return Response.json(answer.body, { status: answer.status, headers: { "cache-control": "no-store" } });
    const paired = answer.body as { deviceToken: string; deviceId: string; deviceName: string };
    return Response.json(
      { ...paired, addresses: dialableAddresses() },
      { headers: { "set-cookie": deviceCookieHeader(paired.deviceToken, request), "cache-control": "no-store" } },
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
