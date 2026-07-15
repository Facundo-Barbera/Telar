// Ultra executor core (doc §3 / §7-U1). Compiles a script (sandbox.ts), builds
// the frozen injected surface, and runs the default export as an in-process
// detached task. Owns the runaway brakes: a run-local concurrency semaphore
// (cap 3, SEPARATE from the engine's shared MAX_CONCURRENT=4 gate which every
// agent() self-acquires), a 1000-agent lifetime backstop, and one
// AbortController shared into every agent() call. Journal + ordinal resume land
// in cut U2; this cut assigns ordinals but does not persist them.
import crypto from "node:crypto";
import { z } from "zod";
import { agent as engineAgent, type AgentOpts, type EngineEvent } from "../engine";
import { compileScript, type ScriptMeta } from "./sandbox";
import type { UltraAgentOpts, UltraSurface } from "./surface";
import { MissingModel, LifetimeExceeded, isAbortError, isControlSignal } from "./signals";

// Per-run in-flight cap: no single run holds more than 3 agent() calls at once,
// so a burst of 100 parallel thunks can never starve sibling runs / looms
// (doc §3). Distinct from engine.ts:89's process-wide ceiling of 4.
export const RUN_CONCURRENCY = 3;
// Lifetime backstop: an unbounded loop can't spawn forever (doc §3).
export const LIFETIME_BACKSTOP = 1000;

// The engine agent() signature, injectable so tests drive fakes (no live SDK) —
// mirrors executor.ts's ExecuteOpts.run?: typeof engineAgent DI seam.
export type EngineAgentFn = typeof engineAgent;

// A passthrough schema for the schema-less agent() case: the engine ALWAYS
// forces a typed emit (recon reality-check #6), so "raw final text" is a
// { text } object, not an omitted schema.
const PASSTHROUGH_SCHEMA = z.object({ text: z.string() });

// A minimal counting semaphore (same acquire/waiters idiom as engine.ts:92, but
// run-local so it never touches the process-wide gate).
class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.inFlight >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
  }
  release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }
}

export type UltraState = "running" | "done" | "failed" | "stopped";

// Narrator + lifecycle events for the run stream (phase/log now; richer agent
// lifecycle in U3/U4).
export type UltraEvent =
  | { type: "phase"; title: string }
  | { type: "log"; msg: string }
  | { type: "state"; state: UltraState };

export type UltraRunResult = {
  runId: string;
  state: Exclude<UltraState, "running">;
  meta: ScriptMeta;
  result?: unknown;
  error?: string;
};

export type UltraRun = {
  runId: string;
  meta: ScriptMeta;
  state: () => UltraState;
  stop: () => void;
  finished: Promise<UltraRunResult>;
};

export type StartUltraOpts = {
  runId?: string;
  args?: unknown;
  // DI seam — defaults to the engine agent(); tests pass a canned fn.
  agent?: EngineAgentFn;
  // Narrator/lifecycle sink (phase/log/state).
  onEvent?: (e: UltraEvent) => void;
  // Per-ordinal transcript tap — the engine EngineEvent stream for agent
  // `ordinal`. Wired to agents/<ordinal>.ndjson in cut U4.
  onAgentEvent?: (ordinal: number, e: EngineEvent) => void;
};

const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const newRunId = () => `u-${crypto.randomBytes(6).toString("hex")}`;

const errText = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

// Per-run mutable control state.
type RunControl = {
  readonly abort: AbortController;
  readonly sem: Semaphore;
  issued: number; // monotonic ordinal + lifetime counter (issued at call time)
};

// Build the frozen surface for one run. The agent()/parallel() wrappers are
// closures over the run control so the caps, the backstop, and the shared
// AbortController all apply uniformly.
function buildSurface(ctl: RunControl, opts: StartUltraOpts): UltraSurface {
  const agentFn = async (prompt: string, uOpts: UltraAgentOpts): Promise<unknown> => {
    // model is REQUIRED — a control signal, never coerced to the engine default.
    if (!uOpts || typeof uOpts.model !== "string" || uOpts.model === "") {
      throw new MissingModel(uOpts?.label);
    }
    // Lifetime backstop, checked at ISSUE time (deterministic ordinal order).
    if (ctl.issued >= LIFETIME_BACKSTOP) throw new LifetimeExceeded(LIFETIME_BACKSTOP);
    const ordinal = ctl.issued++;

    // Only the doc's allowed opts reach the engine. effort/phase are journaled
    // display metadata (no SDK field); isolation → worktree in a later cut.
    const engineOpts: AgentOpts<z.ZodRawShape> = {
      schema: uOpts.schema ?? PASSTHROUGH_SCHEMA,
      model: uOpts.model,
      ...(uOpts.label ? { label: uOpts.label } : {}),
      abort: ctl.abort,
      ...(opts.onAgentEvent ? { onEvent: (e: EngineEvent) => opts.onAgentEvent!(ordinal, e) } : {}),
    };

    await ctl.sem.acquire();
    try {
      // The engine agent() self-acquires the shared MAX_CONCURRENT=4 gate.
      return await (opts.agent ?? engineAgent)(prompt, engineOpts);
    } finally {
      ctl.sem.release();
    }
  };

  // Our OWN parallel — engine.parallel (engine.ts:228) swallows AbortError /
  // MissingModel to null; here the control-signal carve-out re-throws them so a
  // Stop / model-contract breach / backstop terminates the run past the barrier.
  const parallelFn = <T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> =>
    Promise.all(
      thunks.map((t) =>
        t().catch((e) => {
          if (isControlSignal(e)) throw e;
          return null; // ordinary agent failure → dead-agent null
        }),
      ),
    );

  // pipeline is implemented in cut U3; the surface shape is fixed now.
  const pipelineFn = async (): Promise<unknown> => {
    throw new Error("pipeline() is implemented in cut U3");
  };

  return Object.freeze({
    agent: agentFn,
    parallel: parallelFn,
    pipeline: pipelineFn,
    phase: (title: string) => opts.onEvent?.({ type: "phase", title }),
    log: (msg: string) => opts.onEvent?.({ type: "log", msg }),
    args: opts.args,
  });
}

// A run that is already terminal (compile reject) with a resolved promise.
function terminalRun(runId: string, meta: ScriptMeta, result: UltraRunResult): UltraRun {
  return { runId, meta, state: () => result.state, stop: () => {}, finished: Promise.resolve(result) };
}

// Compile + start a detached run. Returns immediately (non-blocking, doc §4);
// callers await `finished` for the terminal result. A compile reject returns a
// run already `failed` — the validation-error return path (fleshed out in U5).
export function startUltra(code: string, opts: StartUltraOpts = {}): UltraRun {
  const runId = opts.runId ?? newRunId();
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid ultra runId: ${JSON.stringify(runId)}`);

  const compiled = compileScript(code);
  if (!compiled.ok) {
    return terminalRun(runId, {}, { runId, state: "failed", meta: {}, error: compiled.error });
  }

  const ctl: RunControl = { abort: new AbortController(), sem: new Semaphore(RUN_CONCURRENCY), issued: 0 };
  const surface = buildSurface(ctl, opts);

  let state: UltraState = "running";
  const settle = (next: Exclude<UltraState, "running">, extra?: Partial<UltraRunResult>): UltraRunResult => {
    state = next;
    opts.onEvent?.({ type: "state", state: next });
    return { runId, state: next, meta: compiled.meta, ...extra };
  };

  const finished = (async (): Promise<UltraRunResult> => {
    try {
      const result = await Promise.resolve(compiled.run(surface));
      return settle("done", { result });
    } catch (e) {
      // Stop → stopped (journal prefix kept). MissingModel / LifetimeExceeded /
      // any other throw → failed (never swallowed to a null result).
      if (isAbortError(e)) return settle("stopped");
      return settle("failed", { error: errText(e) });
    }
  })();

  return { runId, meta: compiled.meta, state: () => state, stop: () => ctl.abort.abort(), finished };
}
