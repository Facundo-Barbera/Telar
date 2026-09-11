import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs";
import { decideApiAccess } from "@/lib/remote/gate";
import { HOST_HEADER } from "@/lib/remote/host-token";
import { readRemote, remoteHome, storePath, touchDevice, type RemoteFile } from "@/lib/remote/store";

/**
 * The cockpit's front door. Once pairing is required, every /api call must
 * carry a device token — Authorization: Bearer tlr_… (the iOS app) or the
 * telar_device cookie (a paired browser) — or the host secret, which the
 * desktop shell sends as a header and a cookie both. Until then this is a
 * no-op.
 *
 * The store is re-read whenever remote.json's mtime moves; the module-level
 * cache is ADVISORY (staleness bounded by one write), never the authority —
 * Next documents that proxy modules must not treat shared state as durable.
 */
/**
 * Pages are gated too — the inbox and project pages render engine state
 * server-side, so an unpaired visitor would read project names off the HTML.
 * /pair itself and Next's static machinery stay open.
 */
export const config = {
  matcher: ["/api/:path*", "/((?!pair|_next/static|_next/image|favicon.ico).*)"],
};

let cached: { mtimeMs: number; file: RemoteFile } | null = null;

function loadRemote(): RemoteFile | null {
  let home: string;
  try {
    home = remoteHome();
  } catch {
    // Ordinary web mode (no launcher): the engine adapter already refuses
    // everything with a 503, and a pairing gate on top would only obscure it.
    return null;
  }
  void home;
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(storePath()).mtimeMs;
  } catch {
    // Missing file: mtime stays -1, which is itself a valid cache key.
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached.file;
  const file = readRemote();
  cached = { mtimeMs, file };
  return file;
}

export function proxy(request: NextRequest): Response | undefined {
  const file = loadRemote();
  if (!file) return undefined;

  const decision = decideApiAccess(
    {
      pathname: request.nextUrl.pathname,
      method: request.method,
      authorization: request.headers.get("authorization"),
      deviceCookie: request.cookies.get("telar_device")?.value ?? null,
      // The desktop shell's proof that it is the host, on every request rather
      // than in a jar it can lose — apps/desktop/host-header.js.
      hostHeader: request.headers.get(HOST_HEADER),
    },
    file,
  );
  if (decision.allow) {
    if (decision.deviceId) touchDevice(decision.deviceId);
    return undefined;
  }
  // An unpaired API caller gets the typed 401; an unpaired PERSON gets the
  // pairing page, which explains itself. A FORBIDDEN caller is paired — never
  // bounce it to /pair (only cockpit_unauthorized redirects; pages are GETs,
  // so an observer is never forbidden a page anyway).
  if (decision.code === "cockpit_unauthorized" && !request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.redirect(new URL("/pair", request.url));
  }
  const forbidden = decision.code === "cockpit_forbidden";
  return Response.json(
    {
      error: forbidden
        ? { code: "cockpit_forbidden", message: "This device is paired for viewing only. Give it full access from Remote access on the Mac." }
        : { code: "cockpit_unauthorized", message: "Pair this device with the Telar cockpit to use it." },
    },
    { status: forbidden ? 403 : 401, headers: { "cache-control": "no-store" } },
  );
}
