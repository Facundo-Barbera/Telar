// The injected surface — the ONLY capabilities an Ultra script has (doc §3).
// Shape is FROZEN here even where a member is stubbed until a later cut, so the
// executor and the sandbox agree on one contract. Passed frozen as the single
// argument to the script's default export.
import type { z } from "zod";

// Opts the script may pass to agent(). `model` is REQUIRED (enforced at call
// time, throws MissingModel). `phase`/`effort` are journaled DISPLAY metadata
// only — the engine SDK has no reasoning-effort field, so effort never reaches
// the model (recon reality-check #5). `isolation` (fresh worktree for parallel
// mutators) is honored in a later cut; it narrows WHERE writes land, never
// WHETHER a child can write. No per-agent permission knob — the child posture
// is fixed (doc §3).
export type UltraAgentOpts = {
  model: string;
  schema?: z.ZodObject<z.ZodRawShape>;
  label?: string;
  phase?: string;
  effort?: string;
  isolation?: boolean;
};

export type UltraAgentFn = (prompt: string, opts: UltraAgentOpts) => Promise<unknown>;

export type UltraSurface = {
  // Wraps engine agent(). Returns the typed result or null (dead agent).
  agent: UltraAgentFn;
  // Concurrent-with-a-barrier fan-out. An agent-failure thunk → null; Stop /
  // MissingModel / lifetime backstop propagate (control-signal carve-out).
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<(T | null)[]>;
  // Per-item pipeline (doc §3). Stubbed until cut U3; shape fixed now.
  pipeline: (items: unknown[], ...stages: unknown[]) => Promise<unknown>;
  // Progress grouping + narrator lines into the run's event stream.
  phase: (title: string) => void;
  log: (msg: string) => void;
  // The JSON value passed at invocation.
  args: unknown;
};
