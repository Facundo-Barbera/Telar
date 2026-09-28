import type { TurnObservation } from "@telar/engine-client";
import { createClaudeDriver as createRealClaudeDriver } from "../src/drivers/claude";

// Every Claude driver test runs a fake SDK, so the executable is faked too; the real resolver has its own tests.
export const createClaudeDriver: typeof createRealClaudeDriver = (loadSdk, options = {}) =>
  createRealClaudeDriver(loadSdk, { resolveExecutable: () => "/fake/bin/claude", ...options });

/** Everything a run reports, in order; `batches` keeps the engine-command boundaries. */
export function recorder() {
  const observations: TurnObservation[] = [];
  const batches: TurnObservation[][] = [];
  return {
    observations,
    batches,
    onObservations: async (batch: TurnObservation[]) => {
      batches.push(batch);
      observations.push(...batch);
    },
  };
}

// Unique per call: the driver keys a live runtime by sessionId, so a shared id would share a query.
let runSequence = 0;
export const nextRunId = (): number => (runSequence += 1);
export const run = (driver: ReturnType<typeof createClaudeDriver>, extra: Record<string, unknown> = {}) => {
  const sink = recorder();
  return {
    sink,
    result: driver.run({
      prompt: "prompt",
      sessionId: `session_test_${nextRunId()}`,
      cwd: "/tmp",
      signal: new AbortController().signal,
      onObservations: sink.onObservations,
      ...extra,
    }),
  };
};
