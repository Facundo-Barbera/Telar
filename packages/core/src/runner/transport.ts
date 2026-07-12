// M5 dispatch transport — the seam the web talks to instead of calling
// dispatcher.ts directly. TWO impls share one interface:
//   - the IN-PROCESS FAKE (default, flag-off): every verb calls today's
//     dispatcher function directly. This is the byte-identity guarantee
//     expressed as code — flag-off the transport is a no-op indirection.
//   - the HTTP impl (http-transport.ts, flag-on): the same verbs over the
//     runner's loopback control channel.
// D4 all-or-nothing: the whole verb set routes through ONE transport, so there
// is exactly one `active` map (whichever process owns the transport).
import type { Loom } from "../looms";
import type { DispatcherDeps, StartLoomInput } from "../dispatcher";
import type { ServersConfig } from "../schemas";

export type HealthInfo = { pid: number; version: string; ok: boolean };

export type StartFromBundleOpts = { sessionId?: string; maxAttempts?: number };

// The dispatch verbs, mirroring the ~6 web touch-points (D4). Read paths do NOT
// move — events/loom.json are tailed off disk unchanged — so this is dispatch +
// stop + active only.
export interface RunnerTransport {
  health(): Promise<HealthInfo>;
  getActive(): Promise<string[]>;
  start(input: StartLoomInput): Promise<Loom>;
  startFromBundle(loomId: string, by: string, opts?: StartFromBundleOpts): Promise<Loom>;
  approveCharter(id: string, by: string): Promise<boolean>;
  // M7 — Accept/Steer an env proposal (config present = Steer). OPTIONAL: only
  // the runner-flag-on path needs it; flag-off web calls the in-process
  // delegation directly. Not on the M7 critical path.
  approveEnv?(id: string, by: string, config?: ServersConfig): Promise<boolean>;
  steer(id: string, directive: string, by: string): Promise<Loom>;
  reject(id: string, feedback: string, by: string): Promise<Loom>;
  resume(id: string): Promise<Loom>;
  cancel(id: string): Promise<boolean>;
}

// The dispatcher surface the in-process fake drives. Injected (not imported)
// so transport.ts has no runtime dependency on dispatcher.ts — the fake is
// wired with the REAL functions in production and with spies/real fns in tests.
export type DispatcherFacade = {
  startLoom: (input: StartLoomInput, deps: DispatcherDeps) => Loom;
  startLoomFromBundle: (
    loomId: string,
    by: string,
    deps: DispatcherDeps,
    opts?: StartFromBundleOpts,
  ) => Promise<Loom>;
  approveCharter: (id: string, by: string, deps: DispatcherDeps) => Promise<boolean>;
  // M7 — optional so existing facades (and tests) that don't wire it still
  // satisfy the type; makeInProcessTransport guards on its presence.
  approveEnv?: (id: string, by: string, config: ServersConfig | undefined, deps: DispatcherDeps) => Promise<boolean>;
  steerLoom: (id: string, directive: string, by: string, deps: DispatcherDeps) => Promise<Loom>;
  rejectLoom: (id: string, feedback: string, by: string, deps: DispatcherDeps) => Promise<Loom>;
  resumeLoom: (id: string, deps: DispatcherDeps) => Loom;
  cancelLoom: (id: string) => boolean;
  activeLoomIds: () => string[];
};

// The flag-off transport: pure delegation to the injected dispatcher functions,
// carrying `deps` (accounts/policy/injectors) through verbatim. Constructing
// this with the real dispatcher exports yields behavior byte-identical to
// calling those exports directly — which is exactly the flag-off contract.
export function makeInProcessTransport(
  facade: DispatcherFacade,
  deps: DispatcherDeps,
  meta: { pid?: number; version?: string } = {},
): RunnerTransport {
  return {
    async health() {
      return { pid: meta.pid ?? process.pid, version: meta.version ?? "in-process", ok: true };
    },
    async getActive() {
      return facade.activeLoomIds();
    },
    async start(input) {
      return facade.startLoom(input, deps);
    },
    async startFromBundle(loomId, by, opts) {
      return facade.startLoomFromBundle(loomId, by, deps, opts);
    },
    async approveCharter(id, by) {
      return facade.approveCharter(id, by, deps);
    },
    async approveEnv(id, by, config) {
      // M7 — direct delegation (flag-off). Guarded so a facade without the verb
      // wired surfaces a clear error rather than a silent undefined call.
      if (!facade.approveEnv) throw new Error("approveEnv not wired on this dispatcher facade");
      return facade.approveEnv(id, by, config, deps);
    },
    async steer(id, directive, by) {
      return facade.steerLoom(id, directive, by, deps);
    },
    async reject(id, feedback, by) {
      return facade.rejectLoom(id, feedback, by, deps);
    },
    async resume(id) {
      return facade.resumeLoom(id, deps);
    },
    async cancel(id) {
      return facade.cancelLoom(id);
    },
  };
}
