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
// The boundary moved to `../steering` when session turns learned to steer too
// (send now). `steering.ts` imports nothing, so the seam this file defends —
// warp/ depends on the contract alone, never on driver.ts — holds.
import { TurnBoundary } from "../steering";
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
 * ONE RULE, NOT A LIST OF GRIEVANCES: a child may not create work that outlives
 * the run or escapes the script's structure. The script is the unit the human
 * started, the roster shows, and `stop` ends; anything a child sets in motion
 * outside those bounds is work nobody can see or cancel.
 *
 * MEASURED, NOT GUESSED. Read off a real child's `system/init` against Claude
 * Code 2.1.233, which offered 27 tools — the four groups below are what that
 * list actually contained, and the `EnterWorktree` entry is there because the
 * evidence contradicted a decision made earlier in this same file's design:
 * `isolation` was removed from the authoring surface on the grounds that Telar
 * cannot yet manage a per-agent worktree, while the child could quietly cut one
 * for itself and produce the very diff that removal was meant to prevent.
 *
 *   · FAN-OUT. `Agent` is the current name and `Task` the older one; both are
 *     listed because a name that does not exist costs nothing and a fan-out that
 *     slips through costs processes. `Workflow` is Claude Code's own harness —
 *     a child running one nests a fleet inside a fleet, and neither the gate nor
 *     the roster would see it.
 *   · SCHEDULING. A cron entry or a wake-up outlives the run by design. The run
 *     ends, the roster empties, and the work fires later with nothing left that
 *     started it.
 *   · REACHING OTHER SESSIONS. Messaging another agent is parallelism expressed
 *     outside the script, which is the same rule as fan-out wearing a different
 *     hat. A notification is the run's to send once, not each child's.
 *   · MOVING THE CHECKOUT. Where a fan-out's writes land is the session's
 *     decision. A child that switched worktrees mid-run would scatter them.
 *   · CREATING OR DRIVING A TELAR SESSION. `sessions_create` is FAN-OUT WEARING
 *     ANOTHER HAT, and the worst-behaved kind: a warp child that could create
 *     sessions would spend the engine's live-session budget from inside a
 *     concurrency gate that is counting `claude` processes and knows nothing
 *     about sessions, and each one it made would outlive the run with nothing
 *     in the roster pointing at it. EVERY other `sessions_*` tool goes with it
 *     rather than only the create verb, and the count is deliberately not named
 *     here — the wall's own test walks the wall and fails a new tool until it is
 *     denied too: steering, reading and stopping a
 *     session from inside a fan-out is parallelism expressed outside the
 *     script, which is the same rule as fan-out in a different hat again.
 *
 *     BELT AND BRACES, DELIBERATELY. Decision (2) already withholds Telar's
 *     whole MCP server from a child, so under `createWarpSpawn` these names are
 *     not reachable in the first place. They are listed anyway because the
 *     server key is not the only way in: the socket at `/v2/sessions/mcp` is
 *     designed to be added to a USER's own `claude mcp add` config, and the
 *     user's servers ARE passed to a child. A name-level denial is the arm that
 *     survives that. It is not a complete one — a user free to name their own
 *     server can name it anything, and `mcp__whatever__sessions_create` is not
 *     on this list — which is exactly why decision (2) is the load-bearing half
 *     and this is the brace.
 *
 * THIS LIST IS VERSION-SHAPED. A future CLI can add a new way out; re-read a
 * child's `system/init` when upgrading rather than trusting this comment.
 */
export const WARP_CHILD_DISALLOWED_TOOLS = [
  "Agent",
  "Task",
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "SendMessage",
  "ListAgents",
  "PushNotification",
  "EnterWorktree",
  "ExitWorktree",
  // Telar's own, fully qualified — `qualifyTelarTool` is what a model sees, and
  // an unqualified `sessions_create` would match nothing.
  "mcp__telar__sessions_list",
  "mcp__telar__sessions_create",
  "mcp__telar__sessions_send",
  "mcp__telar__sessions_read",
  "mcp__telar__sessions_status",
  "mcp__telar__sessions_stop",
  "mcp__telar__sessions_settle",
  "mcp__telar__sessions_diff",
  "mcp__telar__sessions_subscribe",
  "mcp__telar__sessions_unsubscribe",
  "mcp__telar__sessions_subscriptions",
  "mcp__telar__sessions_requests",
  "mcp__telar__sessions_resolve_request",
  "mcp__telar__sessions_report_window",
  // The SAME wall under its HTTP key (`sessions-tools/run-socket.ts`). A warp
  // child is Claude-run and the worker leases the socket to Codex turns only,
  // so today these names are unreachable twice over — listed for the same
  // brace reason as the daemon-socket spellings above: a user could point a
  // server named `telar-sessions` at either sessions door themselves.
  "mcp__telar-sessions__sessions_list",
  "mcp__telar-sessions__sessions_create",
  "mcp__telar-sessions__sessions_send",
  "mcp__telar-sessions__sessions_read",
  "mcp__telar-sessions__sessions_status",
  "mcp__telar-sessions__sessions_stop",
  "mcp__telar-sessions__sessions_settle",
  "mcp__telar-sessions__sessions_diff",
  "mcp__telar-sessions__sessions_subscribe",
  "mcp__telar-sessions__sessions_unsubscribe",
  "mcp__telar-sessions__sessions_subscriptions",
  "mcp__telar-sessions__sessions_requests",
  "mcp__telar-sessions__sessions_resolve_request",
  "mcp__telar-sessions__sessions_report_window",
] as const;

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
const CLAUDE_1M_FAMILY_ALIAS = /^(opus|sonnet|fable)(?:$|[-[])/i;

function isClaudeLongContextFamily(model: string): boolean {
  return /(^|[/])claude-(?:opus|sonnet|fable)-/i.test(model) || CLAUDE_1M_FAMILY_ALIAS.test(model);
}

function contextEnvForModel(model: string | undefined): Record<string, string> | undefined {
  if (model && !isClaudeLongContextFamily(model)) return undefined;
  return { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" };
}

export function createWarpSpawn(environment: WarpSpawnEnvironment): WarpSpawn {
  return async function spawn({ prompt, opts, signal, steer }): Promise<WarpAgentOutcome> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    const boundary = new TurnBoundary();
    const selectedModel = opts.model ?? environment.model;
    const contextEnv = contextEnvForModel(selectedModel);
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
          ...(selectedModel ? { model: selectedModel } : {}),
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
          ...(environment.env || contextEnv ? { env: { ...process.env, ...environment.env, ...contextEnv } } : {}),
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
