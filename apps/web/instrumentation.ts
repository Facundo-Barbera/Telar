// Next.js `register()` runs exactly once per server instance, before the server
// accepts requests (stable since Next 15; this app is Next 16, so no
// experimental `instrumentationHook` flag is needed). We use it to auto-recover
// looms left "stuck" by a previous process crash/restart.
//
// The @telar/core barrel pulls in Node-only modules (fs, child_process, the
// agent SDK), so the import is BOTH dynamic and guarded to the Node.js runtime —
// it must never be pulled into an edge/client bundle.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { reconcileStuckLooms } = await import("@telar/core");
    // Synchronous; returns the reconciled list. Log its length as the count.
    const recovered = reconcileStuckLooms();
    console.info(`[instrumentation] recovered ${recovered.length} stuck loom(s) on boot`);
  } catch (err) {
    // A reconcile failure must never crash server boot.
    console.error("[instrumentation] reconcileStuckLooms failed on boot", err);
  }
}
