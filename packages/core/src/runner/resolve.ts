// M5 runner resolution — the PURE precedence decision (docs/phase-2-runner-plan
// "Runner resolution — one seam, two backings"). No I/O: `ensureRunner`
// performs the health check and hands the boolean in. Build-agnostic from the
// start so a bundled/static build only changes which branch fires, never a
// rewrite.
//
//   TELAR_RUNNER_URL set         → "connect"    (production points at a
//                                                 supervised daemon; never spawn)
//   healthy runner.json          → "reuse"      (a live dev runner already up)
//   TELAR_RUNNER_BIN set         → "spawn-bin"  (the bundled artifact)
//   else                         → "spawn-dev"  (dev source under bun)
export type RunnerResolution = "connect" | "reuse" | "spawn-bin" | "spawn-dev";

export type ResolveInput = {
  runnerUrl?: string; // TELAR_RUNNER_URL
  runnerBin?: string; // TELAR_RUNNER_BIN
  runnerJson?: { port: number; token: string } | null; // parsed ~/.telar/runner.json
  healthOk: boolean; // did GET /health against runnerJson succeed?
};

export function resolveRunner(input: ResolveInput): RunnerResolution {
  // (1) An explicit URL is connect-only: production runs a supervised runner;
  // the web must NOT spawn one.
  if (input.runnerUrl && input.runnerUrl.trim().length > 0) return "connect";
  // (2) A recorded runner that answered /health is reused as-is.
  if (input.runnerJson && input.healthOk) return "reuse";
  // (3) A bundled artifact path spawns that; (4) else the dev source.
  if (input.runnerBin && input.runnerBin.trim().length > 0) return "spawn-bin";
  return "spawn-dev";
}
