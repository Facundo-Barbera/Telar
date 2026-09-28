/**
 * WHAT THE DESKTOP SHELL'S PROCESSES ARE DOING — issue #488.
 *
 * NOT THE ENGINE, AND NOT THIS PROCESS EITHER, which is the whole reason this
 * route is a proxy rather than a reading. `app.getAppMetrics()` exists only in
 * Electron's main process; the cockpit is served by a Node child that main.js
 * forks (`startServer` in apps/desktop/main.js), so it is a SIBLING of the
 * process it is reporting on and has no more access to those figures than any
 * other program on the machine.
 *
 * What it does have is the shell's loopback control port and token, exported
 * into its environment at fork time (`childEnv`) and until now read only by the
 * engine. The shell answers `GET /metrics` on it.
 *
 * WHY THIS EXISTS AT ALL, GIVEN THE PRELOAD BRIDGE. A window inside the shell
 * could ask over IPC and does. Every other way of reaching this cockpit — the
 * phone, a second browser over the remote host, the tab somebody left open on
 * another Mac — has no preload and no bridge, and "which of your Macs is
 * pinned at 300%" is a question worth being able to ask from the sofa. The
 * pairing gate in `proxy.ts` covers this route like every other /api path.
 *
 * ORDINARY WEB MODE ANSWERS 503, not an empty app: a cockpit with no desktop
 * shell around it has no processes to report, and zeroes would read as an idle
 * one.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** How long to wait on loopback before giving up. The shell answers from a
 *  cached sample; a main process too busy to reply within this is itself the
 *  finding, and a page polling every two seconds must not stack requests. */
const TIMEOUT_MS = 2_000;

function unavailable(message: string): Response {
  return Response.json({ error: message }, { status: 503, headers: { "cache-control": "no-store" } });
}

export async function GET() {
  const port = Number.parseInt(process.env.TELAR_DESKTOP_BROWSER_CONTROL_PORT?.trim() ?? "", 10);
  const token = process.env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN?.trim();
  if (!Number.isFinite(port) || port <= 0 || !token) {
    return unavailable("This cockpit is not running inside the Telar desktop app, so it has no processes to report.");
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // The shell's own sentence where it wrote one. NEVER the status line
      // alone — "503" tells a reader nothing they can act on.
      const payload: unknown = await response.json().catch(() => undefined);
      const message =
        payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `The Telar desktop shell answered ${response.status}.`;
      return unavailable(message);
    }
    return Response.json(await response.json(), { headers: { "cache-control": "no-store" } });
  } catch {
    // The shell quit, or is too busy to answer. Either is "no reading", and
    // neither is worth leaking the loopback address or the token into a log.
    return unavailable("The Telar desktop shell did not answer.");
  }
}
