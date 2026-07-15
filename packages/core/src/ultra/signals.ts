// Ultra control signals — errors that are NOT ordinary agent failures.
//
// engine.parallel() (engine.ts:228) coerces every throw to null; Ultra's own
// parallel/pipeline (executor.ts) re-throws these three so a Stop, an
// explicit-model contract breach, or a runaway backstop terminates the run
// instead of being silently swallowed to a dead-agent null (doc §3 carve-out).

// Thrown by the injected agent() when a call omits opts.model. The script must
// name the model on every call (doc §4 / owner decision); we never coerce a
// missing model to the engine default. A CONTROL SIGNAL — it ends the run
// `failed`, it is never turned into a null result.
export class MissingModel extends Error {
  readonly signal = "MissingModel" as const;
  constructor(label?: string) {
    super(`Ultra agent() requires opts.model${label ? ` (agent "${label}")` : ""}`);
    this.name = "MissingModel";
  }
}

// Thrown by the injected agent() once a run has issued LIFETIME_BACKSTOP calls.
// The last brake against an unbounded spawn loop (doc §3). Also a control
// signal so it propagates past a parallel() barrier and ends the run `failed`.
export class LifetimeExceeded extends Error {
  readonly signal = "LifetimeExceeded" as const;
  constructor(limit: number) {
    super(`Ultra run exceeded the lifetime backstop of ${limit} agents`);
    this.name = "LifetimeExceeded";
  }
}

// Stop (human button or ultra_stop) aborts the run's shared AbortController;
// the engine agent()'s SDK abort surfaces as an error named "AbortError". We
// match by name (the SDK/DOMException shape) rather than by identity.
export const isAbortError = (e: unknown): boolean =>
  !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";

// The full carve-out set: these propagate past parallel/pipeline barriers.
export const isControlSignal = (e: unknown): boolean =>
  isAbortError(e) || e instanceof MissingModel || e instanceof LifetimeExceeded;
