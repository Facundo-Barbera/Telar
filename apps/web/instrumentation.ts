export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.TELAR_COCKPIT === "1") {
    const { initializePushRelay } = await import("./lib/mobile/relay");
    initializePushRelay();
    const { startMobilePushWorker } = await import("./lib/mobile/worker");
    startMobilePushWorker();
  }
}
