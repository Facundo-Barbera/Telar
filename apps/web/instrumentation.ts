// Next.js `register()` runs exactly once per server instance, before the server
// accepts requests (stable since Next 15; this app is Next 16, so no
// experimental `instrumentationHook` flag is needed). We use it to auto-recover
// looms left "stuck" by a previous process crash/restart.
//
// Keep the import on the dispatcher subpath. Importing the package barrel here
// makes every server boot compile unrelated provider detection, usage, and SDK
// modules before the first request can be served.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // The supported vNext launcher uses this same Next application solely as an
  // engine client.  Never let legacy boot recovery claim or execute a legacy
  // queue in that process, even if a user happened to leave legacy state in
  // the selected dogfood home.
  if (process.env.TELAR_VNEXT === "1") return;

  try {
    const { reconcileStuckLooms } = await import("@telar/core/dispatcher");
    // Synchronous; returns the reconciled list. Log its length as the count.
    const recovered = reconcileStuckLooms();
    console.info(`[instrumentation] recovered ${recovered.length} stuck loom(s) on boot`);
  } catch (err) {
    // A reconcile failure must never crash server boot.
    console.error("[instrumentation] reconcileStuckLooms failed on boot", err);
  }

  try {
    const { listSessionQueueIds } = await import("@telar/core/session-queue");
    const { kickSessionQueue } = await import("./lib/server/session-engine");
    const sessionIds = listSessionQueueIds();
    for (const sessionId of sessionIds) void kickSessionQueue(sessionId);
    console.info(`[instrumentation] recovered ${sessionIds.length} session queue(s) on boot`);
  } catch (err) {
    // Queued intent remains on disk if boot recovery cannot start. A later API
    // read/kick retries; server availability must not depend on one bad queue.
    console.error("[instrumentation] session queue recovery failed on boot", err);
  }
}
