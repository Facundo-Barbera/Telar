// The injected surface — the ONLY capabilities an Ultra script has (doc §3).
// Shape is FROZEN here even where a member is stubbed until a later cut, so the
// executor and the sandbox agree on one contract. Passed frozen as the single
// argument to the script's default export.
import type { z } from "zod";

/** What one agent call consumed, as the provider reported it. The same
 *  pair-plus-cache split `UsageEntry` stores, so a figure derived from this is
 *  comparable with the session ledger's rather than being a second definition
 *  of "tokens". Lives here — the leaf module both the executor and the journal
 *  already depend on — so neither has to import the other to name it. */
export type UltraTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
};

// Opts the script may pass to agent(). `model` is REQUIRED (enforced at call
// time, throws MissingModel). `phase` is journaled DISPLAY metadata only.
//
// `effort` IS REAL NOW, and this comment used to say the opposite: "the engine
// SDK has no reasoning-effort field, so effort never reaches the model (recon
// reality-check #5)". That was measured against an older SDK and stopped being
// true — `apps/web/app/api/chat/route.ts` passes `effort` straight into the
// same `query()` options every session turn uses. Until this change an Ultra
// script could name an effort, see it on the agent's chip, and get a model that
// had never been told: a control that displayed but did nothing, which is
// exactly the placebo the house rules forbid. It is now threaded through
// `engineOpts` to the SDK.
//
// `isolation` (fresh worktree for parallel mutators) is honored in a later cut;
// it narrows WHERE writes land, never WHETHER a child can write. No per-agent
// permission knob — the child posture is fixed (doc §3).
export type UltraAgentOpts = {
  model: string;
  schema?: z.ZodObject<z.ZodRawShape>;
  label?: string;
  phase?: string;
  effort?: string;
  isolation?: boolean;
  // THE ONE ESCAPE from the stringified-object prompt guard (signals.ts's
  // BadPrompt, enforced in executor.ts's agentFn). Off by default, and it must
  // stay off by default: the artifact it rejects is unrecoverable and invisible
  // otherwise.
  //
  // The false positive it exists for is NOT contrived. The normal fan-out →
  // synthesis shape embeds an upstream agent's own TEXT in the next stage's
  // prompt (`result.text`, exactly as the guard's message tells authors to do),
  // and that text can legitimately quote a log line, a code review or a bug
  // report containing "[object Object]". The rejection would then fire at the
  // SYNTHESIS call, after the whole fan-out is already paid for, and kill the
  // run. Being explicit here is the MissingModel posture — say what you mean
  // rather than have the guard be clever about quoting.
  allowStringifiedObject?: boolean;
};

export type UltraAgentFn = (prompt: string, opts: UltraAgentOpts) => Promise<unknown>;

export type UltraSurface = {
  // Wraps engine agent(). Returns the typed result or null (dead agent).
  agent: UltraAgentFn;
  // Concurrent-with-a-barrier fan-out. An agent-failure thunk → null; Stop /
  // MissingModel / lifetime backstop propagate (control-signal carve-out).
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<(T | null)[]>;
  // Per-item pipeline (doc §3): each item flows all stages independently, no
  // inter-stage barrier; a throwing stage drops that item to `null` and skips
  // its remaining stages (same control-signal carve-out as parallel).
  pipeline: (items: unknown[], ...stages: unknown[]) => Promise<unknown>;
  // Progress grouping + narrator lines into the run's event stream.
  phase: (title: string) => void;
  log: (msg: string) => void;
  // The JSON value passed at invocation.
  args: unknown;
};
