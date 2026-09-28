import os from "node:os";
import { fail, ok, type Route } from "../../platform/http/route";
import { parsePairingUrl } from "./book";
import { publicHost, type HostsStore } from "./store";

const EXCHANGE_TIMEOUT_MS = 8_000;

type Exchange = { deviceToken: string; name?: string; daemonId?: string };

async function exchange(baseUrl: string, code: string, deviceName: string, fetcher: typeof fetch): Promise<Exchange | { refused: string } | undefined> {
  let deviceToken: string;
  try {
    const answer = await fetcher(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: code, deviceName, kind: "desktop", client: "Telar", os: "macOS" }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    const payload = (await answer.json().catch(() => null)) as { deviceToken?: unknown; error?: { message?: string } } | null;
    if (!answer.ok || typeof payload?.deviceToken !== "string") {
      return { refused: payload?.error?.message ?? `The other Mac refused the pairing (status ${answer.status}).` };
    }
    deviceToken = payload.deviceToken;
  } catch {
    return undefined;
  }
  try {
    const health = await fetcher(`${baseUrl}/api/health`, {
      headers: { authorization: `Bearer ${deviceToken}` },
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    const payload = (await health.json().catch(() => null)) as { daemonId?: unknown; hostname?: unknown } | null;
    return {
      deviceToken,
      ...(typeof payload?.daemonId === "string" ? { daemonId: payload.daemonId } : {}),
      ...(typeof payload?.hostname === "string" && payload.hostname.trim() ? { name: payload.hostname.trim() } : {}),
    };
  } catch {
    return { deviceToken };
  }
}

export function hostsRoutes(store: HostsStore, fetcher: typeof fetch = fetch): Route[] {
  const notFound = () => fail(404, "not_found", "No such host.");
  return [
    {
      method: "GET",
      path: "/v2/hosts",
      auth: "engine",
      handle: () => ok({ hosts: store.read().hosts.map(publicHost) }),
    },
    {
      method: "POST",
      path: "/v2/hosts",
      auth: "engine",
      async handle({ body }) {
        const parsed = typeof body.pairingUrl === "string" ? parsePairingUrl(body.pairingUrl) : undefined;
        if (!parsed) {
          return fail(400, "invalid_request", "Paste the pairing link from the other Mac's Settings → Remote access (it ends in #token= and the eight-digit code).");
        }
        const deviceName = typeof body.deviceName === "string" && body.deviceName.trim() ? body.deviceName.trim() : os.hostname();
        const paired = await exchange(parsed.baseUrl, parsed.token, deviceName, fetcher);
        if (!paired) return fail(503, "engine_unavailable", "The other Mac did not answer. Check that it is reachable from here and that Remote access is on.");
        if ("refused" in paired) return fail(502, "cockpit_pairing_refused", paired.refused);
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : paired.name;
        const host = store.add({ baseUrl: parsed.baseUrl, deviceToken: paired.deviceToken, ...(name ? { name } : {}), ...(paired.daemonId ? { daemonId: paired.daemonId } : {}) });
        return ok({ host: publicHost(host) });
      },
    },
    {
      method: "PATCH",
      path: /^\/v2\/hosts\/([^/]+)$/,
      auth: "engine",
      handle({ body, params: [id] }) {
        if (typeof body.name !== "string") return fail(400, "invalid_request", "Provide a name.");
        const host = store.rename(id!, body.name);
        return host ? ok({ host: publicHost(host) }) : notFound();
      },
    },
    {
      method: "DELETE",
      path: /^\/v2\/hosts\/([^/]+)$/,
      auth: "engine",
      handle: ({ params: [id] }) => (store.remove(id!) ? ok({ ok: true }) : notFound()),
    },
  ];
}
