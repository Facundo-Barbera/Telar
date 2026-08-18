/**
 * ONE CALL, ONE STRUCTURED ANSWER — the engine's seam for asking a model a
 * question and getting back a validated object instead of prose.
 *
 * Every turn the engine runs today is SESSION-BOUND: `driver.ts` answers a
 * claim, streams observations, and parks on `canUseTool` waiting for a human.
 * That is the right shape for a conversation and the wrong shape for the work
 * `docs/spool-definition.md` describes — interpreting a fragment, drafting a
 * briefing, deciding overnight which item is unblocked. Those need a call that
 * takes its scope as ARGUMENTS, answers once, and cannot ask anyone anything.
 *
 * Ported from `packages/core/src/engine.ts`'s `agent()`, which neither new app
 * may import. The mechanism is unchanged: an in-process MCP server exposing one
 * `emit_result` tool whose input shape IS the caller's schema, so the model
 * cannot answer in the wrong shape — the SDK rejects the tool call before this
 * file ever sees it.
 *
 * ── WHY `bypassPermissions` IS SAFE HERE AND NOWHERE ELSE ────────────────────
 * There is nobody to ask. A structured call has no session, no request queue,
 * and no human parked on it, so `canUseTool` would have no one to route to and
 * every approval would deadlock. The permission mode is therefore not the wall.
 * THE TOOL LIST IS THE WALL, and it is built from three independent layers
 * because any one of them can be widened by something outside this file:
 *
 *   1. `tools`            — AVAILABILITY. Under `bypassPermissions` an allow
 *                           list does not gate what is loaded, so without this
 *                           the whole preset (Write/Edit/Bash/Agent) stays
 *                           mounted and approved.
 *   2. `allowedTools`     — approval, for the modes where it does gate.
 *   3. `disallowedTools`  — an explicit SDK deny beats ANY allow rule, including
 *                           one a repo's own `.claude` settings introduced.
 *
 * `assertWall()` below is the test-visible statement that the three travel
 * together. A future option that relaxes one of them has to get past it.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT HAVE ─────────────────────────────────────
 * NO ADMISSION CONTROL. The donor acquired a slot from a global limiter before
 * spending money. The engine has no equivalent — its concurrency lives in the
 * worker pool, which this path does not go through. A caller that fans out is
 * responsible for its own ceiling until something here needs one; the overnight
 * runner is the first thing that will, and it should bring the limiter with it
 * rather than inherit an unowned one.
 *
 * NO WRITES. The model returns a value and this file returns it. Every disk
 * write a pass performs happens in the CALLER, through the store's audited
 * verbs — which is why a call that dies halfway leaves nothing half-written,
 * and why "prepare, never commit" is a property of the SHAPE of the answer
 * rather than a check on it.
 *
 * NO SESSION, NO RESUME, NO JOURNAL. Nothing here appears in a transcript. A
 * caller that wants the user to see what happened records it on the item, which
 * is where a human looks.
 */
import { z } from "zod";
import { requireCli } from "./cli-resolution";

/**
 * READ-ONLY BY DEFAULT, and the default is the whole point: a caller has to opt
 * INTO reach rather than remember to opt out of it. These three are the donor's
 * expert wall and the widest set any structured call has needed.
 */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * NEVER AVAILABLE TO A STRUCTURED CALL, at any callsite, by any option.
 *
 * Redundant with restricting availability, and kept for the two reasons the
 * donor gives: an explicit deny outranks every allow rule, and a built-in that
 * ships under a NEW name is available the day it lands unless something names
 * it. `MultiEdit` is on the list for exactly that reason.
 *
 * "Agent" IS THE LOAD-BEARING NAME. A sub-agent spawned from inside a structured
 * call inherits THIS call's cwd and policy, so a nested spawn would make every
 * claim in this header true of only the outermost call — and, for the Spool
 * specifically, would hand a project-scoped expert the ability to spawn a child
 * scoped to nothing.
 */
export const NEVER_TOOLS = ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"] as const;

/** Stated, never inherited. An unnamed model is a silent choice nobody made. */
const DEFAULT_MODEL = "sonnet";

/**
 * Generous on purpose, and the asymmetry is why: a call that runs out of turns
 * emits NO structured result, so the caller writes nothing and the money spent
 * reaching that turn buys zero. A tight cap does not produce a shorter answer;
 * it loses the whole answer.
 */
const DEFAULT_MAX_TURNS = 40;

/** What a completed call cost. Threaded out rather than logged because an
 *  assistant that spends money unattended has to be able to say how much. */
export type AgentUsage = {
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  costUsd?: number;
  turns?: number;
};

export type StructuredAgentResult<T> =
  | { ok: true; value: T; usage?: AgentUsage }
  /**
   * THREE DISTINGUISHABLE FAILURES, not one null.
   *
   * The donor returned `T | null` and made every caller invent the sentence. A
   * caller here has to tell a human what happened, and "the model never
   * answered", "the model answered in a shape that does not fit" and "there is
   * no Claude on this machine" call for three different sentences and three
   * different next moves.
   */
  | { ok: false; reason: string; kind: StructuredAgentFailure; retryAfter?: number };

/**
 * `rate-limited` IS ITS OWN KIND, and separating it from `unavailable` is the
 * whole reason overnight work can be trusted to run unattended.
 *
 * Every other failure is about THIS call: the model did not answer, or answered
 * wrongly, or there is no Claude installed. Retrying the next item is correct
 * for all of them. A rate limit is about the ACCOUNT, so the next item would
 * fail identically, and a runner that treated it as one more per-item failure
 * would walk the whole queue burning a request per item to learn the same fact
 * it already knew.
 *
 * It is therefore a signal to STOP, not to skip — see `spool/night.ts`.
 */
export type StructuredAgentFailure = "no-result" | "malformed" | "unavailable" | "aborted" | "rate-limited";

/**
 * Whether a provider error means "the account is out of budget for now".
 *
 * A HEURISTIC OVER A MESSAGE, and stated as one rather than dressed up: the SDK
 * surfaces this as prose, not as a typed error, so this reads the shapes it is
 * known to use. Being wrong in the SAFE direction costs one night's remaining
 * work and nothing else — the jobs stay pending and the next run picks them up.
 * Being wrong the other way costs a loop of doomed requests, which is the
 * failure this exists to prevent.
 */
export function isRateLimit(message: string): boolean {
  return /\b(rate[ _-]?limit|429|too many requests|quota exceeded|usage limit|overloaded_error)\b/i.test(message);
}

/**
 * When the provider says it will accept work again, in epoch ms, if it said so.
 *
 * READ FROM THE MESSAGE for the same reason as above. Absent is the ordinary
 * case and is not a failure: a runner with no reset time waits for its next
 * ordinary trigger instead of guessing one.
 */
export function retryAfterFrom(message: string, now: number): number | undefined {
  const seconds = /retry[- ]after[:\s]+(\d+)/i.exec(message) ?? /try again in (\d+)\s*s/i.exec(message);
  if (seconds?.[1]) return now + Number(seconds[1]) * 1000;
  const stamp = /resets? (?:at )?(\d{10,13})/i.exec(message);
  if (stamp?.[1]) {
    const value = Number(stamp[1]);
    // Ten digits is seconds, thirteen is milliseconds. Guessing wrong here
    // would park the runner for a month or for no time at all.
    return value < 1e11 ? value * 1000 : value;
  }
  return undefined;
}

export type StructuredAgentOptions<S extends z.ZodObject<z.ZodRawShape>> = {
  /** The forced answer shape. Becomes `emit_result`'s input schema. */
  schema: S;
  /** Names the call in errors and in whatever a caller logs. */
  label: string;
  /** Where the model may read, when it may read at all. Omitted means the
   *  engine's own cwd, which for a read-only call is deliberately uninteresting. */
  cwd?: string;
  model?: string;
  maxTurns?: number;
  /** Widen past `READ_ONLY_TOOLS`. Anything in `NEVER_TOOLS` is dropped rather
   *  than honoured — see `assertWall`. */
  tools?: readonly string[];
  /** Env for the child process, already resolved by the caller (a provider
   *  instance's credentials, typically). Replaces rather than patches, matching
   *  the SDK's own semantics. */
  env?: Record<string, string | undefined>;
  /** Which binary answers. Same reasoning as `driver.ts`: a login pinned to a
   *  beta build must not be probed as one thing and run as another. */
  binaryPath?: string;
  abort?: AbortController;
  /**
   * CALLED AS THE CALL WORKS, so something minutes long can say where it is.
   *
   * This module's header says a structured call has "no session, no resume, no
   * journal" and that remains true: nothing is recorded, nothing is streamed to
   * a client, and a caller that passes nothing gets exactly the old behaviour.
   * The loop below was ALREADY iterating every message and discarding all but
   * the last — this hands them to whoever asked instead of dropping them.
   *
   * A THROWING CALLBACK MUST NOT KILL THE PASS. Progress is decoration; the
   * answer is the point. See the guarded call at the callsite.
   */
  onStep?: (step: { n: number; label: string }) => void;
  /**
   * TOOLS THAT TAKE EFFECT WHILE THE CALL IS STILL RUNNING.
   *
   * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
   * Everything on this path so far has been one-shot: read some things, think,
   * call `emit_result` once, and the caller sees nothing until it lands. That is
   * right for a pass whose product is a record.
   *
   * It is wrong for a pass whose product is a SURFACE. If the model is composing
   * something for a person to look at, the composition IS the output and it
   * should appear as it is made — a minute of "Starting…" followed by a page
   * arriving all at once is the same information delivered in the least useful
   * possible order.
   *
   * So a caller may register handlers that run the moment the model calls them.
   * They are mounted on the same `out` server as `emit_result` and are subject to
   * the same wall: an SDK MCP tool is a function in this process, not a shell,
   * and it can only do what the handler its caller wrote does.
   *
   * `emit_result` IS STILL REQUIRED. A stream of side effects with no final act
   * has no way to distinguish "finished" from "stopped talking" — the exact
   * inference `!emitted` below exists to refuse.
   */
  sideTools?: readonly SideTool[];
};

/** One tool a caller mounts alongside `emit_result`. `shape` is a zod raw shape
 *  for the same reason `schema` is: the SDK builds the model-facing JSON Schema
 *  from it, so there is one description of the arguments rather than two. */
export type SideTool = {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /** Returns the line handed back to the model. Throwing is reported to the
   *  model as an error rather than killing the call — see the wrapper below. */
  handler: (input: unknown) => Promise<string> | string;
};

/** The narrow slice of the SDK a structured call uses. Its own type rather than
 *  `driver.ts`'s `ClaudeSdk`, because that one is session-shaped — it pins
 *  `permissionMode: "default"` and carries `resume`, `canUseTool` and partial
 *  messages, none of which exist on this path. */
export type ClaudeAgentSdk = {
  query(input: {
    prompt: string;
    options: Record<string, unknown>;
  }): AsyncIterable<Record<string, unknown>>;
  tool(
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (input: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
  ): unknown;
  createSdkMcpServer(input: { name: string; version: string; tools: unknown[] }): unknown;
};

/**
 * THE WALL, COMPUTED IN ONE PLACE so a test can read it without a provider and
 * without spending a cent.
 *
 * Pure and total. Everything this module's header claims about a structured
 * call — read-only unless widened, never able to write or spawn, its permission
 * mode paired with a restriction — is a property of what this returns.
 */
export function assertWall(tools: readonly string[] | undefined): {
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  dropped: string[];
} {
  const requested = tools ?? READ_ONLY_TOOLS;
  const never = new Set<string>(NEVER_TOOLS);
  /**
   * DROPPED, NOT REFUSED. A caller asking for `Bash` has made a mistake this
   * function can correct completely — the call still runs, read-only, and the
   * dropped name is reported so the mistake is visible rather than silent.
   * Throwing would turn a too-wide request into a dead capability, which is the
   * worse failure for an overnight run nobody is watching.
   */
  const dropped = requested.filter((t) => never.has(t));
  const granted = requested.filter((t) => !never.has(t));
  return {
    // Availability: built-ins only. MCP names are not built-ins and the SDK
    // rejects them here, so they are filtered out and appear only in the
    // approval list below.
    tools: granted.filter((t) => !t.startsWith("mcp__")),
    allowedTools: [...granted, EMIT_TOOL],
    disallowedTools: [...NEVER_TOOLS],
    dropped,
  };
}

const EMIT_TOOL = "mcp__out__emit_result";

/**
 * Resolves the user's own Claude Code, and lets `requireCli`'s actionable
 * message out unchanged.
 *
 * DELIBERATELY NOT WRAPPED IN `ProviderUnavailableError`. `driver.ts` wraps
 * because a turn has to fail the way every other provider failure fails; this
 * path has no turn to fail. Importing that class would also make every
 * structured call depend on the whole session driver — which imports the spool
 * tools, which is where the first caller of this function lives.
 */
function defaultExecutable(binaryPath?: string): string {
  return requireCli("claude", { ...(binaryPath ? { binaryPath } : {}) });
}

/**
 * ONE SDK MESSAGE → ONE LINE A HUMAN CAN READ, or nothing.
 *
 * PURE AND EXPORTED so the whole vocabulary is readable in a test without a
 * provider — the same reason `assertWall` is pure.
 *
 * THE GRAMMAR IS THE COCKPIT'S, deliberately: a transcript there reads
 * "Thought · ToolSearch · spool_list_items", so a Spool pass reading files
 * should say "Read" and "Grep" in the same voice rather than inventing a second
 * dialect for the same act. The `mcp__server__` prefix is stripped for the same
 * reason the cockpit strips it — it names our plumbing, not what happened.
 *
 * A TOOL'S TARGET IS INCLUDED WHEN IT IS SHORT AND OBVIOUS. "Read" alone tells
 * you the pass is alive; "Read reconciliation.ts" tells you it is on the right
 * track, which is the only reason to look at a progress line at all.
 */
export function stepLabel(message: Record<string, unknown>): string | undefined {
  if (message.type !== "assistant") return undefined;
  const body = message.message as Record<string, unknown> | undefined;
  const content = Array.isArray(body?.content) ? (body.content as Record<string, unknown>[]) : [];

  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "";
    if (!name) continue;
    // The forced final act, named for what it means rather than for its plumbing.
    if (name === EMIT_TOOL) return "Writing the result";
    const short = name.replace(/^mcp__[^_]+__/, "");
    const input = (block.input ?? {}) as Record<string, unknown>;
    const target = input.file_path ?? input.path ?? input.pattern ?? input.query;
    if (typeof target !== "string" || target.length === 0 || target.length > 60) return short;
    // A path is read at its tail: the leading directories are the part every
    // sibling call shares, so they are the part that carries no information.
    return `${short} ${target.includes("/") ? (target.split("/").pop() ?? target) : target}`;
  }

  // Prose with no tool call is the model reasoning between acts. Its CONTENT is
  // not shown — a half-written sentence flickering in a one-line window reads
  // as a glitch — only that it happened.
  return content.some((block) => block.type === "text") ? "Thinking" : undefined;
}

function readUsage(message: Record<string, unknown>): AgentUsage | undefined {
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const n = (value: unknown): number => (typeof value === "number" && value >= 0 ? value : 0);
  const cost = message.total_cost_usd;
  const turns = message.num_turns;
  return {
    tokens: {
      input: n(usage.input_tokens),
      output: n(usage.output_tokens),
      cacheRead: n(usage.cache_read_input_tokens),
      cacheCreate: n(usage.cache_creation_input_tokens),
    },
    ...(typeof cost === "number" && cost >= 0 ? { costUsd: cost } : {}),
    ...(typeof turns === "number" && turns >= 0 ? { turns } : {}),
  };
}

/**
 * Ask once, get a validated object back.
 *
 * `loadSdk` and `resolveExecutable` are injected for the reason `driver.ts`
 * injects them: a test must never depend on which CLIs the machine running it
 * happens to have, and the whole control flow of a pass is worth driving
 * without a subprocess.
 */
export async function structuredAgent<S extends z.ZodObject<z.ZodRawShape>>(
  prompt: string,
  options: StructuredAgentOptions<S>,
  deps: {
    loadSdk?: () => Promise<ClaudeAgentSdk>;
    resolveExecutable?: (binaryPath?: string) => string | undefined;
  } = {},
): Promise<StructuredAgentResult<z.infer<S>>> {
  const loadSdk = deps.loadSdk ?? (() => import("@anthropic-ai/claude-agent-sdk") as unknown as Promise<ClaudeAgentSdk>);
  const resolveExecutable = deps.resolveExecutable ?? defaultExecutable;

  let sdk: ClaudeAgentSdk;
  try {
    sdk = await loadSdk();
  } catch (error) {
    return {
      ok: false,
      kind: "unavailable",
      reason: `${options.label}: the Claude Agent SDK is not available (${error instanceof Error ? error.message : String(error)}).`,
    };
  }

  let executable: string | undefined;
  try {
    executable = resolveExecutable(options.binaryPath);
  } catch (error) {
    return {
      ok: false,
      kind: "unavailable",
      reason: `${options.label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const wall = assertWall(options.tools);
  /** Side tools are MCP names on our own server, so they join the approval list
   *  exactly where `emit_result` does — never the built-in `tools` array, which
   *  the SDK rejects MCP names in. */
  const sideNames = (options.sideTools ?? []).map((side) => `mcp__out__${side.name}`);

  /**
   * CAPTURED, NOT RETURNED THROUGH THE TOOL. The SDK hands the tool's return
   * value back to the model, not to us, so the result has to land in a closure.
   * Raw here and parsed after the loop: the SDK validates against the shape it
   * was given, and this file re-parses anyway, because a shape check performed
   * by someone else's code is not a guarantee this module can make.
   */
  let raw: unknown;
  let emitted = false;
  let usage: AgentUsage | undefined;
  let steps = 0;

  const out = sdk.createSdkMcpServer({
    name: "out",
    version: "1.0.0",
    tools: [
      sdk.tool("emit_result", "REQUIRED final act: emit your structured result exactly once.", options.schema.shape, async (value) => {
        raw = value;
        emitted = true;
        return { content: [{ type: "text", text: "recorded" }] };
      }),
      /**
       * A FAILING SIDE TOOL IS REPORTED TO THE MODEL, NOT THROWN AT THE CALLER.
       *
       * These run mid-call, and letting one reject would abort the whole query
       * through the SDK's iterator — losing a pass that may be most of the way
       * done because one draw was malformed. Handed back as text, the model can
       * see what it did wrong and try again, which is the behaviour every other
       * tool in the loop already has.
       */
      ...(options.sideTools ?? []).map((side) =>
        sdk.tool(side.name, side.description, side.shape, async (value) => {
          try {
            return { content: [{ type: "text", text: (await side.handler(value)) || "ok" }] };
          } catch (error) {
            return {
              content: [{ type: "text", text: `error: ${error instanceof Error ? error.message : String(error)}` }],
            };
          }
        }),
      ),
    ],
  });

  try {
    for await (const message of sdk.query({
      prompt: `${prompt}\n\nWhen finished, call emit_result exactly once with your final result.`,
      options: {
        cwd: options.cwd ?? process.cwd(),
        model: options.model ?? DEFAULT_MODEL,
        maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
        // See this file's header: there is nobody to ask, and the tool wall —
        // not this line — is what makes that safe.
        permissionMode: "bypassPermissions",
        tools: wall.tools,
        allowedTools: [...wall.allowedTools, ...sideNames],
        disallowedTools: wall.disallowedTools,
        mcpServers: { out },
        /**
         * ZERO AMBIENT CONFIG. A structured call is not a session the operator
         * configured, and a repository's own `.claude` settings could otherwise
         * hand it hooks and MCP servers Telar never mounted — on a path with no
         * human to notice. `strictMcpConfig` closes the same door from the other
         * side.
         */
        settingSources: [],
        strictMcpConfig: true,
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        ...(options.abort ? { abortController: options.abort } : {}),
      },
    })) {
      if (message.type === "result") usage = readUsage(message);
      if (options.onStep) {
        const label = stepLabel(message);
        if (label) {
          steps += 1;
          /**
           * GUARDED, because progress is decoration and the answer is not. A
           * caller whose callback throws — a registry entry evicted mid-pass,
           * say — must not lose a twenty-turn result to it.
           */
          try {
            options.onStep({ n: steps, label });
          } catch {
            // Nothing to report to: the callback WAS the reporting channel.
          }
        }
      }
    }
  } catch (error) {
    if (options.abort?.signal.aborted) {
      return { ok: false, kind: "aborted", reason: `${options.label}: the call was cancelled; nothing was written.` };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isRateLimit(message)) {
      // ABOUT THE ACCOUNT, NOT ABOUT THIS ITEM. The caller must stop rather
      // than move on — see `StructuredAgentFailure`.
      const retryAfter = retryAfterFrom(message, Date.now());
      return {
        ok: false,
        kind: "rate-limited",
        reason: `${options.label}: the account is rate limited (${message}). Nothing was written.`,
        ...(retryAfter ? { retryAfter } : {}),
      };
    }
    return { ok: false, kind: "unavailable", reason: `${options.label}: ${message}` };
  }

  if (!emitted) {
    /**
     * NEVER INFER SUCCESS FROM A FINISHED LOOP. A turn that ran out of turns,
     * was cancelled, or simply stopped talking ends the same way a good one
     * does. The absence of an emit is the only evidence that matters.
     */
    return {
      ok: false,
      kind: "no-result",
      reason: `${options.label}: the model finished without emitting a result; nothing was written.`,
    };
  }

  const parsed = options.schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "malformed",
      reason: `${options.label}: the model emitted a result that does not fit the expected shape (${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}).`,
    };
  }

  return { ok: true, value: parsed.data as z.infer<S>, ...(usage ? { usage } : {}) };
}
