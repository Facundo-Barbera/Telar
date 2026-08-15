/**
 * WARP SPAWN — the only file in `warp/` that costs money.
 *
 * The runner is deliberately ignorant of how a child actually runs; it takes a
 * `WarpSpawn` and everything it pins — concurrency, phases, the dead-agent rule,
 * stop semantics — is testable for free because of that. This is the other side
 * of that seam: one function that turns `agent("find the bug", {…})` into a real
 * `claude` process through the Agent SDK.
 *
 * THREE DECISIONS LIVE HERE, and each is a real constraint rather than a knob:
 *
 *   1. A CHILD MAY NOT FAN OUT. `Agent`, `Task` and `Workflow` are disallowed,
 *      so the SCRIPT is where parallelism is expressed and nowhere else. Without
 *      this a four-agent warp is four agents that may each spawn four more, and
 *      the runner's concurrency gate — which is counting real processes on the
 *      user's machine — would be counting the wrong thing entirely.
 *   2. TELAR'S OWN MCP SERVER IS WITHHELD, the user's are passed. A child that
 *      could call `warp` would recurse without bound, and four children sharing
 *      one browser scope would fight over the same tabs. The user's servers are
 *      what the session was given to work with, and a child cut off from them is
 *      crippled at exactly the task it was hired for.
 *   3. STEERING IS A STREAMING-INPUT SESSION. The mailbox contract the runner
 *      defines — "drain at a turn boundary" — is only expressible if the child
 *      can take another turn, and that means the async-iterable prompt form. A
 *      child nobody steers takes exactly one turn and the generator returns, so
 *      the common path is unchanged.
 */

import type { UsageSnapshot } from "@telar/engine-client";
import type { WarpAgentOutcome, WarpSpawn, WarpSteer } from "./runner";

/**
 * The slice of the Agent SDK a warp child needs.
 *
 * DECLARED HERE RATHER THAN IMPORTED FROM `driver.ts`, so `warp/` depends on
 * nothing but the contract and can be tested with an eight-line fake. The driver
 * passes its own `sdk` in and the structural types meet in the middle.
 */
export type WarpSpawnSdk = {
  /**
   * The prompt is `AsyncIterable<unknown>` rather than of this file's own
   * message type ON PURPOSE. The driver declares the same `query` from the other
   * side, narrowed to what a TURN sends; if both declarations named a concrete
   * message shape they would have to be the same shape, and one would end up
   * cast past the other. What goes into the stream is checked where it is built
   * — `steeredPrompt` returns `WarpUserMessage` — which is where a mistake
   * would actually be made.
   */
  query(input: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }): AsyncIterable<unknown>;
};

export type WarpUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
};

/**
 * Everything about the SESSION a child inherits, resolved once per turn.
 *
 * The per-agent half — prompt, model override, schema, maxTurns — arrives on the
 * call. The split is the same one `DriverRun` draws: which login and which
 * checkout are facts about the session, and a child that resolved them for
 * itself would be a second place those decisions live.
 */
export type WarpSpawnEnvironment = {
  sdk: WarpSpawnSdk;
  cwd: string;
  /** The session's model. A child inherits it unless the script names another —
   *  see `WarpAgentOpts.model` for why absent is a real answer. */
  model?: string;
  effort?: string;
  fastMode?: boolean;
  /** The login's environment patch, applied over this process's own. */
  env?: Record<string, string | undefined>;
  /** Which `claude` to spawn. Absent leaves the SDK's own lookup alone. */
  executable?: string;
  /** The USER's MCP servers, already in the SDK's shape. Telar's are withheld
   *  — see decision (2). */
  mcpServers?: Record<string, unknown>;
  /** The session's permission gate. A warp child is not exempt from it: a
   *  session that asks before editing asks for a child's edits too. */
  canUseTool?: unknown;
  /**
   * How many turns a child may take when the script names no `maxTurns`.
   *
   * ABSENT MEANS UNBOUNDED, which is what the SDK does by default and what an
   * open-ended research child needs. The runner's lifetime backstop bounds the
   * number of agents; nothing here bounds one agent's thinking, deliberately.
   */
  defaultMaxTurns?: number;
};

/**
 * Tools a warp child may never call.
 *
 * `Agent` is the current name and `Task` the older one; both are listed because
 * a name that does not exist costs nothing and a fan-out that slips through
 * costs processes. `Workflow` is Claude Code's own harness — a warp child
 * running one would nest a fleet inside a fleet, and neither the gate nor the
 * roster would see it.
 */
export const WARP_CHILD_DISALLOWED_TOOLS = ["Agent", "Task", "Workflow"] as const;

/**
 * A turn boundary the prompt generator can wait on.
 *
 * EDGE-TRIGGERED WITH A COUNTER, not a bare promise, and that is the whole
 * reason this is a class. A `result` message can arrive before the generator
 * gets around to awaiting the next boundary; a level-triggered signal would
 * miss it, the generator would park for ever, and the SDK would sit waiting for
 * an input that never comes — the same deadlock the mailbox was introduced to
 * kill, reintroduced one layer down.
 */
class TurnBoundary {
  private settled = 0;
  private observed = 0;
  private closed = false;
  private waiters: Array<(open: boolean) => void> = [];

  /** A turn just ended. */
  mark(): void {
    this.settled += 1;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(true);
  }

  /** The output stream ended: no further boundary can ever arrive. */
  close(): void {
    this.closed = true;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(false);
  }

  /** Resolves `true` at the next (or an already-missed) boundary, `false` once
   *  the stream is closed. */
  next(): Promise<boolean> {
    if (this.settled > this.observed) {
      this.observed = this.settled;
      return Promise.resolve(true);
    }
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => this.waiters.push(resolve));
  }
}

const userMessage = (text: string): WarpUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

/**
 * The child's input, as a stream that stays open exactly as long as it is used.
 *
 * The generator yields the prompt, then waits for the turn to settle and looks
 * in the mailbox. Empty — which is every unsteered child — and it returns, which
 * ends the session as a plain one-shot. Anything waiting becomes the next turn.
 */
async function* steeredPrompt(prompt: string, steer: WarpSteer, boundary: TurnBoundary): AsyncGenerator<WarpUserMessage> {
  yield userMessage(prompt);
  while (await boundary.next()) {
    const queued = steer.drain();
    if (queued.length === 0) return;
    // Joined rather than yielded one at a time: they arrived while a single
    // turn was running, so they are one interruption with several sentences.
    yield userMessage(queued.join("\n\n"));
  }
}

/**
 * A child's token usage, from its `result` message.
 *
 * NOT SHARED WITH THE DRIVER'S `usageFrom` even though the field names match:
 * that one reads a streaming assistant message mid-turn, this reads a terminal
 * result, and `warp/` deliberately imports nothing from `driver.ts` so it stays
 * testable without an SDK. Ten lines is the price of that seam.
 */
function childUsage(value: unknown, costUsd: unknown): UsageSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const n = (candidate: unknown): number => (typeof candidate === "number" && candidate >= 0 ? candidate : 0);
  if (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number") return undefined;
  return {
    tokens: {
      input: n(usage.input_tokens),
      output: n(usage.output_tokens),
      cacheRead: n(usage.cache_read_input_tokens),
      cacheCreate: n(usage.cache_creation_input_tokens),
    },
    ...(typeof costUsd === "number" && costUsd >= 0 ? { costUsd } : {}),
  };
}

/** The SDK's effort vocabulary. A word from another provider is DROPPED rather
 *  than forwarded, for the reason `driver.ts` gives at length: failing a child
 *  over a display-level nicety is the worse trade of the two. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function createWarpSpawn(environment: WarpSpawnEnvironment): WarpSpawn {
  return async function spawn({ prompt, opts, signal, steer }): Promise<WarpAgentOutcome> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    const boundary = new TurnBoundary();
    const effort = opts.effort ?? environment.effort;
    const maxTurns = opts.maxTurns ?? environment.defaultMaxTurns;

    let text: string | undefined;
    let structured: unknown;
    let usage: UsageSnapshot | undefined;
    let failure: string | undefined;
    let succeeded = false;

    try {
      for await (const message of environment.sdk.query({
        prompt: steeredPrompt(prompt, steer, boundary),
        options: {
          cwd: environment.cwd,
          permissionMode: "default",
          abortController: controller,
          // NO PARTIAL MESSAGES. A child's deltas have nowhere to land — a warp
          // agent's row carries its title, state, usage and final report, not a
          // nested transcript — and forwarding them would multiply the turn's
          // observation traffic by the width of the fan-out for nothing.
          includePartialMessages: false,
          disallowedTools: [...WARP_CHILD_DISALLOWED_TOOLS],
          ...(opts.model ?? environment.model ? { model: opts.model ?? environment.model } : {}),
          ...(effort && EFFORTS.has(effort) ? { effort } : {}),
          ...(environment.fastMode === undefined ? {} : { settings: { fastMode: environment.fastMode } }),
          ...(maxTurns === undefined ? {} : { maxTurns }),
          // THE SCHEMA IS THE WHOLE REASON A FAN-OUT COMPOSES: the stage between
          // two agents becomes ordinary code — filter, dedupe, threshold —
          // instead of another agent hired to read the last one's paragraphs.
          // The SDK makes the model retry on a mismatch, so the script never
          // sees malformed data.
          ...(opts.schema ? { outputFormat: { type: "json_schema", schema: opts.schema } } : {}),
          /**
           * THE SDK'S OWN `agent` OPTION, which applies a named definition's
           * system prompt, tools and model to the MAIN thread — so a warp child
           * runs as `code-reviewer` without the Agent tool being involved at
           * all. Resolved from the user's own `.claude/agents/`, the same
           * registry the Agent tool reads, which is what makes an agent type the
           * author already uses work here unchanged.
           *
           * A definition may list `Agent` in its own `tools`; the query-level
           * `disallowedTools` above still wins, because it "also blocks
           * harness-internal direct calls" rather than only name lookup. An
           * unknown name is the SDK's error to report, not ours to pre-empt.
           */
          ...(opts.agentType ? { agent: opts.agentType } : {}),
          ...(environment.mcpServers ? { mcpServers: environment.mcpServers } : {}),
          ...(environment.canUseTool ? { canUseTool: environment.canUseTool } : {}),
          ...(environment.env ? { env: { ...process.env, ...environment.env } } : {}),
          ...(environment.executable ? { pathToClaudeCodeExecutable: environment.executable } : {}),
        },
      })) {
        const item = message as {
          type?: string;
          subtype?: string;
          result?: string;
          structured_output?: unknown;
          usage?: unknown;
          total_cost_usd?: unknown;
          errors?: unknown;
        };
        if (item.type !== "result") continue;

        // A TURN ENDED. Told to the generator BEFORE anything else, so a child
        // with a steering message waiting takes its next turn without a gap.
        boundary.mark();

        if (item.subtype === "success") {
          succeeded = true;
          failure = undefined;
          if (typeof item.result === "string") text = item.result;
          if (item.structured_output !== undefined) structured = item.structured_output;
        } else {
          // NOT RETURNED IMMEDIATELY. A steered child can fail one turn and
          // recover on the next, so the LAST result decides — which is also how
          // the SDK reports usage, cumulatively.
          succeeded = false;
          failure = Array.isArray(item.errors) && item.errors.length > 0 ? item.errors.join("; ") : (item.subtype ?? "the agent ended without a result");
        }
        const reported = childUsage(item.usage, item.total_cost_usd);
        if (reported) usage = reported;
      }
    } catch (error) {
      // A stop is not this child's failure — the runner is already unwinding the
      // script and will mark the row `stopped`. Reporting a failure here would
      // put "aborted" in a roster row the human just stopped on purpose.
      if (signal.aborted) return { ...(usage ? { usage } : {}), failure: "stopped" };
      return { ...(usage ? { usage } : {}), failure: error instanceof Error ? error.message : String(error) };
    } finally {
      boundary.close();
      signal.removeEventListener("abort", abort);
    }

    if (!succeeded) {
      return { ...(usage ? { usage } : {}), failure: failure ?? "the agent ended without a result" };
    }
    return {
      ...(text ? { text } : {}),
      ...(structured === undefined ? {} : { structured }),
      ...(usage ? { usage } : {}),
    };
  };
}
