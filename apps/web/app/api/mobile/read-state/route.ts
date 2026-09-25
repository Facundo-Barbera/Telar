import { EngineClientError } from "@telar/engine-client";
import { engineClient } from "@/lib/engine/engine-server";
import { clearedSessions, parseReadStateIds } from "@/lib/mobile/read-sync";
import { readDeviceCookie } from "@/lib/remote/cookie";
import { identifyCaller } from "@/lib/remote/gate";
import { readRemote } from "@/lib/remote/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * WHICH OF THESE ALERTS MAY THE PHONE TAKE DOWN — the launch reconcile.
 *
 * The silent push is best effort: iOS throttles it, a force-quit app never
 * gets it, and a relay v1 phone is never sent one. So on launch the phone asks
 * each Mac ONCE, naming only the sessions it still shows alerts for, and this
 * answers with the ids whose alerts are stale by the engine's own read state.
 * Ids in, ids out: nothing about a session's content leaves here.
 *
 * PAIRED CALLERS ONLY, even while the global gate is off — the same rule as
 * `/api/mobile/push`, the route this one sits beside.
 */
export async function GET(request: Request) {
  const device = identifyCaller({ authorization: request.headers.get("authorization"), deviceCookie: readDeviceCookie(request) }, readRemote());
  if (!device) return Response.json({ error: { message: "Pair this device first." } }, { status: 401 });
  const ids = parseReadStateIds(new URL(request.url).searchParams.get("ids"));
  if (!ids) return Response.json({ error: { message: "Name between 1 and 64 session ids." } }, { status: 400 });
  try {
    const api = await engineClient();
    const cleared = await clearedSessions(ids, async id => {
      try { return (await api.session(id, { turns: 1 })).session; }
      catch (error) { if (error instanceof EngineClientError && error.code === "not_found") return undefined; throw error; }
    });
    return Response.json({ cleared }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: { message: "The engine is unavailable." } }, { status: 503 });
  }
}
