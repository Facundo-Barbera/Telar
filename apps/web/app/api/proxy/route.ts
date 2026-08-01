import {
  getProxyKey,
  proxyKeyShapeError,
  proxyModels,
  proxyStatus,
  readProxyConfig,
  setProxyKey,
  writeProxyConfig,
} from "@telar/core";

export const dynamic = "force-dynamic";

// The OPTIONAL CLIProxyAPI gateway. GET reports the instance; POST saves the URL
// / enabled flag and stashes either key in the secret store.
//
// NEITHER ROUTE TOUCHES THE MANAGEMENT API. That is the whole point: management
// auth has a hardcoded lockout where a failed attempt — and every attempt made
// while locked out, correct key or not — extends the ban. Bundling a pool read
// into status meant every settings-page load spent an attempt. The pool now
// lives at /api/proxy/pool and is fetched only when a human clicks for it.
//
// NEITHER KEY EVER TRAVELS BACK. Status carries `hasApiKey` / `hasManagementKey`
// booleans, so the page can render "set" without the value existing in the
// client bundle, a screenshot, or a devtools payload.

export async function GET() {
  return Response.json({ proxy: await proxyStatus() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { enabled, url, apiKey, managementKey } = body as {
    enabled?: unknown;
    url?: unknown;
    apiKey?: unknown;
    managementKey?: unknown;
  };

  if (typeof url === "string" && url.trim()) {
    // Reject anything that isn't an http(s) origin before it reaches a fetch:
    // a malformed URL would otherwise surface as an opaque "unreachable".
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    } catch {
      return Response.json(
        { error: "Enter a full http:// or https:// URL, e.g. http://127.0.0.1:8317" },
        { status: 400 },
      );
    }
  }

  // SHAPE FIRST, for both keys — free, and it catches the mistakes this form
  // actually produced: the gateway's error text pasted in, the config's bcrypt
  // hash instead of the plaintext, one key in the other's field.
  if (typeof apiKey === "string") {
    const bad = proxyKeyShapeError("api", apiKey, getProxyKey("management"));
    if (bad) return Response.json({ error: bad }, { status: 400 });
  }
  if (typeof managementKey === "string") {
    const bad = proxyKeyShapeError("management", managementKey, getProxyKey("api"));
    if (bad) return Response.json({ error: bad }, { status: 400 });
  }

  const patch: { enabled?: boolean; url?: string } = {};
  if (typeof enabled === "boolean") patch.enabled = enabled;
  if (typeof url === "string" && url.trim()) patch.url = url.trim();
  if (Object.keys(patch).length) writeProxyConfig(patch);

  const cfg = readProxyConfig();

  // The API key is VERIFIED LIVE before being stored, because /v1/models has no
  // lockout — a wrong key there costs nothing but a 401. Storing an unverified
  // one is how the catalog silently went to zero models.
  if (typeof apiKey === "string" && apiKey.trim()) {
    const models = await proxyModels(cfg.url, apiKey.trim());
    if (models.length === 0) {
      return Response.json(
        {
          error:
            "The gateway rejected that API key (no models returned). It should match an entry under `api-keys:` in the proxy's config — not the management key.",
        },
        { status: 400 },
      );
    }
  }

  // The MANAGEMENT key is deliberately NOT verified here. One wrong save would
  // spend a lockout attempt, and a user correcting a typo would spend several.
  // It is stored on shape alone; the pool route is where a human explicitly
  // chooses to spend the one attempt that tests it.
  if (typeof apiKey === "string") setProxyKey("api", apiKey);
  if (typeof managementKey === "string") setProxyKey("management", managementKey);

  return Response.json({ config: readProxyConfig(), proxy: await proxyStatus() });
}
