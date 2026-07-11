import { type RunState } from "./lib/runState";

// Terminal/settled loom states: "ready" is success; the rest are failures the
// orchestrator resolves on so it can tear down.
const TERMINAL = new Set(["ready", "failed", "halted", "needs-review"]);

export async function watchUntilReady(
  state: RunState,
  loomId: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
  process.env.TELAR_HOME = state.telarHome;
  const { getLoom } = await import("@telar/core");

  const intervalMs = opts?.intervalMs ?? 5000;
  const timeoutMs = opts?.timeoutMs ?? Number(process.env.TELAR_E2E_TIMEOUT_MS ?? 1_800_000);
  const deadline = Date.now() + timeoutMs;

  let lastState: string | null = null;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    const loom = getLoom(loomId);
    if (loom) {
      if (loom.state !== lastState) {
        console.log(`[${new Date().toISOString()}] loom ${loomId}: ${loom.state}`);
        lastState = loom.state;
      }
      if (loom.error && loom.error !== lastError) {
        console.log(`  error: ${loom.error}`);
        lastError = loom.error;
      }
      if (TERMINAL.has(loom.state)) return loom.state;
    }
    await sleep(intervalMs);
  }
  throw new Error(`watch timed out after ${timeoutMs}ms (last state: ${lastState})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
