import os from "node:os";
import { remoteErrorResponse } from "@/lib/remote/http";
import { machineName } from "@/lib/remote/observe";
import { parsePairingUrl } from "@/lib/hosts/book";
import { addHost, publicHost, readHosts } from "@/lib/hosts/store";

/**
 * THE OTHER MACS THIS COCKPIT IS PAIRED WITH.
 *
 * `GET` lists them without their tokens. `POST` pairs with one: it takes the
 * pairing link the OTHER cockpit shows in its Settings → Remote access — the
 * same `…/pair#token=…` a phone scans — exchanges the one-time secret at
 * that cockpit's `/api/pair` exactly as the iOS app does, and keeps the device
 * token it gets back. From then on `/api/hosts/:id/…` speaks for this desktop
 * over there, and that cockpit's Devices list shows this Mac as a paired
 * device it can rename, demote or revoke.
 *
 * THE EXCHANGE HAPPENS HERE, SERVER-SIDE, so the browser never sees the
 * remote's token and the remote never sees a cross-origin request.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EXCHANGE_TIMEOUT_MS = 8_000;

export async function GET() {
  try {
    return Response.json({ hosts: readHosts().hosts.map(publicHost) });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}

export async function POST(request: Request) {
  let body: { pairingUrl?: unknown; name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: { code: "invalid_request", message: "Request body must be a JSON object." } }, { status: 400 });
  }
  const parsed = typeof body.pairingUrl === "string" ? parsePairingUrl(body.pairingUrl) : undefined;
  if (!parsed) {
    return Response.json(
      { error: { code: "invalid_request", message: "Paste the pairing link from the other Mac's Settings → Remote access (it ends in #token= and the eight-digit code)." } },
      { status: 400 },
    );
  }

  let deviceToken: string;
  try {
    const answer = await fetch(`${parsed.baseUrl}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: parsed.token,
        deviceName: machineName() ?? os.hostname(),
        kind: "desktop",
        client: "Telar",
        os: "macOS",
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    const payload = (await answer.json().catch(() => null)) as { deviceToken?: unknown; error?: { message?: string } } | null;
    if (!answer.ok || typeof payload?.deviceToken !== "string") {
      return Response.json(
        { error: { code: "cockpit_pairing_refused", message: payload?.error?.message ?? `The other Mac refused the pairing (status ${answer.status}).` } },
        { status: 502 },
      );
    }
    deviceToken = payload.deviceToken;
  } catch {
    return Response.json(
      { error: { code: "engine_unavailable", message: "The other Mac did not answer. Check that it is reachable from here and that Remote access is on." } },
      { status: 503 },
    );
  }

  // Its own name and identity, when it will say — a paired cockpit answers
  // health with the bearer it just minted. Best-effort: the address alone is
  // a working host.
  let name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
  let daemonId: string | undefined;
  try {
    const health = await fetch(`${parsed.baseUrl}/api/health`, {
      headers: { authorization: `Bearer ${deviceToken}` },
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    const payload = (await health.json().catch(() => null)) as { daemonId?: unknown; hostname?: unknown } | null;
    if (typeof payload?.daemonId === "string") daemonId = payload.daemonId;
    if (!name && typeof payload?.hostname === "string" && payload.hostname.trim()) name = payload.hostname.trim();
  } catch {
    // Reachable enough to pair, not to introduce itself. The address names it.
  }

  try {
    const host = addHost({ baseUrl: parsed.baseUrl, deviceToken, ...(name ? { name } : {}), ...(daemonId ? { daemonId } : {}) });
    return Response.json({ host: publicHost(host) });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
