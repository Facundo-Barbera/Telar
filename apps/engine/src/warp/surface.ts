/**
 * WARP — the script-authoring surface, and nothing else.
 *
 * Warp is Telar's name for the fan-out harness the frozen app called Ultra: the
 * set of parallel threads held under tension on a loom. `packages/core/src/
 * ultra/` is the legacy implementation and keeps the legacy name; its own header
 * says what carries forward and what does not — "the script-authoring surface is
 * the good part and is what a Telar Warp should port; where its observations GO
 * is what changes."
 *
 * So this is the port of `ultra/surface.ts`, and the ten modules behind it —
 * storage, journal, event bus, wake loop — are deliberately NOT ported. A Warp
 * agent is a `Task` on the session's own event stream, carrying `WarpLinkage`
 * (`packages/engine-client/src/protocol/tasks.ts`). One stream, one roster, one
 * timeline component; the pane and the directing agent read the same rows and
 * therefore cannot disagree.
 *
 * TWO DEPARTURES FROM THE LEGACY, both toward the harness the authoring agent
 * has actually seen (Claude Code's ultracode/Workflow):
 *
 *   1. THE SCRIPT IS A BODY, NOT A DEFAULT EXPORT. The legacy took
 *      `export default async function (surface) {}` and passed the surface as
 *      the single argument. A Warp script is `export const meta = {…}` followed
 *      by statements that use `agent()`/`parallel()`/… directly, with top-level
 *      `await` and top-level `return`. It is the shape every example an agent
 *      has read is written in, and an authoring surface that fights the author's
 *      prior costs a round trip per script.
 *   2. `model` IS OPTIONAL. The legacy REQUIRED it on every call and rejected a
 *      model-less script statically. Telar's own rule is the opposite and older:
 *      `DriverRun.model` documents that ABSENT means "the provider's own
 *      default", because "a driver that substituted a name here would silently
 *      override whatever the installed harness is configured to use". Absent
 *      here means the session's model — the one the user picked — and naming one
 *      overrides it for that agent.
 */

/** What a script may pass to a single `agent()` call. */
export type WarpAgentOpts = {
  /**
   * ABSENT INHERITS THE SESSION'S MODEL. Name one only when this agent should
   * differ from what the user chose — a cheap model for a mechanical stage, a
   * stronger one for the judge.
   */
  model?: string;
  /** Reasoning effort, where the provider has the concept. Same absent rule. */
  effort?: string;
  /**
   * Force a structured answer instead of prose.
   *
   * A JSON Schema. The child is made to answer through a structured-output tool
   * and the result is validated before it is returned, so a mismatch makes the
   * MODEL retry rather than handing the script malformed data. This is what
   * makes a fan-out composable: with it, the stage between two agents is
   * ordinary code — filter, dedupe, count, threshold, early-exit — instead of
   * another agent hired to read the last one's paragraphs.
   */
  schema?: Record<string, unknown>;
  /** Overrides the display label; defaults to a truncation of the prompt. */
  label?: string;
  /**
   * Assigns this agent to a progress group explicitly.
   *
   * NEEDED INSIDE `parallel`/`pipeline` STAGES, where the ambient `phase()` is a
   * race: several stages advance concurrently and the last writer wins. Naming
   * the phase on the call is the only way to be sure a row lands in the box a
   * reader expects.
   */
  phase?: string;
  /**
   * How many turns this child may take before the harness stops it.
   *
   * Ported with the legacy's warning attached, because it is not a tuning knob:
   * a child that runs out does NOT fail loudly, it settles as a dead agent — and
   * if it was an editing child it may already have changed files. Absent uses
   * the runner's default.
   */
  maxTurns?: number;
  /** A fresh git worktree, for agents that mutate in parallel and would
   *  otherwise collide. Narrows WHERE writes land, never WHETHER a child may
   *  write — there is no per-agent permission knob. */
  isolation?: boolean;
  /** A named sub-agent definition instead of the default Warp child. */
  agentType?: string;
};

/**
 * Everything a script can reach.
 *
 * INJECTED AS CONTEXT GLOBALS rather than passed as an argument — see departure
 * (1) above. They are frozen, and the script runs under "use strict", so an
 * assignment to one throws instead of silently shadowing the harness.
 */
export type WarpSurface = {
  /**
   * One sub-agent. Resolves to its final text, or — with `schema` — to the
   * validated object.
   *
   * RESOLVES TO `null` FOR A DEAD AGENT rather than throwing, so a fan-out is
   * not lost to one casualty; `.filter(Boolean)` is the documented idiom. Stop,
   * and the run-lifetime backstop, are control signals and DO propagate.
   */
  agent: (prompt: string, opts?: WarpAgentOpts) => Promise<unknown>;
  /**
   * Concurrent, with a barrier: every thunk settles before this resolves.
   *
   * THE BARRIER IS THE COST. Correct only when the next step genuinely needs all
   * of the previous one at once — dedupe across the whole set, an early exit on
   * a total, a prompt that compares one finding against the others. "I need to
   * flatten first" is not a reason; that belongs inside a pipeline stage.
   */
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<(T | null)[]>;
  /**
   * Each item through every stage independently, with NO barrier between them.
   *
   * The default for multi-stage work, and the reason is wall-clock: item A can
   * be in stage 3 while item B is still in stage 1, so the run costs the slowest
   * single chain rather than the sum of the slowest-per-stage. Every stage
   * receives `(previousResult, originalItem, index)`. A stage that throws drops
   * that item to `null` and skips its remaining stages.
   */
  pipeline: (items: unknown[], ...stages: unknown[]) => Promise<unknown[]>;
  /** Opens a progress group. Subsequent agents land in it — but see
   *  `WarpAgentOpts.phase` for why that is unsafe inside concurrent stages. */
  phase: (title: string) => void;
  /** A narrator line for the human watching, shown above the progress tree. */
  log: (message: string) => void;
  /** The JSON value passed at launch. `undefined` when none was. */
  args: unknown;
};

/** A phase as `meta` declares it. Declared UP FRONT so a client can draw the
 *  whole progress tree before any agent finishes, rather than growing it row by
 *  row and reflowing under the reader. */
export type WarpMetaPhase = { title: string; detail?: string };

/**
 * The `meta` block every script must open with.
 *
 * A PURE LITERAL, enforced statically — no variables, calls, spreads or template
 * interpolation. It is read BEFORE the script runs, to name the run and draw its
 * shape, and a `meta` that could execute would have to be run to be read.
 */
export type WarpMeta = {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WarpMetaPhase[];
  model?: string;
};
