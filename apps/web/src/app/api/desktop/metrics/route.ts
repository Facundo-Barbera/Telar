/** The desktop shell's process metrics, read from its loopback control port; 503 outside the desktop app. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The shell answers from a cached sample, so a slower reply is itself the finding. */
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
      const payload: unknown = await response.json().catch(() => undefined);
      const message =
        payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `The Telar desktop shell answered ${response.status}.`;
      return unavailable(message);
    }
    return Response.json(await response.json(), { headers: { "cache-control": "no-store" } });
  } catch {
    // Never leak the loopback address or the token into a log.
    return unavailable("The Telar desktop shell did not answer.");
  }
}
