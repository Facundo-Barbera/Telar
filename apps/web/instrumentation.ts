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

  try {
    const { reconcileStuckLooms } = await import("@telar/core/dispatcher");
    // Synchronous; returns the reconciled list. Log its length as the count.
    const recovered = reconcileStuckLooms();
    console.info(`[instrumentation] recovered ${recovered.length} stuck loom(s) on boot`);
  } catch (err) {
    // A reconcile failure must never crash server boot.
    console.error("[instrumentation] reconcileStuckLooms failed on boot", err);
  }
}
