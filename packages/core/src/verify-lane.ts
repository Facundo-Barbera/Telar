// M10.3 — the SUPERVISED start-lane wrapper.
//
// The proactive stand-up for the top-gate pass (frozenLaneVerify) already
// resolves a ServersConfig, calls startLane, and derives a target URL. M10.3
// makes that stand-up ROBUST without changing frozenLaneVerify's read-only
// contract: it composes the EXISTING lane primitives — startLane (run-server.ts)
// + superviseLane (supervisor.ts) — into ONE Lane the verify path drives exactly
// like a plain lane, so a service that DIES mid-verify is restarted on the SAME
// port (the target URL is port-stable) and the in-flight panel/gates re-poll the
// restored service with no target change.
//
// MOAT: this is the EXECUTOR/SETUP-wall capability (spawn/re-spawn/kill
// processes) — NOT a judge capability. The judge (verifier.ts/critic.ts,
// restrictTools:true) only ever RECEIVES the target URL; it never imports or
// invokes superviseStartLane/startLane/superviseLane. Standing up or repairing
// the lane grants the judge NOTHING. superviseLane's only mutation-shaped action
// is handle.restart() — a re-spawn of the SAME captured spec (run-server.ts:614);
// it can never edit an assertion, downgrade a verdict, or relax a gate
// (invariant #2). Restart triggers ONLY on process death (isAlive()===false),
// never on unhealth, so a live-but-red service is left for the verify to
// legitimately fail. Bounded: RestartPolicy.maxRestarts inside crashLoopWindowMs
// (supervisor.ts) breaks a flapping service to 'crash-looped' + escalate.
import { startLane as defaultStartLane, type Lane, type StartLaneOpts } from "./run-server";
import { superviseLane, type SuperviseOpts } from "./supervisor";
import type { ServersConfig } from "./schemas";

export type SuperviseStartLaneDeps = {
  // Seam: the underlying one-shot bring-up (default startLane). Tests inject a
  // fake that returns a Lane of scripted ServiceHandles.
  startLane?: (config: ServersConfig, root: string, opts?: StartLaneOpts) => Promise<Lane>;
  // Seam: the supervisor's clock/scheduler/health injection (hermetic tests pass
  // a fake clock + scripted checkHealth). Default = real setTimeout / http probe.
  superviseOpts?: SuperviseOpts;
};

/**
 * Bring a lane up (forcing captureLogs so a crash-loop escalation carries a real
 * logTail), attach a supervisor that restart-on-death repairs each service that
 * declares a healthcheck, and return a Lane whose stopAll() first STOPS THE
 * SUPERVISOR (cancels every health-loop timer, leaves processes running) then
 * delegates to the underlying lane.stopAll() (reverse-order, idempotent). The
 * caller's existing teardown finally therefore tears the supervisor down BEFORE
 * the processes — no new teardown site, no leaked timers, no leaked processes.
 *
 * A `driver: none` / empty config yields startLane's no-op empty lane; the
 * supervisor over an empty lane supervises nothing, and stopAll() is a no-op.
 */
export async function superviseStartLane(
  config: ServersConfig,
  root: string,
  opts: StartLaneOpts = {},
  deps: SuperviseStartLaneDeps = {},
): Promise<Lane> {
  const startLaneFn = deps.startLane ?? defaultStartLane;
  // captureLogs forced ON so escalation carries a tail (observability only — no
  // gate/verdict effect). Caller opts win for everything else.
  const lane = await startLaneFn(config, root, { ...opts, captureLogs: true });
  // The lane's processes are now UP. Everything between acquiring the lane and the
  // return must be guarded: superviseLane THROWS (supervisor.ts:328) if a
  // healthchecked handle lacks the isAlive/restart seam, and a bare throw here
  // would LEAK the just-spawned lane. On any failure, tear the lane down
  // best-effort and surface the ORIGINAL error.
  try {
    // superviseLane throws if a supervised handle lacks isAlive/restart; startLane
    // handles always have them (run-server.ts:622). It only supervises services
    // that declare a healthcheck.
    const supervisor = superviseLane(lane, config, deps.superviseOpts ?? {});
    return {
      services: lane.services,
      stopAll: async (): Promise<void> => {
        // Stop supervising FIRST (cancel timers, await in-flight ticks; deliberately
        // leaves the processes running) — then let the lane kill the processes.
        // Swallow a supervisor-stop error so it never masks the lane teardown.
        await supervisor.stop().catch(() => {});
        await lane.stopAll();
      },
    };
  } catch (err) {
    // Supervisor attach (or any post-acquire step) failed AFTER startLane spawned
    // the lane — tear it down so no processes leak. Best-effort: a stopAll failure
    // must NOT mask the original error (the real diagnosis), so swallow it and
    // rethrow the original.
    await lane.stopAll().catch(() => {});
    throw err;
  }
}
