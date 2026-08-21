/**
 * THE ORCHESTRATOR'S MODEL CALL — the real `LoomAgent`, replacing the refusal
 * `daemon.ts` shipped in its place.
 *
 * ── ONE STRUCTURED ANSWER, NOT PROSE THAT LOOKS LIKE ONE ────────────────────
 * The tick's whole output is a `TickDecision`, and it is handed straight to
 * `validateDecision` and then to machinery that cuts worktrees. So the shape is
 * FORCED rather than hoped for: `structuredAgent` mounts the schema as
 * `emit_result`'s input, the SDK rejects a call that does not fit before this
 * file sees it, and a result that still does not parse comes back as
 * `{ok: false}` with the failing paths named. Nothing here parses prose.
 *
 * ── NO BASH. THIS IS THE POINT, NOT A PRECAUTION ────────────────────────────
 * The orchestrator does not run commands. `probe`, `list` and `detail` are run
 * by the MACHINERY (`dispatch.ts`, through the injected `LoomExec`), their
 * output is pasted into the prompt, and the agent reads and decides. That split
 * is what makes "the worker never runs the gate" true of the orchestrator too:
 * an orchestrator with a shell could run the gate, could push, could `gh pr
 * merge` — every boundary the Program declares would become a request rather
 * than a wall.
 *
 * So the tool list is `structuredAgent`'s default read-only wall — `Read`,
 * `Grep`, `Glob` — and `assertWall` is what says so in a test without spending
 * a token. `Bash`, `Write`, `Edit` and `Agent` are in `NEVER_TOOLS`, which is
 * an SDK-level deny that outranks any allow rule a repository's own `.claude`
 * settings could introduce.
 *
 * READ-ONLY IS STILL REACH, and it is deliberate: the agent is given the
 * project's own checkout as `cwd` so it can check whether a file an item names
 * still exists, or whether the function a bug report blames was deleted three
 * weeks ago. A triage decision made without that is made from the title.
 *
 * ── FAILURE IS REPORTED IN THE VOCABULARY OF THE THING THAT FAILED ──────────
 * `LoomAgent` collapses to `{ok: false, reason}` — one string — and `runLoomTick`
 * throws it, which lands it in the run record and the deck. So the string is the
 * entire diagnosis, read by a person at 8am who was asleep when it happened. A
 * rate limit ("the account is out of budget; nothing is wrong with your
 * Program"), a refusal to answer ("the model stopped without deciding") and a
 * shape mismatch ("it answered, in the wrong shape, here") send that person to
 * three different places, so they are three different sentences.
 *
 * ── CONSTRUCTION IS INERT ───────────────────────────────────────────────────
 * `createLoomAgent` allocates a closure. No SDK is imported, no CLI is resolved,
 * no process is spawned until a tick actually asks — which is what lets
 * `startEngine` wire this unconditionally while every existing test still boots
 * a daemon that cannot reach a provider.
 */
import { TickDecision } from "@telar/engine-client";
import {
  isRateLimit,
  retryAfterFrom,
  structuredAgent,
  type ClaudeAgentSdk,
  type StructuredAgentFailure,
} from "../agent";
import type { LoomAgent } from "./dispatch";

/**
 * STATED, NOT INHERITED, for the reason `agent.ts` gives about its own default:
 * an unnamed model is a silent choice nobody made. A tick reads a backlog and
 * decides what to spend a worker on, so it is the judgement call in this system
 * — but it makes that call every few minutes, all night, and the ceiling on
 * what it can do wrong is `validateDecision`. Sonnet is the balance that buys;
 * a project that wants more names it here.
 */
const DEFAULT_MODEL = "sonnet";

/**
 * Enough turns to read a handful of files and answer.
 *
 * The asymmetry `agent.ts` describes applies with full force here: a call that
 * runs out of turns emits nothing, so the tokens spent reaching that turn buy a
 * tick that decided nothing. A tight cap does not produce a shorter decision, it
 * loses the whole decision.
 */
const DEFAULT_MAX_TURNS = 24;

export type LoomAgentDeps = {
  /**
   * The project's checkout, by id — the SAME registry-anchored resolver the
   * runtime uses, so the agent can never be pointed at a directory nobody
   * registered. A tick that carries its own `cwd` wins; a project with no root
   * on this machine leaves the call at the engine's own cwd, which for a
   * read-only call is deliberately uninteresting.
   */
  projectRoot?: (projectId: string) => string | null;
  model?: string;
  maxTurns?: number;
  /** Which binary answers. Same reasoning as everywhere else in this engine. */
  binaryPath?: string;
  env?: Record<string, string | undefined>;
  /** Wall-clock, injected, so a rate limit's reset time is testable. */
  now?: () => number;
  /**
   * THE OFFLINE SEAM. `structuredAgent`'s third parameter, passed straight
   * through: a test hands back a fake SDK and a fake executable, and the whole
   * control flow of a tick runs without a subprocess, without the Claude SDK on
   * disk and without a cent of rate limit.
   */
  loadSdk?: () => Promise<ClaudeAgentSdk>;
  resolveExecutable?: (binaryPath?: string) => string | undefined;
  /** Progress, for a run record that wants to say where the tick is. */
  onStep?: (step: { n: number; label: string }) => void;
};

export function createLoomAgent(deps: LoomAgentDeps = {}): LoomAgent {
  const now = deps.now ?? Date.now;

  return async (prompt, context) => {
    /**
     * THE PROJECT'S OWN ROOT, so `Read`/`Grep` see the repository the decision
     * is about. Not a worktree: the tick describes the project as it is, and a
     * loom's worktree is one item's private, possibly hours-stale copy of it.
     */
    const cwd = context?.cwd ?? (context ? (deps.projectRoot?.(context.projectId) ?? undefined) : undefined);

    const answer = await structuredAgent(
      prompt,
      {
        schema: TickDecision,
        label: context ? `loom tick (${context.projectId})` : "loom tick",
        model: deps.model ?? DEFAULT_MODEL,
        maxTurns: deps.maxTurns ?? DEFAULT_MAX_TURNS,
        // NO `tools` OPTION AT ALL — see the header. The default IS the wall,
        // and passing one here would be the first step toward widening it.
        ...(cwd ? { cwd } : {}),
        ...(deps.binaryPath ? { binaryPath: deps.binaryPath } : {}),
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.onStep ? { onStep: deps.onStep } : {}),
      },
      {
        ...(deps.loadSdk ? { loadSdk: deps.loadSdk } : {}),
        ...(deps.resolveExecutable ? { resolveExecutable: deps.resolveExecutable } : {}),
      },
    );

    if (answer.ok) return { ok: true, value: answer.value };
    return { ok: false, reason: explain(answer.kind, answer.reason, answer.retryAfter, now()) };
  };
}

/**
 * One failure → one sentence a human can act on.
 *
 * THE PROVIDER'S OWN WORDS ARE KEPT, in parentheses, because the sentence has to
 * survive a failure mode nobody anticipated. What is added in front of them is
 * the thing the words alone never say: whether this is about the account, about
 * the machine, about the Program, or about the model.
 */
function explain(kind: StructuredAgentFailure, reason: string, retryAfter: number | undefined, at: number): string {
  /**
   * RE-CLASSIFIED, because `structuredAgent` only tests for a rate limit on the
   * error it catches from the query itself. A limit that surfaces while the SDK
   * is loading, or while the CLI is being resolved, arrives as `unavailable`
   * with a 429 in its message — and telling an operator to install Claude when
   * the account is simply out of budget for the hour sends them to the one place
   * where there is nothing to fix.
   */
  const limited = kind === "rate-limited" || isRateLimit(reason);
  if (limited) {
    const resetAt = retryAfter ?? retryAfterFrom(reason, at);
    return [
      "the tick did not run because the account is rate limited, not because anything is wrong with this project's Program.",
      "Nothing was decided, nothing was dispatched and nothing was written.",
      resetAt
        ? `The provider said it will accept work again at ${new Date(resetAt).toISOString()}; the watch keeps its own cadence and will tick again after that on its own.`
        : "The watch keeps its own cadence and will tick again on its own; no action is needed unless every tick tonight says this.",
      `(${reason})`,
    ].join(" ");
  }

  switch (kind) {
    case "malformed":
      /**
       * THE FAILING PATHS ARE ALREADY IN `reason` — `structuredAgent` names
       * every zod issue as `path: message`. That is the actionable part, so it
       * is not summarised away.
       */
      return [
        "the orchestrator answered, but in a shape that is not a decision this engine can act on, so the tick was discarded rather than half-applied.",
        "Nothing was dispatched. This is a model failure rather than a configuration one — the next tick usually succeeds; a run of them means the Program's prompt is asking for something the schema has no room for.",
        `(${reason})`,
      ].join(" ");

    case "no-result":
      return [
        "the orchestrator finished its turn without ever deciding anything, so this tick classified nothing and dispatched nothing.",
        "That is either a refusal — the prompt asked for something the model would not answer — or a turn budget spent reading before it got to the answer.",
        "The backlog is untouched and the next tick will look at exactly the same world.",
        `(${reason})`,
      ].join(" ");

    case "unavailable":
      return [
        "the tick could not reach a model at all, so nothing was decided.",
        "This is about THIS MACHINE, not about the project: Claude Code is missing, not on PATH, or the pinned binary no longer exists.",
        "Every tick will fail identically until it is installed or the path is corrected — `claude --version` in a terminal is the fastest way to see what this saw.",
        `(${reason})`,
      ].join(" ");

    case "aborted":
      return `the tick was cancelled before the orchestrator decided anything; nothing was dispatched and nothing was written. (${reason})`;

    default:
      return reason;
  }
}
