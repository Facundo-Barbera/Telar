// Ultra control signals — errors that are NOT ordinary agent failures.
//
// engine.parallel() (engine.ts:228) coerces every throw to null; Ultra's own
// parallel/pipeline (executor.ts) re-throws these four so a Stop, an
// explicit-model contract breach, a stringified-object prompt, or a runaway
// backstop terminates the run instead of being silently swallowed to a
// dead-agent null (doc §3 carve-out).

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

// Thrown by the injected agent() when the prompt is not a usable string — it is
// not a string at all, or it carries a stringification artifact ("[object
// Object]" / "[object Promise]"). REJECTED, NEVER COERCED, because the coercion
// ALREADY HAPPENED: `String(obj)` IS "[object Object]", so the text the child
// would be sent says nothing, and a second coercion here would buy a real,
// billed agent call for an empty question. Coercing to a dead-agent null is
// equally wrong — this is a deterministic AUTHORING error and a re-run cannot
// fix it — which is exactly the posture NFR-UW-5 already fixed for
// MissingModel, one class over.
export class BadPrompt extends Error {
  readonly signal = "BadPrompt" as const;
  constructor(reason: string, label?: string) {
    super(`Ultra agent() was given ${reason}${label ? ` (agent "${label}")` : ""}`);
    this.name = "BadPrompt";
  }
}

// Stop (human button or ultra_stop) aborts the run's shared AbortController;
// the engine agent()'s SDK abort surfaces as an error named "AbortError". We
// match by name (the SDK/DOMException shape) rather than by identity.
// A STOP IS A STOP HOWEVER THE PROVIDER SPELLS IT. `name === "AbortError"` is
// the DOM convention and is what a `fetch`/`AbortController` rejection carries,
// but the Agent SDK surfaces a cancelled query as an ordinary `Error` whose
// message is "Operation aborted" — no special name. That fell through to the
// `failed` arm in executor.ts, so a run the user had deliberately stopped
// reported itself as a FAILURE with "Error: Operation aborted" in red, which is
// both alarming and untrue: nothing went wrong, someone pressed Stop.
//
// Matched on the message only as a FALLBACK and only for that exact phrase, so
// a genuine error that merely mentions aborting something (a git message, a
// tool's output quoted into an error) is not silently reclassified as a stop.
const ABORT_MESSAGE = /^operation aborted\.?$/i;

export const isAbortError = (e: unknown): boolean => {
  if (!e || typeof e !== "object") return false;
  if ((e as { name?: unknown }).name === "AbortError") return true;
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" && ABORT_MESSAGE.test(msg.trim());
};

// The full carve-out set: these propagate past parallel/pipeline barriers.
export const isControlSignal = (e: unknown): boolean =>
  isAbortError(e) ||
  e instanceof MissingModel ||
  e instanceof LifetimeExceeded ||
  // NOT OPTIONAL. Without this line parallelFn/pipelineFn coerce a BadPrompt to
  // a dead-agent null and the run continues, having spent nothing on a call the
  // author believes succeeded — the exact silence the guard exists to end, made
  // WORSE than before by the author now believing a guard exists.
  e instanceof BadPrompt;
