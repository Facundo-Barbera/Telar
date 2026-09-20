/**
 * Provider code is deliberately a leaf of the engine. It receives an AbortSignal and
 * can only REPORT what it saw; it cannot mutate project or session state. The
 * worker relays those observations to the engine, which owns the durable
 * journal and the terminal transition.
 *
 * WHAT CHANGED IN v2, and it is the whole point of the protocol bump: this file
 * used to read `text_delta` and assistant text blocks and DROP `tool_use`,
 * `tool_result` and `thinking` on the floor. A session therefore rendered as a
 * wall of prose with no tool timeline, no reasoning, and nothing to approve.
 * Every surface the frozen cockpit has and `apps/web` does not was
 * downstream of that one omission.
 */
import crypto from "node:crypto";
import { BROWSER_BRIEFING } from "./browser/briefing";
import { RUN_BRIEFING } from "./run/briefing";
import fs from "node:fs";
import { z } from "zod";
import type {
  ItemDetail,
  ItemSeed,
  McpServer,
  NotificationDetail,
  TurnAttachment,
  RequestDecision,
  RequestDetail,
  RequestKind,
  PlanDetail,
  ProviderWaitDetail,
  TaskKind,
  TaskSeed,
  TaskState,
  TurnObservation,
  UsageSnapshot,
  UserInputField,
} from "@telar/engine-client";
// The tool NAMING rule lives in the contract, not here — see ./protocol/tools.ts
// in engine-client. Every client renders these names too.
import {
  displayToolName,
  isBackgroundWork,
  isTelarMcpServer,
  parseToolName,
  qualifyTelarTool,
  TELAR_BROWSER_MCP_SERVER,
  TELAR_MCP_SERVER,
} from "@telar/engine-client";
import { requireCli } from "./cli-resolution";
import { collectTelarWall, type TelarSocketLease, type TelarWallPart } from "./telar-socket";
import { runTools } from "./run/tools";
import { pluginToolModules } from "./plugins/bundled";
import type { ToolFactory } from "./tool-kit";
import type { RunCapability } from "./run/capability";
import {
  canonicalEnvPatch,
  canonicalJson,
  canonicalServers,
  changedFields,
  fieldDigest,
  fieldDigests,
  resolveChildEnv,
} from "./claude-identity";
import {
  ClaudeRuntimeStore,
  MessageFeed,
  type ClaudeSessionRuntime,
  type FeedMessage,
  type RuntimeBindings,
  type RuntimeQuery,
  taskMemoryFrom,
} from "./claude-runtime";
import { countDiffLines, patchHunksOf, unifiedDiff } from "./diff";
import { createWarpRunner, type WarpSpawn } from "./warp/runner";
import { compileWarpScript } from "./warp/sandbox";
import { createWarpSpawn, type WarpSpawnSdk } from "./warp/spawn";
import { displayTools, type DisplayCapability } from "./display/tools";
import type { SteerMailbox, SteerMessage } from "./steering";
import { framedSteerText, RELAY_RULE, steerRowTitle } from "./attribution";
import { sessionsTools, type SessionsCapability } from "./sessions-tools/tools";
import { notesTools, type NotesCapability } from "./notes-tools/tools";
import { promptsTools, type PromptsCapability } from "./prompts-tools/tools";
import { notebookTools } from "./ds/notebook-tools";
import { dsTools } from "./ds/ds-tools";
import { latexTools } from "./latex/latex-tools";
import type { LatexCapability } from "./latex/capability";
import type { DsCapability } from "./ds/capability";

export { ProviderUnavailableError, normalizeOutcome } from "./provider-contract";
export type { DriverRequest, DriverRequestOutcome, DriverRun, DriverResult, ProviderTurnBinding, DriverSessionHooks, TurnDriver,
  SessionsCapability, DsCapability, DisplayCapability, LatexCapability } from "./provider-contract";
import { ProviderUnavailableError, normalizeOutcome, type DriverRequest, type DriverRequestOutcome, type DriverRun,
  type DriverResult, type ProviderTurnBinding, type DriverSessionHooks, type TurnDriver } from "./provider-contract";
import { requireCwd } from "./provider-contract";

/** The SDK's permission callback, narrowed to what this driver uses. */
type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; title?: string },
) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string; interrupt?: boolean }>;

type SdkMcpServer = unknown;

/**
 * One user message with content blocks, which is the only way to hand this SDK
 * an image.
 *
 * EVERY TURN NOW SENDS THE ASYNC-ITERABLE FORM — a reversal of the old "a
 * plain string stays a plain string" rule, and the reversal has a buyer:
 * SEND NOW. A steered message can only be injected if the input stream is
 * still open when the first response settles, which is exactly what
 * streaming-input mode is. The cost is that the SDK treats the session as
 * multi-turn (`result.usage` stays per-turn; `modelUsage` becomes cumulative
 * — `contextMaxFrom` already reads only the window constant for this
 * reason). `TELAR_CLAUDE_STREAMING_INPUT=0` is the field kill switch back to
 * the plain-string form, at the cost of send-now on Claude.
 */
type SdkUserMessage = {
  type: "user";
  /**
   * `content` IS THE API'S OWN UNION, not the array arm alone.
   *
   * This was narrowed to `Array<…>` because attachments are the only reason the
   * driver builds one — and the SDK's `SDKUserMessage.message` is a
   * `MessageParam`, whose content is `string | ContentBlockParam[]`. Narrowing a
   * borrowed type to the arm you happen to use makes every OTHER caller look
   * wrong: a warp child steers with plain prose and had to be cast past this
   * declaration to say so. The type now describes the SDK rather than one use
   * of it.
   */
  message: { role: "user"; content: string | Array<Record<string, unknown>> };
  parent_tool_use_id: null;
  /** The send's join key — echoed back as `user_message_uuid` on the reply
   *  it triggers. See `FeedMessage.uuid` in ./claude-runtime.ts. */
  uuid?: string;
  /** Present only when a PERSON typed this message — see `FeedMessage.origin`
   *  in ./claude-runtime.ts for why `human` is the only kind that lands. */
  origin?: { kind: "human" };
};

/** The image types the Anthropic API accepts as an image block. Anything else
 *  is offered as a PATH instead — the agent has a Read tool, and a file it can
 *  open beats a block the API rejects. */
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Build the prompt Claude receives, attachments included.
 *
 * IMAGES GO IN AS PIXELS, EVERYTHING ELSE AS A PATH. An image is the one kind of
 * attachment the model cannot open for itself — there is no tool that turns a
 * PNG into something it can see — so it is inlined as base64. A text file, a
 * PDF, a CSV: the agent has Read and the file is on the same disk it is working
 * on, so a path is both smaller and more useful than an inlined copy it cannot
 * re-read later.
 *
 * A file that has vanished between upload and turn is NAMED rather than
 * silently dropped. "Look at this" with nothing attached is a worse failure than
 * a line saying the attachment could not be read.
 */
function claudeInitialContent(prompt: string, attachments: TurnAttachment[]): string | Array<Record<string, unknown>> {
  if (attachments.length === 0) return prompt;
  const blocks: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  for (const attachment of attachments) {
    if (CLAUDE_IMAGE_TYPES.has(attachment.mediaType)) {
      try {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: attachment.mediaType, data: fs.readFileSync(attachment.path).toString("base64") },
        });
        notes.push(`- ${attachment.name} (image, shown above)`);
        continue;
      } catch {
        notes.push(`- ${attachment.name} — attached but could not be read from ${attachment.path}`);
        continue;
      }
    }
    notes.push(`- ${attachment.name} (${attachment.mediaType}) at ${attachment.path}`);
  }
  blocks.push({ type: "text", text: `${prompt}\n\nAttached files:\n${notes.join("\n")}` });
  return blocks;
}

/**
 * A NOTIFICATION, ON THE CLAUDE CHANNEL THAT IS NOT THE PERSON'S — issue #550.
 *
 * TWO MECHANISMS, BECAUSE NEITHER IS SUFFICIENT ALONE.
 *
 * `origin` is the SDK's own provenance channel (`SDKMessageOrigin`) and it is
 * the structural half: `peer` is what a message from another session IS, and
 * `task-notification` is what an engine announcement about a background
 * happening IS. The CLI's `isHuman()` gate reads it, so a peer's report can no
 * longer pass for a person's instruction by arriving on the same stream. It is
 * ALSO the half that can fail silently — an older CLI drops an origin kind it
 * does not know (measured: `docs/investigations/delivery-as-harness-input-2026-09-11.md`
 * §1) — and a provenance channel that fails open is not one to stake the whole
 * claim on.
 *
 * `<system-reminder>` is the content half and the one that cannot be dropped.
 * The harness's own convention is that text inside it is SYSTEM-authored — not
 * the user speaking — and it survives any CLI that forwards content at all.
 * There is no user-role alternative: `SDKUserMessage.message` is a
 * `MessageParam` whose role is fixed to `"user"`, so a literal system role is
 * not expressible on this wire and claiming one would be the same lie in a
 * different field.
 *
 * WHAT IS NOT DONE HERE: `isSynthetic`. It marks messages the CLI GENERATED for
 * itself and setting it on input risks the CLI treating the message as its own
 * echo. The two mechanisms above say what needs saying without guessing at a
 * field's receiving-side behaviour.
 */
export function claudeNotificationOrigin(detail: NotificationDetail): { kind: string; [field: string]: unknown } {
  if (detail.kind === "peer_message") {
    // `from` IS THE ADDRESSABLE IDENTITY and `fromSession` the navigable one;
    // both are the sending session where there is one. A send from the outward
    // sessions socket has no session to name, and says so rather than inventing
    // a plausible id.
    const from = detail.sessionId ?? "sessions-socket";
    return { kind: "peer", from, ...(detail.sessionId ? { fromSession: detail.sessionId } : {}) };
  }
  // A wake and a parked request are the ENGINE reporting a background
  // happening, which is exactly what this kind means to the CLI — and it is the
  // one that gets framed as a notification rather than as prompt authority.
  return { kind: "task-notification" };
}

/**
 * The notice as SYSTEM-authored content. See `claudeNotificationOrigin` for why
 * the tag rather than a role, and why both halves are sent.
 *
 * AND THE RELAY RULE RIDES HERE, NOT IN THE BODY — issue #636, the Claude twin
 * of `codexNotificationInstruction`'s header. The rule belongs to the CHANNEL:
 * it is the role speaking about what a peer message is, so it is said once per
 * driver, outside the minted notice. In the body it was stored, shown on four
 * surfaces, counted against every recipient's context, and — in its old
 * over-broad phrasing — read by four sessions in a row as "an approval relayed
 * by an agent is not an approval".
 *
 * ONLY FOR A PEER MESSAGE. A wake has no peer in it and so no relay question;
 * saying it there would be the same over-application in a smaller costume.
 */
export function claudeNotificationContent(body: string, detail?: NotificationDetail): string {
  const rule = detail?.kind === "peer_message" ? `\n${RELAY_RULE}` : "";
  return `<system-reminder>\n${body}${rule}\n</system-reminder>`;
}

/** The field kill switch: `TELAR_CLAUDE_STREAMING_INPUT=0` restores the
 *  plain-string prompt (and with it, no send-now on Claude). */
export function claudeStreamingInputEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELAR_CLAUDE_STREAMING_INPUT?.trim() !== "0";
}

/** One user message and the stream closes: the kill-switch turn with
 *  attachments still needs the block form, and nothing else does. The
 *  streaming path's input is the session runtime's own MessageFeed. */
async function* singleUserMessage(content: string | Array<Record<string, unknown>>): AsyncGenerator<SdkUserMessage> {
  yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/**
 * The per-turn half of a session runtime — everything the once-created query
 * reaches through `bindings.current`, swapped whole at the top of every run.
 * The query outlives the turn (see ./claude-runtime.ts); these do not: the
 * permission gate is bound to a claim token that dies with the turn, the
 * sessions capability to the worker client that assembled it, and the warp
 * spawn to this turn's model and login.
 */
type ClaudeTurnBindings = {
  signal: AbortSignal;
  canUseTool: SdkCanUseTool | undefined;
  sessions: SessionsCapability | undefined;
  /** The project's notebook, scoped to this turn's project. */
  notes: NotesCapability | undefined;
  /** The project's prompt shelf, scoped to this turn's project AND session. */
  prompts: PromptsCapability | undefined;
  ds: DsCapability | undefined;
  display: DisplayCapability | undefined;
  latex: LatexCapability | undefined;
  /** The project's runs, when the turn carries them. See `run/capability.ts`. */
  run: RunCapability | undefined;
  plugins: Record<string, unknown> | undefined;
  warpSpawn: WarpSpawn;
  onWarpTask: (seed: TaskSeed) => void;
};

/**
 * A capability that reads through to THE CURRENT TURN'S instance on every
 * property access. The Telar MCP tools are registered once per session
 * runtime, but each turn arrives with its own capability object — one
 * captured at creation would call back into a turn that has already settled.
 */
function delegatingCapability<T extends object>(get: () => T | undefined): T {
  return new Proxy({} as T, {
    get(_, prop) {
      const current = get();
      if (!current) throw new Error("this capability is not bound to a running turn");
      return Reflect.get(current, prop);
    },
    has(_, prop) {
      const current = get();
      return current ? Reflect.has(current, prop) : false;
    },
  });
}

/**
 * The user's MCP servers in the SDK's own config shape.
 *
 * A TRANSLATION, NOT A PASS-THROUGH. The contract's `McpServerSpec` is the shape
 * three clients and a settings form agree on; this SDK's is the shape one
 * library wants, and `stdio` is the arm where they differ — the contract names
 * the transport explicitly, the SDK infers it. Keeping our own vocabulary means
 * a Codex-side implementation later reads the same config rather than the
 * Anthropic SDK's.
 */
function claudeMcpServers(servers: McpServer[] | undefined): Record<string, SdkMcpServer> | undefined {
  if (!servers || servers.length === 0) return undefined;
  const out: Record<string, SdkMcpServer> = {};
  for (const server of servers) {
    if (server.spec.transport === "stdio") {
      out[server.id] = {
        type: "stdio",
        command: server.spec.command,
        ...(server.spec.args ? { args: server.spec.args } : {}),
        // Overlaid on the worker's environment rather than replacing it: an MCP
        // server still needs PATH and HOME like any other child process.
        ...(server.spec.env ? { env: { ...process.env, ...server.spec.env } } : {}),
      };
      continue;
    }
    out[server.id] = {
      type: server.spec.transport,
      url: server.spec.url,
      ...(server.spec.headers ? { headers: server.spec.headers } : {}),
    };
  }
  return out;
}

/**
 * The Agent SDK's effort vocabulary, verbatim from its `EffortLevel`.
 *
 * `ModelSelection.effort` is an OPEN string on purpose — provider vocabularies
 * differ, and the contract says so (packages/engine-client/src/protocol/common.ts).
 * So the word travelling from a session may be one this SDK has never heard of,
 * set by another client or by a provider that spells its levels differently. It
 * is DROPPED here rather than forwarded: failing a whole turn over an unknown
 * display-level nicety is the worse trade, and a level the SDK cannot honour is
 * indistinguishable from none.
 */
const CLAUDE_1M_FAMILY_ALIAS = /^(opus|sonnet|fable)(?:$|[-[])/i;

function isClaudeLongContextFamily(model: string): boolean {
  return /(^|[/])claude-(?:opus|sonnet|fable)-/i.test(model) || CLAUDE_1M_FAMILY_ALIAS.test(model);
}

/**
 * Telar no longer offers Claude's 200k variants. Keep 1M enabled for the
 * provider default too, because an absent model means "run Claude Code's
 * default", not "run a short-context row". Explicit unsupported custom ids are
 * left alone rather than given a fabricated meter.
 */
function claudeContextEnvForModel(model: string | undefined): Record<string, string> | undefined {
  if (model && !isClaudeLongContextFamily(model)) return undefined;
  return { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" };
}

/**
 * What the meter may ASSUME before the provider has said anything — and only
 * for a row that explicitly asks for the long window. Measured on the dogfood
 * app: a session configured as bare `opus` was assumed 1M here because the
 * whole family was, while the provider auto-compacted at ~166k–172k. That is
 * consistent with a standard window and inconsistent with 1M; whatever the
 * real window was, `Math.max` against the assumption could never correct the
 * meter downward. A bare id assumes nothing; the provider's own
 * `contextWindow` is what the meter shows from the first result on.
 */
/** The window a Claude id SPELLS — `[1m]` or not. Absent means the provider's
 *  default, which is its own and not this driver's to guess. */
function claudeWindowOf(model: string | undefined): "long" | "default" {
  return model && /\[1m\]$/i.test(model) ? "long" : "default";
}

export function selectedContextMaxFromModel(model: string | undefined): number | undefined {
  return model && /\[1m\]$/i.test(model) && isClaudeLongContextFamily(model) ? 1_000_000 : undefined;
}

type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
const CLAUDE_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);
const claudeEffort = (value: string | undefined): ClaudeEffort | undefined =>
  value !== undefined && CLAUDE_EFFORTS.has(value) ? (value as ClaudeEffort) : undefined;

type ClaudeSdk = {
  query(input: {
    prompt: string | AsyncIterable<SdkUserMessage>;
    options: {
      cwd: string;
      permissionMode: "default";
      systemPrompt?: { type: "preset"; preset: "claude_code"; append: string };
      abortController: AbortController;
      /** Omitted entirely when the session names none — the SDK then uses the
       *  model the local Claude Code install is configured with. */
      model?: string;
      /**
       * The SDK's inline settings layer — the same one `applyFlagSettings`
       * merges into mid-session. `fastMode` lives here rather than in the query
       * options proper, which is why it is threaded separately from `model` and
       * `effort` despite being the same kind of choice to a human.
       */
      settings?: { fastMode?: boolean };
      /** How hard to think. A CLOSED vocabulary here, unlike `DriverRun.effort`
       *  — see `claudeEffort` below. */
      effort?: ClaudeEffort;
      includePartialMessages: true;
      /** Without this the SDK forwards only a sub-agent's tool_use/tool_result
       *  blocks — "enough for a heartbeat counter", in its own words. A nested
       *  transcript needs the text and the thinking too. */
      forwardSubagentText: true;
      /**
       * DECLARES THAT WE STOP TASKS ONE AT A TIME — and the effect that matters
       * here: with this true, an `interrupt()` (a turn Stop) SPARES running
       * background tasks and aborts only the turn. Its ABSENCE fails closed the
       * other way — the SDK kills every background task on interrupt, so the
       * user is never left with a runaway they cannot stop. That default
       * silently undoes the whole point of the session runtime (a turn Stop
       * would take the background work with it), so we opt in and provide the
       * per-task stop (`query.stopTask`) the flag promises.
       */
      perTaskStopAffordance?: boolean;
      resume?: string;
      canUseTool?: SdkCanUseTool;
      mcpServers?: Record<string, SdkMcpServer>;
      env?: Record<string, string | undefined>;
      /**
       * WHICH BINARY ANSWERS THE TURN.
       *
       * Omitted, the SDK resolves an optional ~272MB platform package it ships
       * for itself. That package is not in a packaged Telar (and T3 Code does
       * not ship it either), so in an installed app the option is the
       * difference between a turn running and "native CLI binary not found".
       *
       * It matters in a dev checkout too, where the package IS installed: the
       * Providers pane probes the CLI on the user's own PATH, so without this
       * the version somebody reads in Settings is not the binary that answered
       * them.
       */
      pathToClaudeCodeExecutable?: string;
    };
  }): AsyncIterable<unknown>;
  /** OPTIONAL because the fake SDKs the tests inject only implement `query`.
   *  A driver whose SDK lacks these simply gets no browser tools. */
  createSdkMcpServer?(input: { name: string; version: string; tools: unknown[] }): SdkMcpServer;
  tool?(
    name: string,
    description: string,
    shape: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
  ): unknown;
};

/**
 * WHAT THE DIRECTING AGENT READS WHEN IT IS DECIDING.
 *
 * Written as instructions for choosing, not as a description of parameters: the
 * failure this guards against is not a malformed call, it is a warp launched for
 * work that one agent should have done in a straight line. A fan-out costs a
 * real process per child on the user's own machine.
 *
 * THE SCRIPT API IS NOT HERE, AND THAT IS THE POINT (#515). This string is in
 * every turn of every session whether or not a Warp is ever run — it was 2,988
 * characters of script reference that nobody reads until the moment they write
 * a script, and at that moment they can read the `telar` skill, which is on disk
 * and costs nothing until something asks for it. What stays here is only what a
 * model needs to CHOOSE: what a Warp is, when it is the right shape, what it
 * costs, and where the reference lives. Keep it under the 350-character cap
 * `tool-budgets.test.ts` enforces; anything longer belongs in the skill.
 */
export const WARP_DESCRIPTION = `Run a Warp: a JavaScript script that fans work across sub-agents and returns their combined result. Reach for it when the work is wide — many files, angles or candidates — or when confidence beats speed. Each concurrent child is a real process, so a straight line of work is not one. Begins with \`export const meta\`; script API in the \`telar\` skill.`;

/**
 * `warp`, as an MCP tool.
 *
 * IT BLOCKS UNTIL THE RUN SETTLES, and that is a decision worth stating rather
 * than a limitation to apologise for. The harness this borrows its surface from
 * returns a handle immediately and re-invokes the model when the run finishes —
 * it can, because it owns the loop. Telar's worker does not: a turn ends when
 * the driver returns, `onObservations` is documented as never called after that,
 * and a run still emitting rows would have nowhere to send them. So the tool
 * call IS the run's lifetime, exactly as the Agent tool's call is a sub-agent's,
 * and the directing agent gets the result rather than a receipt.
 *
 * INLINE SCRIPT ONLY — no `name`, no `scriptPath`. Resolving a path here would
 * put a file read inside a tool handler, outside the store boundary every other
 * engine read is fenced at. The agent has a Read tool; a script it has read is a
 * string it can pass.
 */
function warpTool(
  /**
   * THE FACTORY, NOT THE SDK. Warp used to take the whole `ClaudeSdk` and reach
   * for `sdk.tool`, which quietly made it the one core tool that could only be
   * registered in-process. It needs a way to declare a tool and nothing else.
   */
  tool: ToolFactory | undefined,
  deps: {
    spawn: WarpSpawn;
    /** Every row the run produces, in order. The driver decides which event
     *  kind each is — it is the party that knows what it has already announced. */
    onTask: (seed: TaskSeed) => void;
    instanceId?: string;
    /** The turn's own signal, READ AT INVOCATION TIME. A getter rather than a
     *  signal because the tool is registered once per session runtime while
     *  turns come and go — a captured signal would be the first turn's
     *  forever. A human pressing Stop stops the fan-out; without this the
     *  turn would settle while four children kept spending. */
    signal: () => AbortSignal;
    concurrency?: number;
  },
): unknown | undefined {
  if (!tool) return undefined;
  const start = createWarpRunner({
    spawn: deps.spawn,
    emit: deps.onTask,
    newId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
  });

  return tool(
    "warp",
    WARP_DESCRIPTION,
    { script: z.string().min(1), args: z.unknown().optional() },
    async (input) => {
      const compiled = compileWarpScript(String(input.script ?? ""));
      if (!compiled.ok) {
        /**
         * REFUSED BEFORE A runId EXISTS and before one token is spent, and the
         * refusal is addressed to the AUTHOR: the kind so it can branch, the
         * line so it can fix the right one without re-reading the whole script.
         * `isError` rather than a throw, so the model treats it as "that script
         * is wrong" and rewrites, instead of "the tool is broken" and retries.
         */
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: compiled.error, kind: compiled.kind, detail: compiled.detail, line: compiled.line }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const run = start(compiled, {
        ...(deps.instanceId ? { instanceId: deps.instanceId } : {}),
        ...(input.args === undefined ? {} : { args: input.args }),
      });
      const signal = deps.signal();
      const stop = () => run.stop("the turn was stopped");
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });

      let snapshot;
      try {
        snapshot = await run.done;
      } finally {
        signal.removeEventListener("abort", stop);
      }

      const failed = snapshot.agents.filter((agent) => agent.state === "failed");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                runId: snapshot.runId,
                name: snapshot.name,
                state: snapshot.state,
                agents: { total: snapshot.agents.length, failed: failed.length },
                // NAMED, NOT COUNTED. "2 agents failed" tells the author nothing
                // it can act on; which ones, and why, is what decides whether to
                // re-run, narrow the prompt, or accept a partial answer.
                ...(failed.length > 0
                  ? { failures: failed.map((agent) => ({ label: agent.label, failure: agent.failure })) }
                  : {}),
                ...(snapshot.logs.length > 0 ? { logs: snapshot.logs } : {}),
                ...(snapshot.failure ? { failure: snapshot.failure } : {}),
                ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
              },
              null,
              2,
            ),
          },
        ],
        // A run that was stopped or threw is an error to the CALLER even though
        // the rows are all correctly recorded: it did not produce what it was
        // asked for, and a model reading `state: "failed"` inside a success
        // result routinely carries on as though it had.
        ...(snapshot.state === "completed" ? {} : { isError: true }),
      };
    },
  );
}

/**
 * Which REQUEST kind a tool call belongs to.
 *
 * COARSER THAN THE ITEM MAPPING ON PURPOSE. An item type answers "what should
 * this row look like"; a request kind answers "what is the human being asked to
 * permit", and permission is about capability rather than vocabulary — "may you
 * run shell commands here" is one decision whether the tool is `Bash` or
 * `exec_command`. `requests.ts` says the same thing from the other side.
 */
/**
 * TELAR'S OWN READ-ONLY TOOLS, classified as reads rather than as generic tool
 * calls.
 *
 * THE POINT IS A CLASSIFICATION, NOT A BYPASS, and the distinction matters. The
 * engine already has a ladder: `approval-required` auto-accepts `file_read` and
 * parks everything else. A tool that returns the user's own stored state and
 * changes nothing IS a read, so naming it correctly lets the existing rule do
 * its job. Nothing here can skip a mode's decision; it only stops mis-declaring
 * a read as an action.
 *
 * THE LIST IS EXPLICIT, NEVER A PREFIX MATCH ON "list". Anything that writes or
 * spends stays `tool_call` and keeps parking, and a rule shaped like "anything
 * that sounds like a read" would silently adopt the next tool whose name starts
 * well. A name earns its place here one at a time.
 */
// `display_open` is not literally a read, but it is read-SHAPED: it writes
// nothing, spends nothing, and its whole effect is a panel opening on the
// human's own screen — which they watch happen. Parking an approval card for
// "may I show you this?" would be the card answering itself.
/**
 * THE CORE READS. Plugin reads are NOT listed here — they arrive from the HOST
 * at startup through `setPluginReadTools`, because a plugin's own manifest is a
 * CLAIM rather than a grant and only the host may ratify it.
 */
const TELAR_READ_TOOLS = new Set<string>(["display_open"]);

/**
 * The reads the host ratified. EMPTY UNTIL INSTALLED, deliberately.
 *
 * FAIL CLOSED, and the reason is process boundaries. This is a module global,
 * and the out-of-process worker is a DIFFERENT PROCESS from the daemon that
 * calls `setPluginReadTools` — so a default seeded from the static policy table
 * would leave that worker treating as reads a set the host may have NARROWED,
 * silently granting a plugin more than the host allowed. An empty default means
 * an uninstalled process asks for approval on everything, which is the safe
 * direction to be wrong in. `installPluginReadTools` is called on both paths.
 */
let telarPluginReadTools = new Set<string>();

export function setPluginReadTools(tools: Iterable<string>): void {
  telarPluginReadTools = new Set(tools);
}

export function requestKindForTool(name: string): RequestKind {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "command_execution";
  if (name === "Read" || name === "NotebookRead" || name === "Glob" || name === "Grep") return "file_read";
  if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "file_change";
  const parsed = parseToolName(name);
  // Only OUR servers' tools qualify — a user-configured server that happened to
  // name a tool `display_open` must not inherit the engine's own posture.
  if (isTelarMcpServer(parsed.server) && (TELAR_READ_TOOLS.has(parsed.tool) || telarPluginReadTools.has(parsed.tool))) {
    return "file_read";
  }
  return "tool_call";
}

/** The request payload for a tool call, reusing the item mapping's detail. */
export function requestDetailForToolCall(name: string, input: unknown): RequestDetail {
  const detail = itemDetailForToolCall(name, input);
  switch (detail.type) {
    case "command_execution":
      return { kind: "command_execution", command: detail.command };
    case "file_change":
      return { kind: "file_change", change: detail.change };
    case "file_read":
      return { kind: "file_read", read: detail.read };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "browser_action":
      return { kind: "tool_call", call: detail.call };
    default:
      return { kind: "tool_call", call: { name, input: input === undefined ? undefined : input } };
  }
}

const itemId = (): string => `item_${crypto.randomUUID().replaceAll("-", "")}`;

/** Trim a value for a collapsed row label without splitting a surrogate pair. */
function oneLine(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${[...flat].slice(0, max).join("")}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * A message's content as BLOCKS, whatever shape it arrived in.
 *
 * `message.content` is the API's own union, `string | ContentBlockParam[]` —
 * the same union `SdkUserMessage` below documents for OUTBOUND messages. The
 * pump assumed the array arm for INBOUND ones, and a `user` message echoed
 * with plain-string content (a steered sentence, a compaction re-injection, a
 * model switch's re-init) failed the whole turn with
 * `(... ?? []).map is not a function`. Measured twice on this very app. A
 * string is one text block; anything else is no blocks.
 */
function contentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Map one provider tool call onto a canonical item.
 *
 * THE MAPPING IS BY CAPABILITY, NOT BY NAME, which is the property that lets a
 * Claude `Bash` and a Codex `exec_command` land on the SAME row type so the UI
 * needs one renderer rather than one per provider. An unrecognised tool becomes
 * `dynamic_tool_call` rather than being dropped — a new provider tool should
 * show up unstyled, never invisible.
 */
export function itemDetailForToolCall(name: string, input: unknown): ItemDetail {
  const args = asRecord(input);
  const toolInput = input === undefined ? undefined : input;

  if (name === "Bash" || name === "BashOutput") {
    return {
      type: "command_execution",
      command: {
        command: str(args.command) ?? "",
        ...(str(args.cwd) ? { cwd: str(args.cwd)! } : {}),
      },
    };
  }
  if (name === "Read" || name === "NotebookRead") {
    return {
      type: "file_read",
      read: {
        path: str(args.file_path) ?? str(args.path) ?? "(unknown)",
        ...(typeof args.offset === "number" ? { fromLine: Math.max(1, args.offset) } : {}),
      },
    };
  }
  if (name === "Write" || name === "Edit" || name === "NotebookEdit" || name === "MultiEdit") {
    return {
      type: "file_change",
      change: {
        path: str(args.file_path) ?? str(args.path) ?? "(unknown)",
        kind: name === "Write" ? "create" : "edit",
      },
    };
  }
  if (name === "WebSearch") {
    return { type: "web_search", query: str(args.query) ?? "" };
  }
  if (name === "WebFetch") {
    return { type: "dynamic_tool_call", call: { name, input: toolInput } };
  }

  const parsed = parseToolName(name);
  /**
   * TELAR'S OWN TOOLS GET THEIR OWN ROW TYPES.
   *
   * This arm is what `browser_action` was waiting for. It has been in the
   * contract and in the cockpit's icon table since v2 was written, and nothing
   * produced it: the browser was registered as a server called `browser`, so
   * every call matched the generic `mcp__` arm below and rendered as an
   * anonymous MCP row with a duplicated name. Routing on CAPABILITY rather than
   * on server identity is what makes the distinction survive the next toolkit.
   */
  if (parsed.capability === "browser") {
    return {
      type: "browser_action",
      call: { name, server: parsed.server ?? TELAR_MCP_SERVER, input: toolInput },
      // The page it acts on, when the call names one. Absent for a click or a
      // snapshot, which act on wherever the tab already is.
      ...(str(args.url) ? { url: str(args.url)! } : {}),
    };
  }
  if (parsed.server) {
    return {
      type: "mcp_tool_call",
      call: { name, server: parsed.server, input: toolInput },
    };
  }
  return { type: "dynamic_tool_call", call: { name, input: toolInput } };
}

/** The collapsed label for a tool row. Derived once, here, and stored. */
export function titleForToolCall(name: string, detail: ItemDetail): string {
  switch (detail.type) {
    case "command_execution":
      return oneLine(detail.command.command) || name;
    case "file_read":
      return detail.read.path;
    case "file_change":
      return detail.change.path;
    case "web_search":
      return oneLine(detail.query) || name;
    case "browser_action":
      // `browser_navigate → example.com` rather than the qualified name. The
      // stored `call.name` stays fully qualified; this is the label only.
      return detail.url ? `${displayToolName(name)} → ${oneLine(detail.url, 80)}` : displayToolName(name);
    case "mcp_tool_call":
      return displayToolName(name);
    default:
      return name;
  }
}

/**
 * Which kind of task an SDK `task_started` describes.
 *
 * A DENYLIST, matching ./tasks.ts in the contract and t3 code's own comment on
 * the same problem: the SDK renames its agent-flavoured task types as it grows
 * (`subagent`, `local_agent`, `local_workflow`, …), and an ALLOWLIST silently
 * dropped real sub-agents the first time a new name appeared. Only the types
 * KNOWN to be background are treated as background; everything else is an agent
 * and shows up unstyled rather than invisible.
 *
 * `local_bash` IS ON THE LIST BECAUSE THE SDK WAS ASKED. Two probes against the
 * installed 0.3.224: a Bash call with `run_in_background` announces
 * `task_started` with `task_type: "local_bash"`, and the same call in the
 * foreground announces NO TASK AT ALL. So a `local_bash` task is a shell that
 * was backgrounded, which is the definition this list is drawing.
 *
 * THAT SECOND PROBE NO LONGER HOLDS. Measured on CLI 2.1.259
 * (session_7657b2ef…, tasks.json): 232 `local_bash` rows with NO
 * `is_backgrounded`, i.e. ordinary blocking Bash calls, each announced as a
 * task and normally closed one event later by its own tool result. Six of them
 * never were — a turn stopped between the two — and sat at `running` for hours,
 * reporting "monitoring" over a shell that had long exited. See
 * `isForegroundShell` for the rule that keeps those off the roster.
 *
 * Filed as an agent it was worse than mislabelled: the sweep at the end of a run
 * closes every live AGENT as failed and deliberately leaves background work
 * alone, so a `sleep` that outlived its turn — the entire point of backgrounding
 * it — was recorded as an agent that failed to report back.
 */
const BACKGROUND_TASK_TYPES = new Set(["background_shell", "background_bash", "local_bash", "monitor", "watch"]);

export function taskKindForType(taskType: string | undefined): TaskKind {
  return taskType && BACKGROUND_TASK_TYPES.has(taskType) ? "background" : "agent";
}

/** The same classification, but SILENT about a type nobody stated — so an
 *  absent `task_type` reads as "unknown", never as "agent". */
export function taskKindForTypeOrUndefined(taskType: string | undefined): TaskKind | undefined {
  return taskType ? taskKindForType(taskType) : undefined;
}

/**
 * A SHELL THAT BLOCKS ITS TURN IS A TOOL CALL, NOT A TASK. The `Bash` tool_use
 * already produced a `command_execution` item for it; a task row on top is a
 * second row for the same command, and — the measured harm — one that only
 * closes if the CLI's follow-up frame arrives before the turn ends. What makes a
 * shell a TASK is that it was launched detached (`is_backgrounded`), and the
 * only other way it earns a row is being sent to the background later
 * (`task_updated{is_backgrounded: true}`, Ctrl+B), which the caller handles.
 */
export function isForegroundShell(taskType: string | undefined, backgrounded: boolean | undefined): boolean {
  return taskKindForType(taskType) === "background" && backgrounded !== true;
}

/**
 * The SDK's task status vocabulary onto the contract's. `killed` and `paused`
 * have no contract equivalent and map to the nearest honest one — a killed task
 * was stopped, and a paused one is still waiting to resume.
 *
 * THE FALLBACK IS THE CALLER'S, and that is a correction rather than a
 * refinement. This defaulted to `running` for everything it did not recognise,
 * which is right for a start or a progress report and WRONG for a notification —
 * whose whole meaning is that the task is over. The measured consequence: the
 * SDK sent `task_updated{status: killed}` for a backgrounded shell and then a
 * `task_notification` carrying a summary and no status, which this read as
 * `running` and so RESURRECTED a finished task. It then read as still working
 * until the turn ended, at which point the sweep below marked it FAILED — a red
 * row for a task that had done nothing wrong.
 */
export function taskStateForStatus(status: string | undefined, fallback: TaskState = "running"): TaskState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
    case "paused":
      return "waiting";
    case "pending":
      return "pending";
    case "running":
      return "running";
    default:
      return fallback;
  }
}

const TERMINAL_TASK_STATES = new Set<TaskState>(["completed", "failed", "stopped"]);

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

/**
 * A TodoWrite call as the contract's plan.
 *
 * Returns `undefined` when the payload is not a todo list, so an unrecognised
 * shape falls through to an ordinary tool row rather than becoming an empty
 * plan that claims the agent has no steps.
 */
export function planDetailForTodos(input: unknown): PlanDetail | undefined {
  const todos = asRecord(input).todos;
  if (!Array.isArray(todos)) return undefined;
  const steps = todos.flatMap((raw) => {
    const todo = asRecord(raw);
    // `content` is the imperative form; `activeForm` is the present-continuous
    // one the SDK shows while a step runs. The imperative reads correctly in a
    // list whatever the step's state, so it is the one stored.
    const step = str(todo.content) ?? str(todo.activeForm);
    if (!step) return [];
    const status = todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "inProgress" : "pending";
    return [{ step, status } as const];
  });
  return steps.length > 0 ? { steps } : undefined;
}

/** Claude reports cumulative usage per assistant message; the result message
 *  carries the authoritative total plus the price. */
function usageFrom(value: unknown, costUsd: unknown): UsageSnapshot | undefined {
  const usage = asRecord(value);
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const n = (candidate: unknown): number => (typeof candidate === "number" && candidate >= 0 ? candidate : 0);
  return {
    tokens: {
      input: n(input),
      output: n(output),
      cacheRead: n(usage.cache_read_input_tokens),
      cacheCreate: n(usage.cache_creation_input_tokens),
    },
    ...(typeof costUsd === "number" && costUsd >= 0 ? { costUsd } : {}),
  };
}

/**
 * A WAIT THE PROVIDER IMPOSED, from the frame that announced it.
 *
 * Two frames, one row type. `system/api_retry` says a request failed retryably
 * and the SDK will sleep before trying again; `rate_limit_event` says the
 * account's limit state changed. Telar handled neither, so provider backoff was
 * indistinguishable from thinking — the ambiguity the #201 audit could not
 * resolve from the journal.
 *
 * `blocking` separates the two things a row means. A retry, and a REJECTED
 * limit, are the turn standing still: those open an in-progress row that the
 * next frame closes, so the pause has a visible beginning and end. A warning is
 * information, not a wait, and lands as one finished row. A plain `allowed`
 * event is neither and is dropped — a routine "still fine" heartbeat on the
 * timeline is noise.
 *
 * Only whitelisted scalars and enums cross: the retry frame carries the failing
 * request's error object and the limit frame carries account state, and neither
 * belongs in a durable journal.
 */
export function providerWaitFrom(item: {
  type?: string;
  subtype?: string;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  no_response?: unknown;
  rate_limit_info?: unknown;
}): { detail: ProviderWaitDetail; blocking: boolean } | undefined {
  const int = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? Math.trunc(candidate) : undefined;

  if (item.type === "system" && item.subtype === "api_retry") {
    /**
     * THE ATTEMPT THAT GOT NOTHING BACK. The SDK attaches `no_response` only
     * when the API sent no response headers inside the first-byte window, and
     * its `waited_ms` is how long that attempt sat there — the part of the
     * pause that already happened, as opposed to `retry_delay_ms`, which is
     * the second or two still to come. Measured against CLI 2.1.267: a request
     * that stalls before its headers emits NO frame at all until this one, so
     * `waited_ms` is the only account of the silence that precedes it.
     *
     * Its sibling `retry_wait_ms` is deliberately dropped: that is the NEXT
     * attempt's first-byte budget, not a wait anyone is serving.
     */
    const waited = int(asRecord(item.no_response).waited_ms);
    return {
      blocking: true,
      detail: {
        kind: "api_retry",
        ...(int(item.attempt) && int(item.attempt)! > 0 ? { attempt: int(item.attempt)! } : {}),
        ...(int(item.max_retries) === undefined ? {} : { maxAttempts: int(item.max_retries)! }),
        ...(int(item.retry_delay_ms) === undefined ? {} : { delayMs: int(item.retry_delay_ms)! }),
        // A connection error has no HTTP response, and the SDK reports that as
        // a null status. Absent says "no response" rather than inventing a 0.
        ...(int(item.error_status) === undefined ? {} : { status: int(item.error_status)! }),
        ...(waited === undefined ? {} : { waitedMs: waited }),
      },
    };
  }

  if (item.type !== "rate_limit_event") return undefined;
  const info = asRecord(item.rate_limit_info);
  const status = info.status;
  if (status !== "rejected" && status !== "allowed_warning") return undefined;
  const reported = str(info.rateLimitType);
  return {
    blocking: status === "rejected",
    detail: {
      kind: "rate_limit",
      limitStatus: status,
      // A CLOSED SET WITH A FALLBACK. The provider's field is an open string
      // and the set grows, but a durable row a person reads is the last place
      // an unvetted remote label should land. Anything unrecognised is `other`.
      ...(reported === undefined ? {} : { limitType: KNOWN_RATE_LIMIT_TYPES.has(reported) ? (reported as ProviderWaitDetail["limitType"]) : "other" }),
      ...(int(info.resetsAt) === undefined ? {} : { resetsAt: int(info.resetsAt)! }),
      // Finite: `typeof x === "number"` admits Infinity and NaN, and a meter
      // cannot render either.
      ...(typeof info.utilization === "number" && Number.isFinite(info.utilization) && info.utilization >= 0
        ? { utilization: info.utilization }
        : {}),
    },
  };
}

/** The provider's own vocabulary, verbatim from `SDKRateLimitInfo`. Anything
 *  outside it is reported as `other` rather than forwarded — see above. */
const KNOWN_RATE_LIMIT_TYPES = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"]);

/** The collapsed label, derived once by the engine like every other row's. */
export function titleForProviderWait(detail: ProviderWaitDetail): string {
  /**
   * THE ROW THAT SAYS "STILL NOTHING". Its whole content is the elapsed time,
   * because that is all anyone knows: the request went out, nothing has come
   * back, and no provider frame explains it. Said as an observation rather than
   * a verdict — the request may yet answer, and the row closes when it does.
   */
  if (detail.kind === "no_response") {
    const waited = detail.waitedMs === undefined ? "" : ` after ${durationText(detail.waitedMs)}`;
    return `The model has not answered${waited}`;
  }
  if (detail.kind === "rate_limit") {
    // `other` names nothing a person can act on, so it earns no parenthetical.
    const limit = detail.limitType && detail.limitType !== "other" ? ` (${detail.limitType.replaceAll("_", " ")})` : "";
    return detail.limitStatus === "rejected" ? `Rate limit reached${limit}` : `Approaching the rate limit${limit}`;
  }
  const attempt = detail.attempt === undefined ? "" : detail.maxAttempts ? ` (attempt ${detail.attempt} of ${detail.maxAttempts})` : ` (attempt ${detail.attempt})`;
  const delay = detail.delayMs === undefined ? "" : ` in ${durationText(detail.delayMs)}`;
  /**
   * WHY, in the one clause a person reads before deciding whether to wait.
   *
   * `waitedMs` wins when it is there, because it is the bigger number and the
   * true story: the attempt stalled for that long with no response at all, and
   * calling that "a connection error" describes the least of it. Otherwise the
   * status is the honest word; absent means nothing came back, which is a
   * connection failure rather than a rejection.
   */
  const because =
    detail.waitedMs === undefined
      ? detail.status === undefined
        ? "after a connection error"
        : `after HTTP ${detail.status}`
      : `after ${durationText(detail.waitedMs)} with no response`;
  return `Retrying${delay} ${because}${attempt}`;
}

/**
 * HOW LONG A REQUEST MAY BE OUT WITH NOTHING BACK before the turn says so.
 *
 * The CLI announces `system/status {status:"requesting"}` as each request goes
 * out and opens the reply with `message_start`. Between them it reports nothing
 * at all, whatever happens — a request that stalled before its response headers
 * produced sixty seconds of complete silence in the #261 measurement, unchanged
 * with the CLI's own byte and stream watchdogs set — so the engine is the only
 * party that can tell a person the model is unreachable.
 *
 * 30s IS A PRODUCT CHOICE, not a measurement. First token at a large context is
 * routinely slow (the #263 note puts p90 near 15s at 300K), and a row on every
 * slow first token would be noise that teaches people to ignore the row. Double
 * that p90 is late enough to mean something and early enough to beat a person's
 * own "is this thing broken" by a wide margin.
 */
const PROVIDER_SILENCE_MS = 30_000;

/**
 * How long a turn waits for the CLI's `result` after the model has already
 * said `end_turn` before the engine settles the turn itself (#465).
 *
 * MEASURED, NOT ASSUMED. On the coordinator session (session_b1d34698…,
 * 2026-09-14, turns …e52d15 and …7e852d) the main loop's final assistant
 * envelope arrived with `stop_reason: "end_turn"`, every tool result before it
 * was answered, and the `result` frame that ends the turn NEVER came — the
 * CLI's own transcript for the whole two-hour window holds zero `result`
 * rows. The engine turn sat `running` with no output for 15–25 minutes until
 * the owner restarted Telar, five times in one evening. A steered session
 * (peer reports and mid-turn messages injected as steers) is where it shows;
 * the exact CLI-side cause is not known and this driver cannot fix it there.
 *
 * `end_turn` is the model's own statement that it is done; on a healthy
 * producer the `result` follows within milliseconds. Two seconds is long
 * enough that a slow result on a loaded machine still wins, and short enough
 * that a person never reads it as a stall. The turn that settles this way
 * carries a warning row saying so, so a future stall names its cause.
 */
const END_TURN_GRACE_MS = 2_000;

/** Milliseconds as a person would say them. Sub-second stays in ms; anything
 *  longer reads in seconds to one decimal, because "1085ms" is a measurement
 *  and "1.1s" is a duration. */
function durationText(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`;
}

/**
 * THIS TURN'S SPEND, out of the QUERY's running total.
 *
 * `total_cost_usd` is not a turn cost, and reading it as one is the #201
 * accounting defect: the SDK documents it as "cumulative estimated cost for
 * this query() call … cumulative across turns in streaming-input sessions —
 * each result carries the running total so far". Telar holds ONE query per
 * session across many turns, so two results reading $0.10 and $0.30 were
 * stored as two turn costs summing to $0.40 against a query that had spent
 * $0.30. Tokens are unaffected: `usage` really is per-turn.
 *
 * `epoch.totalUsd` is the baseline, carried on the runtime because that is what
 * the total is scoped to. Two resets are handled explicitly, and differently:
 *
 *   - A ZEROED result. The SDK says crash and startup-error results may carry
 *     zeroed values, so zero is "no information", never "the query has spent
 *     nothing since". The baseline is preserved and no cost is reported, so a
 *     crash cannot erase what earlier turns already recorded.
 *   - A LOWER-BUT-NONZERO total. A mid-session `/clear` resets the running
 *     total, and a resumed session starts fresh. That is a new epoch: the whole
 *     of the new total is this turn's, and the baseline restarts there.
 *
 * Returns `undefined` when the provider said nothing — including on
 * subscription plans, where Claude omits cost entirely. That is not $0.00.
 */
export function turnCostFrom(cumulativeUsd: unknown, epoch: { costTotalUsd: number | undefined }): number | undefined {
  if (typeof cumulativeUsd !== "number" || !Number.isFinite(cumulativeUsd) || cumulativeUsd < 0) return undefined;
  const previous = epoch.costTotalUsd;
  if (cumulativeUsd === 0) return previous === undefined ? 0 : undefined;
  epoch.costTotalUsd = cumulativeUsd;
  if (previous === undefined || cumulativeUsd < previous) return cumulativeUsd;
  // Rounded because binary floating point makes 0.3 − 0.1 read as
  // 0.19999999999999998, and a price is not improved by sixteen digits.
  return Math.round((cumulativeUsd - previous) * 1e10) / 1e10;
}

/**
 * How full the window is, from ONE message's usage.
 *
 * Claude reports each assistant envelope's usage as the API call behind it saw
 * the conversation, so `input + cache reads + cache writes + output` of the
 * NEWEST message IS the window's occupancy — the same argument
 * `codex/items.ts` makes for reading `last` rather than `total`. The result
 * message's `usage` is the TURN'S total across calls, which overstates
 * occupancy, so this is never computed from it.
 */
function contextUsedFrom(value: unknown): number | undefined {
  const usage = asRecord(value);
  if (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number") return undefined;
  const n = (candidate: unknown): number => (typeof candidate === "number" && candidate >= 0 ? candidate : 0);
  return n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.output_tokens);
}

/**
 * The window's size, from the result message's `modelUsage` table.
 *
 * The table is keyed per model and the record may name several (main loop plus
 * a smaller sidechain model); the MAX is the main loop's window, which is the
 * one the meter is about. Tokens are deliberately NOT read from this table —
 * in streaming-input sessions it is cumulative across turns, so only the
 * per-model constant is safe to take.
 */
function contextMaxFrom(value: unknown): number | undefined {
  let max: number | undefined;
  for (const entry of Object.values(asRecord(value))) {
    const window = asRecord(entry).contextWindow;
    if (typeof window === "number" && window > 0) max = Math.max(max ?? 0, window);
  }
  return max;
}

/**
 * THE TURN ENDED BECAUSE THE ACCOUNT IS OUT OF USAGE, AND WE KNOW WHEN IT IS NOT.
 *
 * A TYPED ERROR for the same reason `ProviderUnavailableError` is one: the
 * worker maps driver errors to failure codes by class, and this is the seam
 * where "the CLI gave up" stops being one undifferentiated `driver_failed`. It
 * carries the two facts the engine schedules from and nothing else — no
 * provider error text, no headers, no identifiers.
 *
 * `resumeAt` IS MILLISECONDS. The SDK reports `resetsAt` in unix seconds; the
 * conversion happens where this is thrown and nowhere else — see `TurnFailure`.
 */
export class RateLimitedError extends Error {
  readonly resumeAt: number;
  readonly limitType?: ProviderWaitDetail["limitType"];
  constructor(resumeAt: number, limitType?: ProviderWaitDetail["limitType"]) {
    // THE MESSAGE NAMES THE LIMIT AND NOTHING ELSE. It is durable, a person
    // reads it, and the reset time is carried structurally above — so the
    // sentence stays a sentence rather than a second copy of the timestamp in
    // whatever locale the engine happened to be running in.
    const limit = limitType && limitType !== "other" ? `${limitType.replaceAll("_", " ")} ` : "";
    super(`Claude's ${limit}usage limit was reached, so this turn stopped where it stood.`);
    this.name = "RateLimitedError";
    this.resumeAt = resumeAt;
    if (limitType !== undefined) this.limitType = limitType;
  }
}

/**
 * The user's own Claude Code, or a refusal naming what to install.
 *
 * `requireCli` throws a plain Error carrying the actionable message; it becomes
 * a `ProviderUnavailableError` here so the turn fails the same way a missing
 * Codex does, rather than as an internal error with a good message attached to
 * the wrong shape.
 */
function defaultClaudeExecutable(binaryPath?: string): string {
  try {
    return requireCli("claude", { ...(binaryPath ? { binaryPath } : {}) });
  } catch (error) {
    throw new ProviderUnavailableError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Thin, injectable bridge to the locally installed Agent SDK. It does not
 * import Telar's legacy route/core execution layer and leaves approvals at the
 * SDK's normal default — `canUseTool` and hooks arrive in stage 2, and until
 * they do this driver cannot open a request. A missing SDK or login is surfaced
 * as a failure, never a fabricated answer.
 */
export function createClaudeDriver(
  loadSdk: () => Promise<ClaudeSdk> = () => import("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeSdk>,
  options: {
    /**
     * INJECTED so a test never depends on which CLIs the machine running it
     * happens to have installed. The default resolves the user's own Claude
     * Code and refuses the turn when there is none — see `cli-resolution.ts`.
     * Returning `undefined` means "say nothing", which leaves the SDK's own
     * lookup exactly as it was.
     *
     * TAKES THE TURN'S OWN BINARY PATH, because which binary to run is a fact
     * about the LOGIN this turn runs as, not about the driver. Without the
     * argument a login pinned to a beta build would be probed as the beta and
     * then run on the default — the pane describing one binary while another
     * answers, which is the failure `cli-resolution.ts` exists to prevent.
     */
    resolveExecutable?: (binaryPath?: string) => string | undefined;
    /**
     * How long a request may be out with nothing back before the turn says so
     * — see `PROVIDER_SILENCE_MS`. Injected only so a test does not have to
     * sleep for the real threshold.
     */
    providerSilenceMs?: number;
    /** How long to wait for a `result` after `end_turn` — see
     *  `END_TURN_GRACE_MS`. Injected so a test does not sleep for the real one. */
    endTurnGraceMs?: number;
  } = {},
): TurnDriver {
  const resolveExecutable = options.resolveExecutable ?? defaultClaudeExecutable;
  const providerSilenceMs = options.providerSilenceMs ?? PROVIDER_SILENCE_MS;
  const endTurnGraceMs = options.endTurnGraceMs ?? END_TURN_GRACE_MS;
  /** sessionId → live query. Owned per driver instance so every test gets
   *  isolation and each worker deployment owns exactly its own processes. */
  /**
   * ONE `telar` WALL LEASE PER SESSION, plus the bindings ref its wall reads.
   *
   * PER SESSION, NOT PER TURN: the token is baked into the MCP server entry the
   * provider was started with, so minting a fresh one each turn would 401 every
   * reused query. The REF is what makes that safe — `buildRuntime` points it at
   * the live bindings, so a stable lease still serves whatever the current turn
   * carries.
   */
  const telarLeases = new Map<
    string,
    { lease: TelarSocketLease; ref: { current: RuntimeBindings<ClaudeTurnBindings> | undefined } }
  >();

  const runtimes = new ClaudeRuntimeStore<ClaudeTurnBindings, TaskSeed>({
    /**
     * WHAT THE POOL MUST NOT DESTROY. A backgrounded shell, monitor or
     * detached agent lives inside the process and reports through it; evicting
     * that process to honour an idle cap kills the work silently, which is
     * exactly what the #201 fixtures reproduced.
     */
    liveBackgroundWork: (seed) => isBackgroundWork(seed) && !isTerminalTaskState(seed.state),
  });
  return {
    dispose: () => runtimes.destroyAll(),
    stopTask: (sessionId, providerTaskId) => runtimes.stopTask(sessionId, providerTaskId),
    async run({
      prompt,
      promptFromHuman,
      notification,
      sessionId,
      cwd: claimedCwd,
      signal,
      model,
      effort,
      fastMode,
      attachments,
      mcpServers: userMcpServers,
      env,
      binaryPath,
      onObservations,
      onRequest,
      providerSessionId,
      providerInstanceId,
      browserSocket,
      telarSocket,
      orientation,
      mainBriefing,
      run,
      plugins,
      sessions,
      notes,
      prompts,
      ds,
      display,
      latex,
      steer,
      tasks: seededTasks,
      session: sessionHooks,
    }) {
      let sdk: ClaudeSdk;
      try {
        sdk = await loadSdk();
      } catch {
        throw new ProviderUnavailableError(
          "Claude Agent SDK is unavailable; install and configure Claude Code before retrying",
        );
      }
      // The Claude SDK spawns its CLI in a directory; a session with none is a
      // routing mistake and says so before anything starts. See `requireCwd`.
      const cwd = requireCwd(claimedCwd, "Claude Code");
      const sdkEffort = claudeEffort(effort);
      const userServers = claudeMcpServers(userMcpServers);
      const contextEnv = claudeContextEnvForModel(model);

      let finalText = "";
      let receivedPartialText = false;
      let reportedSessionId: string | undefined;
      let usage: UsageSnapshot | undefined;
      let completed = false;
      /**
       * The context meter's two halves, tracked run-scoped: `contextUsed` from
       * the newest assistant message (see `contextUsedFrom`), `contextMax`
       * from each result's `modelUsage` — a constant per model, carried
       * forward because a slash-command result can arrive with an empty table.
       */
      let contextUsed: number | undefined;
      let contextMax: number | undefined = selectedContextMaxFromModel(model);
      /** The newest main-loop assistant envelope's raw `usage`, kept so the
       *  response's closing `message_delta` can correct its placeholder
       *  output count rather than replace the whole record. */
      let lastEnvelopeUsage: unknown;
      const decorateUsage = (snapshot: UsageSnapshot | undefined): UsageSnapshot | undefined =>
        snapshot === undefined
          ? undefined
          : {
              ...snapshot,
              ...(contextUsed === undefined ? {} : { contextUsed }),
              ...(contextMax === undefined ? {} : { contextMax }),
            };
      /** The open "Retrying…" / "Rate limit reached" row, while the provider
       *  has the turn standing still. Closed by the next frame of any kind. */
      let waitItemId: string | undefined;
      const closeProviderWait = (): void => {
        if (!waitItemId) return;
        emit({ kind: "item.completed", itemId: waitItemId, status: "completed" });
        waitItemId = undefined;
      };
      /**
       * THE SILENCE WATCH — a request that is out and has not answered (#263).
       *
       * A TIMER RATHER THAN A CHECK IN THE LOOP, because the loop is exactly
       * what a stall stops: the pump is parked on `takeStep` awaiting a frame
       * that never comes, so nothing inside it runs to notice. `emit` and
       * `flush` are already called from a timer (see `flushSoon`), so the row
       * reaches the sink the same way a delta does.
       *
       * Armed by `requesting`, disarmed by our own main loop speaking again. If
       * it fires first it opens the standing wait row, which the same frame
       * then closes through `closeProviderWait` — one row with a beginning and
       * an end, never a marker floating in silence.
       */
      /**
       * THE END-TURN GRACE (#465): set when our main loop's assistant envelope
       * says `end_turn` with no top-level tool still open — the model is done
       * and only the CLI's `result` is owed. Cleared by any later frame of
       * ours. While it stands, the pump's read is raced against it; if the
       * grace wins, the turn settles here with a warning row instead of
       * waiting forever on a `result` that measurably does not always come.
       */
      let endTurnSeenAt: number | undefined;
      let silenceTimer: ReturnType<typeof setTimeout> | undefined;
      const disarmProviderSilence = (): void => {
        if (silenceTimer === undefined) return;
        clearTimeout(silenceTimer);
        silenceTimer = undefined;
      };
      const armProviderSilence = (): void => {
        disarmProviderSilence();
        const sentAt = Date.now();
        silenceTimer = setTimeout(() => {
          silenceTimer = undefined;
          // A retry or a rejected limit is already holding a row open about
          // this same silence, and it has the provider's own account of it.
          // Two rows for one wait would be the engine arguing with the SDK.
          if (waitItemId) return;
          const id = itemId();
          const wait: ProviderWaitDetail = { kind: "no_response", waitedMs: Date.now() - sentAt };
          const detail: ItemDetail = { type: "provider_wait", wait };
          emit({ kind: "item.started", item: { id, detail, title: titleForProviderWait(wait) } });
          waitItemId = id;
          void flush().catch(() => undefined);
        }, providerSilenceMs);
        silenceTimer.unref?.();
      };
      /**
       * THE LAST REJECTED LIMIT THAT IS STILL STANDING — the evidence that, if
       * this turn now ends without succeeding, it ended because of a limit.
       *
       * SET only by a `rejected` rate-limit frame that named a reset time: a
       * warning is not a rejection, and a rejection with no reset time gives
       * the engine nothing to schedule, so both leave this alone and the turn
       * fails the ordinary way.
       *
       * CLEARED WHEN OUR OWN MAIN LOOP SPEAKS AGAIN, and only then. That frame
       * is proof the request went through — the limit was survived, and a
       * failure arriving later is a different failure that must not be dressed
       * up as a wait. Deliberately NOT cleared when a new wait row opens over
       * it: an `api_retry` that follows a rejected limit is the same limit
       * still biting.
       */
      let standingLimit: { resumeAt: number; limitType?: ProviderWaitDetail["limitType"] } | undefined;
      /** The open "Compacting context" row, when the provider announced one. */
      let compactionItemId: string | undefined;
      /** `compact_result: "success"` seen; the row waits for its boundary. */
      let compactionSucceeded = false;
      /** The open row's `compact_boundary` (the numbers) has arrived. */
      let compactionMeasured = false;

      /**
       * Streaming blocks keyed by the provider's content-block index.
       *
       * `text` ACCUMULATES, and that is not redundant with the deltas already
       * sent. Deltas are appends the engine journals but deliberately does NOT
       * fold into `items.json` — rewriting the whole projection per token would
       * be absurd — so the closing `item.completed` is the ONLY chance to give
       * the stored item its final text. Without it a live client looked right
       * (it folds deltas itself) while a client OPENING the session later got
       * empty reasoning and empty assistant messages from the snapshot. Found
       * by running it, not by a test; the test now exists.
       */
      const openBlocks = new Map<string, { id: string; kind: "text" | "thinking"; text: string }>();

      const closeBlock = (block: { id: string; kind: "text" | "thinking"; text: string }): TurnObservation => ({
        kind: "item.completed",
        itemId: block.id,
        status: "completed",
        detail: block.kind === "text" ? { type: "assistant_message", text: block.text } : { type: "reasoning", text: block.text },
      });
      /** Tool rows keyed by `tool_use_id`, so a later `tool_result` closes the
       *  row its call opened rather than opening a second one. */
      const openTools = new Map<string, { id: string; detail: ItemDetail }>();
      /**
       * The MAIN LOOP'S tool calls whose `tool_result` has not arrived yet — a
       * subset of `openTools` (which also tracks sub-agent tools). Kept apart
       * because this set is an END-OF-TURN signal: a `result` that arrives
       * while it is non-empty and states no stop reason is the CLI pausing
       * around in-flight tool work, not the turn ending (see the result arm).
       * Sub-agent tools must not hold the turn — a backgrounded agent's rows
       * legitimately outlive it.
       */
      const openTopLevelTools = new Set<string>();

      /**
       * Sub-agents, keyed by the SDK's own `task_id`.
       *
       * THE CONTRACT ID IS DERIVED FROM `tool_use_id` WHEN THERE IS ONE, not
       * from `task_id`, and that is what makes filing work without a lookup:
       * every message produced inside a sub-agent carries `parent_tool_use_id`
       * — the id of the `Task` call that launched it — so an item can name its
       * task from the message alone. `task_updated` is the one SDK message that
       * carries `task_id` and no `tool_use_id`, which is the only reason this
       * map exists.
       */
      /** The turn's single plan row, once TodoWrite has opened one. */
      let planItemId: string | undefined;

      /**
       * THE PROCESS'S TASK MEMORY, NOT THE TURN'S. Assigned once the runtime
       * is claimed or built below; declared here because `emitTask` and the
       * warp sink close over it. Held on the runtime because a task launched
       * in one turn reports in a later one under its SDK id alone — see
       * `TaskMemory` in ./claude-runtime.ts for the measured ghost rows.
       */
      let taskIdsBySdkId: Map<string, string> = new Map();
      /** Last seed per task, so `task_updated`'s PATCH can be folded onto
       *  something rather than sent as a task with no title or kind. */
      let knownTasks: Map<string, TaskSeed> = new Map();
      /** The SDK's `task_type` per task id — see `TaskMemory.typesBySdkId`. */
      let taskTypesBySdkId: Map<string, string> = new Map();
      /** SDK task ids that are not rows: `ambient` housekeeping, and shells
       *  that block their turn (`isForegroundShell`). Remembered, so the
       *  progress/notification edges of the same task cannot re-create the row
       *  through `emitTask`'s fold-or-invent path. A foreground shell leaves
       *  the set the moment the CLI backgrounds it (Ctrl+B). On the runtime's
       *  memory like the rows — see `TaskMemory`. */
      let suppressedTasks: Set<string> = new Set();
      /** The turn the pump is reading is one the CLI started on its own (a
       *  background task's wake-up), not this engine turn — see the
       *  `message_start` check in the loop. Its rows are filed under the task
       *  that fired it; its result ends nothing. */
      let foreignTurn: { taskId: string | undefined } | undefined;
      /** Our reply's first frame has arrived (`user_message_uuid` = ours).
       *  Until then a sender-less turn is not ours; after, it is. */
      let ownTurnOpen = false;
      /**
       * Background work this turn knows about that has not ended — the shells,
       * monitors and detached agents still alive inside the process.
       *
       * READ FROM THE ROWS, NOT COUNTED FROM `background_tasks_changed`. The
       * rows are already the fold of every frame that spoke about a task (see
       * `emitTask`), so a shell whose ending arrived as a notification rather
       * than as a membership change is correctly absent here; counting the
       * level signal instead would be a second, worse copy of state the fold
       * already holds.
       */
      const liveBackgroundTasks = (): Array<TaskSeed & { id: string }> =>
        [...knownTasks.entries()].flatMap(([id, task]) =>
          isBackgroundWork(task) && !isTerminalTaskState(task.state) ? [{ ...task, id }] : [],
        );

      /**
       * THE PROCESS IS GONE, AND SO IS EVERYTHING THAT WAS RUNNING INSIDE IT.
       *
       * Background work is the one thing the turn-end sweep deliberately leaves
       * alone, because outliving its turn is exactly what backgrounding means —
       * it keeps running in the live process and reports through the next
       * turn's pump. That reasoning holds only WHILE THE PROCESS LIVES. When
       * the CLI exits (a crash, a quit, the owner restarting Telar) those
       * shells and monitors die with it, and a row left at `running` is then a
       * claim about a process that no longer exists: `livenessOf` reads task
       * state, so the session reports itself as still monitoring for ever, with
       * no live stream left to correct it and nothing a human can stop.
       *
       * MEASURED AS THE TAIL OF #465 — five task ids (b3053dry9, bzzuxuedf,
       * b25tzicb4, brheodr3w, bdj7jqyvf) that the NEXT session learned about
       * only second-hand, as the model's own "didn't finish before the previous
       * session ended". The rows close as `stopped` (the work was ended by
       * something outside it, which is what `stopped` means) and the COUNT goes
       * on the journal, so the loss is stated when it happens rather than
       * inferred an hour later from a model's aside.
       *
       * EMITTED WHOLE RATHER THAN THROUGH `emitTask`, exactly as the turn-end
       * sweep does: the row is already in hand, and `emitTask` would re-derive
       * its id from an SDK task id that a row minted off a `tool_use` alone
       * does not have — `taskIdFor(undefined, undefined)` invents one, which is
       * a ghost row for a task the store already holds. Folding the ending back
       * into `knownTasks` is what makes a second call (the stream ending and
       * then throwing) say nothing the second time.
       */
      const reportLostBackgroundWork = (): void => {
        const lost = liveBackgroundTasks();
        if (lost.length === 0) return;
        for (const task of lost) {
          const ended: TaskSeed = { ...task, state: "stopped", failure: "the provider process ended before this background task reported back" };
          knownTasks.set(task.id, ended);
          emit({ kind: "task.completed", task: ended });
        }
        emit({
          kind: "runtime.warning",
          message: `the Claude process ended with ${lost.length} background task${lost.length === 1 ? "" : "s"} still running; ${lost.length === 1 ? "it was" : "they were"} lost with it`,
        });
      };

      const taskIdFor = (sdkTaskId: string | undefined, toolUseId: string | undefined): string => {
        if (toolUseId) return `task_${toolUseId}`;
        if (sdkTaskId && taskIdsBySdkId.has(sdkTaskId)) return taskIdsBySdkId.get(sdkTaskId)!;
        // A task this process never launched and the store never told it
        // about: the SDK id is the only handle, and the row it mints is
        // anonymous. Named so the journal says which case produced it.
        return `task_${sdkTaskId ?? crypto.randomUUID().replaceAll("-", "")}`;
      };

      /**
       * WHERE OBSERVATIONS GO. A turn's own go to its `onObservations`; a
       * PROVIDER turn's (a wake-up the pump is reading) go to the binding the
       * engine opened for it; and task frames read BETWEEN turns go to the
       * session's `onTasks`. Swapped by the pump, read by `emit`/`flush`.
       */
      let sink: (observations: TurnObservation[]) => Promise<void> = onObservations;

      /** Fold a partial report onto what this task was last known to be, then
       *  emit it whole — the repetition ./tasks.ts requires of every event. */
      const emitTask = (
        kind: "task.started" | "task.progress" | "task.completed",
        sdkTaskId: string | undefined,
        patch: Partial<TaskSeed> & { state: TaskState },
        toolUseId?: string,
        message?: string,
      ): void => {
        const id = taskIdFor(sdkTaskId, toolUseId);
        if (sdkTaskId) taskIdsBySdkId.set(sdkTaskId, id);
        const known = knownTasks.get(id);
        const statedKind = sdkTaskId ? taskKindForTypeOrUndefined(taskTypesBySdkId.get(sdkTaskId)) : undefined;
        /**
         * THE FIRST ENDING IS THE ENDING. A task that has finished never changes
         * state again; later reports may still add to it.
         *
         * The SDK keeps talking about a task after it ends — a notification
         * carrying the summary, a progress line that arrives out of order — and
         * each of those carries a state this fold would otherwise apply.
         * Measured on a real turn: `task_updated{status: killed}` followed by a
         * status-less `task_notification` put a stopped task back to `running`,
         * where it read as still working with nothing left in the stream that
         * could correct it.
         *
         * NOT "THE MOST SPECIFIC WINS", which was the first shape of this and is
         * subtly worse: the notification above says only "here is the summary",
         * so its ending is INFERRED, and letting it through rewrote an explicit
         * `killed` as `completed` — losing the one fact the SDK had actually
         * stated. Everything else on the patch is still folded in, so the
         * summary and the usage arrive either way.
         */
        const state = known && isTerminalTaskState(known.state) ? known.state : patch.state;
        const task: TaskSeed = {
          ...known,
          ...patch,
          id,
          // PRECEDENCE: what the frame says, then what the SDK ever STATED
          // about this task, then what we last held, then the default. The
          // stated type outranks `known.kind` because that may itself be a
          // default this fold wrote before the type was ever announced.
          kind: patch.kind ?? statedKind ?? known?.kind ?? "agent",
          state,
          ...(sdkTaskId ? { providerTaskId: sdkTaskId } : {}),
        };
        knownTasks.set(id, task);
        // The EVENT follows the state, not the message that carried it: a
        // notification about an already-finished task must not be announced as
        // progress, and a resurrection blocked above must not be announced at
        // all as a completion of something that already completed.
        const settled = isTerminalTaskState(state);
        const announced = kind === "task.started" ? kind : settled ? "task.completed" : "task.progress";
        emit(announced === "task.progress" ? { kind: announced, task, ...(message ? { message } : {}) } : { kind: announced, task });
      };

      /** A sub-agent's usage, in the contract's shape. The SDK reports one
       *  total rather than an input/output split, and inventing a split would
       *  be a fabricated number — it is carried as output, which is the field a
       *  cost roll-up sums. */
      const taskUsage = (value: unknown): UsageSnapshot | undefined => {
        const usage = asRecord(value);
        if (typeof usage.total_tokens !== "number") return undefined;
        return { tokens: { input: 0, output: usage.total_tokens, cacheRead: 0, cacheCreate: 0 } };
      };

      /** The frame shape both pumps read; declared once so `handleTaskFrame`
       *  and the turn loop agree on it. */
      type SdkFrame = {
        type?: string;
        subtype?: string;
        session_id?: string;
        total_cost_usd?: number;
        usage?: unknown;
        /** Result messages only: per-model usage, where `contextWindow`
         *  lives. Tokens in it are cumulative — see `contextMaxFrom`. */
        modelUsage?: unknown;
        compact_result?: string;
        compact_metadata?: unknown;
        message?: { content?: unknown[]; usage?: unknown; stop_reason?: string | null };
        /** The tool's full structured Output — where `structuredPatch` lives. */
        tool_use_result?: unknown;
        /** Set on everything a sub-agent produced: the id of the `Task`
         *  call that launched it. `null` on the main loop's own messages. */
        parent_tool_use_id?: string | null;
        /** Result messages: the final assistant message's stop reason.
         *  `"tool_use"` means the model stopped to run tools and will
         *  continue after their results — the turn is NOT over. Absent on
         *  older producers and the fake SDKs. */
        stop_reason?: string | null;
        /** Result messages: the CLI's own verdict on the turn, which does
         *  NOT always agree with `subtype`. Its safeguards report
         *  `subtype: "success"` with this true — see the two result guards
         *  below, which read both rather than the subtype alone (#779). */
        is_error?: boolean;
        /** The join key of the send this frame answers — see `turnUuid`. On
         *  the first stream frame and the result of a turn only. */
        user_message_uuid?: string;
        /** Set on a turn the CLI started by ITSELF (a background task's
         *  notification, an auto-continuation); absent on a human send. */
        origin?: { kind?: string };
        task_id?: string;
        tool_use_id?: string;
        description?: string;
        subagent_type?: string;
        task_type?: string;
        is_backgrounded?: boolean;
        workflow_name?: string;
        summary?: string;
        status?: string;
        /** `task_started` only: housekeeping the CLI does not surface as
         *  user work — the SDK says to exclude it from activity. */
        ambient?: boolean;
        /** `background_tasks_changed` only: every live background task
         *  after the change, with REPLACE semantics. */
        tasks?: unknown;
        /** `api_retry` only: the request failed retryably and the SDK is
         *  about to sleep `retry_delay_ms` before attempt `attempt`. */
        attempt?: number;
        max_retries?: number;
        retry_delay_ms?: number;
        /** `null` for a connection error that never got a response. */
        error_status?: number | null;
        /** `rate_limit_event` only: the account's limit state. */
        rate_limit_info?: unknown;
        /** Result messages: whitelisted lifecycle scalars, for the gated
         *  diagnostic line. Never journalled. */
        duration_ms?: number;
        duration_api_ms?: number;
        ttft_ms?: number;
        num_turns?: number;
        patch?: { status?: string; description?: string; error?: string; is_backgrounded?: boolean };
        event?: {
          type?: string;
          index?: number;
          content_block?: { type?: string };
          delta?: { type?: string; text?: string; thinking?: string };
          /** `message_delta` only: the response's FINAL output token count.
           *  Every earlier report of it is a placeholder — see the pump. */
          usage?: unknown;
        };
      };

      /**
       * The five task frames, folded into rows. Returns true when the frame
       * was one of them (handled, whether or not it emitted). Shared by the
       * turn pump and the idle pump: a `task_notification` means the same
       * thing whichever of them reads it, and the idle pump is the one that
       * hears a monitor's ending when it happens rather than at the next
       * human message.
       */
      const handleTaskFrame = async (item: SdkFrame): Promise<boolean> => {
        if (item.type !== "system") return false;
        /**
         * THE LAST TASK THAT SPOKE names the wake-up that follows. Measured:
         * a Monitor's tick is a `task_progress`, not a notification, and the
         * CLI wakes the model on it just the same — so remembering only
         * notifications left the tick's turn with no reason. Any frame about
         * a task that is (or becomes) a row counts; ambient and foreground
         * shells do not, they are not rows anybody can be woken by.
         */
        const spokeFor = str(item.task_id) && !suppressedTasks.has(item.task_id!) && item.ambient !== true
          ? taskIdFor(str(item.task_id), str(item.tool_use_id))
          : undefined;
        if (spokeFor && runtimeRef && item.subtype !== "background_tasks_changed" && !isForegroundShell(str(item.task_type), item.is_backgrounded)) {
          runtimeRef.tasks.lastWokenTaskId = spokeFor;
        }
        if (item.subtype === "task_started") {
          // Before the suppression branch: a blocking shell announces
          // `local_bash` and then earns no row, so this is the only place its
          // type is stated before Ctrl+B gives it one.
          if (str(item.task_id) && str(item.task_type)) taskTypesBySdkId.set(item.task_id!, item.task_type!);
          /**
           * AMBIENT TASKS ARE THE CLI'S HOUSEKEEPING, NOT WORK. The SDK marks
           * them itself and says what to do ("hosts should exclude them from
           * activity indicators"); surfaced as a row, an auto-started
           * live-update watcher would make `livenessOf` report the session
           * as monitoring over work no human asked for and none can stop.
           */
          if (item.ambient === true || isForegroundShell(str(item.task_type), item.is_backgrounded)) {
            if (str(item.task_id)) suppressedTasks.add(item.task_id!);
            return true;
          }
          emitTask(
            "task.started",
            str(item.task_id),
            {
              state: "running",
              kind: taskKindForType(str(item.task_type)),
              // Launched detached: it outlives this turn, whatever it is.
              ...(item.is_backgrounded === true ? { backgrounded: true } : {}),
              ...(str(item.description) ? { title: oneLine(item.description!) } : {}),
              ...(str(item.subagent_type) ? { role: item.subagent_type! } : {}),
              ...(str(item.workflow_name)
                ? { warp: { warpRunId: str(item.task_id) ?? "warp", warpName: item.workflow_name! } }
                : {}),
            },
            str(item.tool_use_id),
          );
          return true;
        }
        if (item.subtype === "task_progress") {
          if (str(item.task_id) && suppressedTasks.has(item.task_id!)) return true;
          /**
           * A PROGRESS DESCRIPTION DOES NOT RENAME THE TASK.
           *
           * Measured against the real SDK: `task_started` carried "Find
           * top-level .ts files non-recursively" and the progress messages
           * that followed carried "Running Find top-level .ts files
           * non-recursively". Taking the later one as the title makes a
           * roster row read as status prose, and makes it churn while the
           * agent runs. The start event names the task; progress reports on
           * it. A task that never announced a start still takes one, because
           * an ugly title beats an anonymous row.
           */
          const known = knownTasks.get(taskIdFor(str(item.task_id), str(item.tool_use_id)));
          emitTask(
            "task.progress",
            str(item.task_id),
            {
              state: "running",
              ...(!known?.title && str(item.description) ? { title: oneLine(item.description!) } : {}),
              ...(str(item.subagent_type) ? { role: item.subagent_type! } : {}),
              ...(taskUsage(item.usage) ? { usage: taskUsage(item.usage)! } : {}),
            },
            str(item.tool_use_id),
            str(item.summary),
          );
          return true;
        }
        if (item.subtype === "task_updated") {
          if (str(item.task_id) && suppressedTasks.has(item.task_id!)) {
            // Ctrl+B on a blocking shell: from here on it IS background work
            // and earns the row the never-announced branch below mints.
            if (item.patch?.is_backgrounded !== true) return true;
            suppressedTasks.delete(item.task_id!);
          }
          const status = str(item.patch?.status);
          const state = taskStateForStatus(status);
          const terminal = state === "completed" || state === "failed" || state === "stopped";
          /**
           * MOVED TO THE BACKGROUND MID-FLIGHT (Ctrl+B, or the SDK's own
           * decision). A task this turn already announced keeps its kind —
           * an agent sent to the background is still an agent — and only
           * gains `backgrounded`. A task NEVER announced is the foreground
           * Bash case: a blocking shell announces no `task_started` at all
           * and first appears here, so its only honest classification is
           * "a backgrounded shell".
           */
          const backgrounded = item.patch?.is_backgrounded === true;
          const known = knownTasks.has(taskIdFor(str(item.task_id), undefined));
          // `task_updated` states no `task_type`, and `is_backgrounded` is set
          // for `local_agent` AND `local_bash` — so it cannot name a kind. The
          // fold reads the type the SDK stated elsewhere.
          emitTask(
            terminal ? "task.completed" : "task.progress",
            str(item.task_id),
            {
              state,
              ...(str(item.patch?.description) ? { title: oneLine(item.patch!.description!) } : {}),
              ...(str(item.patch?.error) ? { failure: item.patch!.error! } : {}),
              ...(backgrounded ? { backgrounded: true } : {}),
            },
            undefined,
          );
          return true;
        }
        if (item.subtype === "task_notification") {
          if (str(item.task_id) && suppressedTasks.has(item.task_id!)) return true;
          const id = taskIdFor(str(item.task_id), str(item.tool_use_id));
          // Remembered on the PROCESS: the wake-up this notification triggers
          // may be read by the idle pump, or by the next turn's pump, and
          // either has to name the shell that spoke.
          emitTask(
            "task.completed",
            str(item.task_id),
            {
              // A NOTIFICATION IS AN ENDING. Its default is `completed` rather
              // than the shared `running`, because "the task is over and here
              // is what it produced" is the only thing this message means —
              // see `taskStateForStatus`.
              state: taskStateForStatus(str(item.status), "completed"),
              ...(str(item.summary) ? { resultText: item.summary! } : {}),
              ...(taskUsage(item.usage) ? { usage: taskUsage(item.usage)! } : {}),
            },
            str(item.tool_use_id),
          );
          return true;
        }
        if (item.subtype === "background_tasks_changed") {
          /**
           * THE LEVEL SIGNAL, CONSUMED BESIDE THE EDGE BOOKENDS. The SDK's
           * own doc on this message is the design brief: it carries EVERY
           * live background task after each membership change, with REPLACE
           * semantics, "so a missed bookend cannot wedge a stale running
           * indicator". That wedge is measured, not hypothetical: a Monitor
           * stream announced `task_started`, its ending edge never arrived,
           * and `tasks.json` kept it `running` — the session claimed to be
           * monitoring forever, and the only cure was a human pressing Stop.
           *
           * A task this process announced that is background work, not yet
           * settled, and ABSENT from the payload has therefore ended. It is
           * closed as `completed` with no failure and no resultText — the
           * notification that carried the summary may simply have been lost,
           * and inventing one would be fabrication. If that notification
           * limps in later anyway, `emitTask`'s "first ending is the ending"
           * keeps the state and still folds the summary in.
           *
           * ONLY background, and ONLY tasks whose SDK id THIS process minted
           * or was seeded with (`taskIdsBySdkId`): an agent missing from a
           * background-membership list means nothing — closing agents is the
           * turn-end sweep's job — and a warp's ids never appear in this
           * payload at all. The SDK says the level is per-process ("reset to
           * the empty set whenever the session's CLI process (re)starts"),
           * which is exactly the memory's lifetime.
           *
           * Membership is tested against ALL entries, ambient included: an
           * ambient entry never becomes a row, but treating its presence as
           * absence would close a real task the payload still lists.
           */
          const live = new Set(
            (Array.isArray(item.tasks) ? item.tasks : []).flatMap((raw) => {
              const entry = asRecord(raw);
              const id = str(entry.task_id);
              if (!id) return [];
              // The one frame that states `task_type` for a task this process
              // never announced. Remembered so the kind is read, not inferred
              // from `is_backgrounded` — set for sub-agents and shells alike.
              const taskType = str(entry.task_type);
              if (taskType) taskTypesBySdkId.set(id, taskType);
              return [id];
            }),
          );
          // LATE METADATA CORRECTS AN EARLIER GUESS: a row minted before any
          // frame stated its type carries a defaulted kind, and this payload is
          // the statement. Re-announced so it lands even if nothing else about
          // the task ever arrives. Live rows only — a settled one is history.
          for (const sdkId of live) {
            const rowId = taskIdsBySdkId.get(sdkId);
            const row = rowId ? knownTasks.get(rowId) : undefined;
            if (!row || isTerminalTaskState(row.state)) continue;
            const stated = taskKindForTypeOrUndefined(taskTypesBySdkId.get(sdkId));
            if (stated && stated !== row.kind) emitTask("task.progress", sdkId, { state: row.state, kind: stated });
          }
          for (const task of [...knownTasks.values()]) {
            if (task.kind !== "background" || isTerminalTaskState(task.state)) continue;
            const sdkId = task.providerTaskId;
            if (!sdkId || !taskIdsBySdkId.has(sdkId) || live.has(sdkId)) continue;
            emitTask("task.completed", sdkId, { state: "completed" });
          }
          return true;
        }
        return false;
      };
      /** The live runtime once claimed or built; `handleTaskFrame` writes the
       *  woken-task id to its memory. */
      let runtimeRef: ClaudeSessionRuntime<ClaudeTurnBindings, TaskSeed> | undefined;

      const pending: TurnObservation[] = [];
      /**
       * FLUSHES ARE SERIALISED, and that became load-bearing the moment a warp
       * could report.
       *
       * The main loop only ever ran `emit(); await flush();` in sequence, so
       * nothing overlapped and a plain async function was enough. A fan-out is
       * different in kind: four children settle whenever they settle, and none
       * of them can await the batch — the turn would be serialised behind its own
       * agents. Left unchained, two in-flight `onObservations` calls can resolve
       * in the opposite order to the one they were spliced in, and the engine
       * folds a `running` over a `completed` it has already stored. The task then
       * reads as live for ever, with nothing left in the stream to correct it.
       *
       * Same failure mode the browser socket's state queue avoids, for the
       * same reason; this generalises it to every observation.
       */
      let flushQueue: Promise<unknown> = Promise.resolve();
      /**
       * THE SINK `pending` WAS ACCUMULATED UNDER.
       *
       * This used to be read at flush time, on the grounds that `emit` and
       * `flush` were always adjacent so the two were the same sink. Streamed
       * deltas are no longer flushed adjacently (see `flushSoon`), and the pump
       * swaps the sink between frames — so the binding has to be taken when the
       * frames are produced, or a turn's buffered text could be posted to the
       * binding a wake-up opened after it.
       */
      let pendingSink: ((observations: TurnObservation[]) => Promise<void>) | undefined;
      let coalescing: ReturnType<typeof setTimeout> | undefined;
      const flush = (): Promise<void> => {
        if (coalescing !== undefined) {
          clearTimeout(coalescing);
          coalescing = undefined;
        }
        const target = pendingSink ?? sink;
        // Taken SYNCHRONOUSLY. A deferred flush runs from a timer, so anything
        // emitted between this call and the chain reaching it belongs to the
        // next batch — draining inside the callback would hand those frames to
        // the sink this call captured.
        const batch = pending.splice(0, pending.length);
        pendingSink = undefined;
        const next = flushQueue.then(async () => {
          if (batch.length === 0) return;
          await target(batch);
        });
        // The CHAIN must survive a rejection or every later flush inherits it;
        // the caller still sees the failure on the promise it was handed.
        flushQueue = next.catch(() => undefined);
        return next;
      };
      /**
       * A STREAMED DELTA COSTS A WHOLE ENGINE COMMAND, so it must not cost one
       * PER TOKEN-CHUNK. Measured: the real ingest path is 1.66 ms per delta
       * against a 327-item session — a transaction, a queue read and the item
       * projection's read and rewrite around a 261-byte insert — which at the
       * measured peak of 133 deltas/s is more than two cores. The same 400
       * deltas sixteen to a call are 0.096 ms each.
       *
       * 16 ms is a frame. Buffering streamed text for a frame does not defeat
       * streaming — the cockpit re-reads the tail once a second, and the phone
       * once a second — while a transaction per chunk does defeat the machine.
       * Any other observation flushes immediately and takes the buffered deltas
       * with it, in order, so nothing terminal ever waits on this timer.
       */
      const COALESCE_MS = 16;
      const flushSoon = (): void => {
        if (coalescing !== undefined) return;
        coalescing = setTimeout(() => {
          coalescing = undefined;
          void flush().catch(() => undefined);
        }, COALESCE_MS);
        coalescing.unref?.();
      };
      const emit = (observation: TurnObservation): void => {
        // The pump swapped sinks with frames still buffered: they belong to the
        // sink that produced them, so they go now rather than to the new one.
        if (pending.length > 0 && pendingSink !== sink) void flush().catch(() => undefined);
        const last = pending.at(-1);
        if (
          observation.kind === "content.delta" &&
          last?.kind === "content.delta" &&
          last.itemId === observation.itemId &&
          last.stream === observation.stream
        ) {
          // COALESCED PER ITEM, which is exactly what a reader does with them:
          // deltas for one open block are concatenated in order, so N of them
          // and one carrying the same text are the same transcript — and the
          // journal holds one row instead of N.
          pending[pending.length - 1] = { ...last, text: last.text + observation.text };
          return;
        }
        pending.push(observation);
        pendingSink ??= sink;
      };

      /**
       * The permission gate.
       *
       * IT MUST ALWAYS ANSWER. The SDK's own docs are blunt about the failure
       * mode: a permission prompt has no park deadline, so a callback that
       * throws or never settles blocks the tool indefinitely with nothing to
       * report it. Any failure here therefore becomes an explicit `deny`
       * carrying the reason, which is recoverable, rather than a hang.
       */
      /** The gate, built around whichever `onRequest` a turn carries — this
       *  turn's, or a provider turn's own (see the idle pump). */
      const gateFor = (onRequest: NonNullable<DriverRun["onRequest"]>): SdkCanUseTool =>
        async (toolName, input, options) => {
            // THE BROWSER SOCKET IS THE DECIDER for its own tools. The gate
            // bound to this turn's lease already asked the engine before the
            // call ran; answering again here would put two cards in front of
            // one click.
            if (parseToolName(toolName).server === TELAR_BROWSER_MCP_SERVER) return { behavior: "allow" };
            /**
             * `AskUserQuestion`, ANSWERED THROUGH THE PERMISSION CALLBACK.
             *
             * Measured against claude-cli 2.1.246 / SDK 0.3.224: the CLI's
             * dialog channel (`request_user_dialog`) is never emitted to this
             * SDK even with the kinds declared, so a question used to reach
             * the human NOWHERE — the tool reported "the user did not answer"
             * and, before that, killed the stream outright. What DOES work,
             * measured by running it: `allow` with `updatedInput` carrying an
             * `answers` map (question text → chosen label) completes the tool
             * with those answers. So the questions become the contract's own
             * `user_input` request — which no runtime mode auto-answers — and
             * the human's form answers ride back in `updatedInput`.
             */
            if (toolName === "AskUserQuestion") {
              const questions = Array.isArray(asRecord(input).questions)
                ? (asRecord(input).questions as unknown[]).map(asRecord)
                : [];
              const fields = questions.flatMap((question): UserInputField[] => {
                const text = str(question.question);
                if (!text) return [];
                const choices = Array.isArray(question.options)
                  ? question.options.map(asRecord).flatMap((option) => (str(option.label) ? [str(option.label)!] : []))
                  : [];
                // KEYED BY THE QUESTION TEXT — that is AskUserQuestionOutput's
                // own answer key. The label repeats it because the header is a
                // 12-character chip, not a sentence a human can answer.
                //
                // `multiSelect` is the tool's own flag for "pick several", and
                // it is carried rather than dropped: without it the form asks
                // for one answer to a question that offered many, and the
                // human's other picks have nowhere to go. Only set when TRUE,
                // so a single-select field stays exactly the shape it was.
                return [{
                  key: text,
                  label: text,
                  kind: "choice",
                  choices,
                  ...(question.multiSelect === true ? { multiple: true } : {}),
                  required: true,
                }];
              });
              if (fields.length > 0) {
                try {
                  const outcome = normalizeOutcome(
                    await onRequest({
                      kind: "user_input",
                      detail: { kind: "user_input", prompt: "The agent needs your input to continue.", fields },
                      toolUseId: options.toolUseID,
                    }),
                  );
                  if (outcome.decision === "cancel") {
                    return { behavior: "deny", message: "The human cancelled this turn.", interrupt: true };
                  }
                  if ((outcome.decision === "accept" || outcome.decision === "acceptForSession") && outcome.answers) {
                    const answers: Record<string, string> = {};
                    for (const field of fields) {
                      const value = outcome.answers[field.key];
                      if (value === undefined) continue;
                      if (!Array.isArray(value)) {
                        answers[field.key] = String(value);
                        continue;
                      }
                      // SEVERAL PICKS ARE STILL ONE ANSWER to this tool —
                      // `AskUserQuestionOutput` maps a question to a string,
                      // not to a list — so a multi-select's labels join.
                      //
                      // An array on a SINGLE-select field is a client bug, and
                      // the honest reading of it is the first pick. Joining
                      // would manufacture a multi-answer out of a question that
                      // never offered one, and the model would act on it.
                      if (field.multiple) answers[field.key] = value.join(", ");
                      else if (value.length > 0) answers[field.key] = String(value[0]);
                    }
                    return { behavior: "allow", updatedInput: { ...asRecord(input), answers } };
                  }
                } catch {
                  // Fall through: an unanswerable question is a DISMISSED one,
                  // never a hang — same rule as the generic arm below.
                }
                // Declined, or answered with nothing: the tool's own graceful
                // arm ("the user did not answer") beats a deny that reads as a
                // broken tool.
                return { behavior: "allow" };
              }
            }
            try {
              const { decision } = normalizeOutcome(
                await onRequest({
                  kind: requestKindForTool(toolName),
                  detail: requestDetailForToolCall(toolName, input),
                  toolUseId: options.toolUseID,
                }),
              );
              if (decision === "accept" || decision === "acceptForSession") return { behavior: "allow" };
              // `cancel` withdraws the whole turn rather than just this call.
              return {
                behavior: "deny",
                message: decision === "cancel" ? "The human cancelled this turn." : "The human declined this tool call.",
                ...(decision === "cancel" ? { interrupt: true } : {}),
              };
            } catch (error) {
              return { behavior: "deny", message: error instanceof Error ? error.message : "permission request failed" };
            }
          };
      const canUseTool: SdkCanUseTool | undefined = onRequest ? gateFor(onRequest) : undefined;

      /**
       * THE KEY IS WHAT NAMES THE SERVER, not `createSdkMcpServer`'s `name`.
       *
       * Measured, by running it: with `createSdkMcpServer({ name: "telar" })`
       * but this key left as `browser`, the model still saw
       * `mcp__browser__browser_navigate` and every call landed back in the
       * generic `mcp_tool_call` arm. The title read correctly the whole time,
       * which is exactly why a passing unit test on `itemDetailForToolCall` did
       * not catch it — the mapping was right and the input to it was wrong.
       */
      /**
       * A warp row, announced as the right KIND of event.
       *
       * The runner emits whole seeds and knows nothing about the three event
       * kinds; this is the only party that knows what it has already told the
       * engine, so it is the one that can tell a start from a progress. Folded
       * into `knownTasks` as well, which buys the end-of-turn sweep below for
       * free: an agent somehow left running when the turn ends gets closed
       * rather than claiming the session is still working forever.
       */
      const announced = new Set<string>();
      const onWarpTask = (seed: TaskSeed): void => {
        const settled = isTerminalTaskState(seed.state);
        const kind = !announced.has(seed.id) ? "task.started" : settled ? "task.completed" : "task.progress";
        announced.add(seed.id);
        knownTasks.set(seed.id, seed);
        emit({ kind, task: seed });
        /**
         * NOT AWAITED — a child cannot wait for the engine to acknowledge its
         * row without serialising the whole fan-out behind one HTTP round trip
         * each. Order is still guaranteed: `flush` chains, so these arrive in
         * the sequence they were emitted whatever order they settle in.
         *
         * The rejection is swallowed HERE rather than left unhandled. A batch of
         * task rows that could not be reported is a connectivity failure, and the
         * main loop's own next flush surfaces it as the turn's failure — which
         * is the right place for it, since that one can still stop the turn.
         */
        void flush().catch(() => undefined);
      };

      /**
       * TELAR'S IN-PROCESS TOOLS, IN ONE SERVER.
       *
       * THE BROWSER IS NOT HERE ANY MORE: it is served by the worker's own
       * `BrowserToolSocket` and registered below as an HTTP entry, the same
       * registration the Codex driver makes — one transport, both providers.
       * Its approval gate rides the socket's binding, which is why `canUseTool`
       * above waves its calls through.
       */
      const onSteered = (message: SteerMessage) => {
        const id = itemId();
        const attachments = message.attachments ?? [];
        emit({
          kind: "item.started",
          item: {
            id,
            /**
             * A NOTIFICATION IS ITS OWN ROW, MID-TURN AS WELL — #550.
             *
             * The engine writes this row itself when the notification opens a
             * turn of its own; a message steered into a RUNNING turn belongs on
             * that turn's timeline, in the order the provider received it, so
             * the seam that hands it over is the only party that can write it.
             * Same detail either way, so the transcript cannot tell whether the
             * recipient happened to be busy — which is the asymmetry being
             * closed.
             */
            detail: message.notification
              ? { type: "notification", notification: message.notification }
              : {
                  type: "user_message",
                  text: message.text,
                  ...(attachments.length > 0 ? { attachments } : {}),
                  ...(message.sender ? { sender: message.sender } : {}),
                  // The row keeps the BODY in `text` and the engine's notice beside
                  // it, so the transcript can collapse to the one line the model
                  // was handed and still expand to everything the peer sent.
                  ...(message.notice ? { notice: message.notice } : {}),
                  // WHO SAID IT SURVIVES THE ROW. A wake steered into a running
                  // turn used to land here bare and draw as the person's bubble.
                  ...(message.wakeReason ? { wakeReason: message.wakeReason } : {}),
                },
            title: steerRowTitle(message),
          },
        });
        emit({ kind: "item.completed", itemId: id, status: "completed" });
      };

      /**
       * A WARP CHILD IS A REAL `claude` PROCESS, spawned with this turn's own
       * checkout, login and binary — so a warp inherits everything the session
       * was configured with rather than a default the driver invents.
       *
       * `mcpServers` is the USER's only: Telar's own server is withheld, or a
       * child could call `warp` and recurse without bound, and four children
       * would fight over one browser scope. `canUseTool` is passed, because a
       * session that asks before editing asks for a child's edits too.
       *
       * BUILT PER TURN, REACHED THROUGH THE BINDINGS: the `warp` tool itself
       * is registered once per session runtime, but a spawn must carry THIS
       * turn's model and permission gate, not the first turn's.
       */
      const executable = resolveExecutable(binaryPath);
      const warpSpawn = createWarpSpawn({
        sdk,
        cwd,
        ...(model ? { model } : {}),
        ...(sdkEffort ? { effort: sdkEffort } : {}),
        ...(fastMode === undefined ? {} : { fastMode }),
        ...(env ? { env } : {}),
        ...(userServers ? { mcpServers: userServers } : {}),
        ...(canUseTool ? { canUseTool } : {}),
        ...(executable ? { executable } : {}),
      });

      /** This turn's half of the runtime, swapped in whole below whether the
       *  runtime is fresh or reused — see `ClaudeTurnBindings`. */
      const turnBindings: ClaudeTurnBindings = {
        signal,
        canUseTool,
        sessions,
        notes,
        prompts,
        ds,
        display,
        latex,
        run,
        plugins,
        warpSpawn,
        onWarpTask,
      };

      const streaming = claudeStreamingInputEnabled();

      /**
       * WHAT THIS SESSION IS TOLD ABOUT ITS OWN SURFACES, one paragraph per
       * capability it actually has. Each is gated on the capability being
       * bound rather than appended always: a session with no browser told how
       * to drive tabs, or a project-less one told to save a run
       * configuration, spends a turn discovering the tool is not there.
       * Baked in at query creation, so the fingerprint below carries `run`
       * for the same reason it carries `browser`.
       */
      /**
       * THE ORIENTATION GOES FIRST, and it is the one paragraph here that is
       * not gated on a capability: where the agent is is true of every session,
       * with a browser or without one. It is gated on the PERSON instead — the
       * engine resolves `AgentOrientation.preamble` at claim time and sends the
       * words or nothing (see ./orientation.ts). First because it teaches the
       * vocabulary the briefings under it are written in: "this session's
       * integrated browser" lands differently once "the browser" has a
       * referent.
       *
       * ONCE PER TURN, NOT ONCE PER MESSAGE. `briefings` is baked into the
       * query at creation and carried in the fingerprint below, so a reused
       * runtime keeps the paragraph it started with rather than accumulating
       * one per turn — and a session whose orientation was switched off
       * mid-conversation cold-starts, which is exactly what "off means nothing
       * Telar-authored is injected" requires.
       */
      /**
       * THEN WHAT THIS SESSION IS FOR, if this machine has named it Main. Gated
       * on the SESSION rather than on a capability or a person, and resolved at
       * claim time like the paragraph above it — so switching Main off takes
       * effect on the next turn, and the fingerprint below carries it for the
       * same reason it carries `orientation`. Before the capability briefings
       * because it says what this conversation is, not how to drive a tool.
       */
      const briefings = [
        ...(orientation ? [orientation] : []),
        ...(mainBriefing ? [mainBriefing] : []),
        ...(browserSocket ? [BROWSER_BRIEFING] : []),
        ...(run ? [RUN_BRIEFING] : []),
      ];

      /**
       * EVERYTHING THE QUERY BAKES IN AT CREATION. A turn whose fingerprint
       * differs from the live runtime's cannot reuse it — the options below
       * are fixed for the life of the process — so the store destroys the old
       * one and this turn cold-starts. `model` is deliberately absent: it is
       * the one knob a live query can turn (`setModel`).
       */
      /**
       * THE `telar` WALL, WHEN THIS DEPLOYMENT HOSTS ONE. Each part names a
       * toolkit, its own builder, and a GETTER for the capability this turn
       * bound; the getters read through `ref`, which `buildRuntime` points at
       * the live bindings, so one stable lease serves every turn of a session
       * while still dispatching to the current one.
       */
      const telarLeased = telarSocket ? telarLeases.get(sessionId) : undefined;
      const telarRef = telarLeased?.ref ?? { current: undefined as RuntimeBindings<ClaudeTurnBindings> | undefined };
      const telarParts: TelarWallPart[] = [
        { name: "sessions", build: sessionsTools as never, capability: () => telarRef.current?.current.sessions },
        { name: "notes", build: notesTools as never, capability: () => telarRef.current?.current.notes },
        { name: "prompts", build: promptsTools as never, capability: () => telarRef.current?.current.prompts },
        { name: "ds", build: dsTools as never, capability: () => telarRef.current?.current.ds },
        { name: "notebook", build: notebookTools as never, capability: () => telarRef.current?.current.ds },
        { name: "latex", build: latexTools as never, capability: () => telarRef.current?.current.latex },
        { name: "display", build: displayTools as never, capability: () => telarRef.current?.current.display },
        { name: "run", build: runTools as never, capability: () => telarRef.current?.current.run },
        /**
         * EVERY PLUGIN'S WALL, on the same key. One entry per registered module
         * rather than a second socket: a plugin tool must have one qualified
         * name, and a `telar-plugins` server beside `telar` would give it two.
         */
        ...pluginToolModules().map((module) => ({
          name: `plugin:${module.meta.id}`,
          build: ((tool: ToolFactory, capability: never) => module.tools(tool, capability) as unknown[]) as never,
          capability: () => telarRef.current?.current.plugins?.[module.meta.id],
        })),
      ];
      let telarLease = telarLeased?.lease;
      if (telarSocket && !telarLease) {
        telarLease = await telarSocket.bind(() => collectTelarWall(telarParts));
        if (telarLease) telarLeases.set(sessionId, { lease: telarLease, ref: telarRef });
      }

      const fingerprintFields: Record<string, unknown> = {
        cwd,
        /**
         * THE PATCH, NOT THE RESOLVED ENVIRONMENT, and with a deletion spelled
         * as one — see `canonicalEnvPatch`. `{}` and `{ KEY: undefined }` are
         * opposite instructions that `JSON.stringify` rendered identically.
         */
        env: canonicalEnvPatch(env, contextEnv),
        effort: sdkEffort ?? null,
        fastMode: fastMode ?? null,
        executable: executable ?? null,
        /**
         * ID AND SPEC ONLY, deduplicated and sorted — never the whole record.
         * Measured on the dev app: the auto-registered Computer Use server is
         * re-stamped (`createdAt`/`updatedAt`) on every turn, and hashing those
         * timestamps cold-started a new process per turn — killing the very
         * background work this runtime exists to keep alive. Only what shapes
         * the spawned process belongs here.
         */
        servers: canonicalServers(userMcpServers),
        browser: browserSocket ?? null,
        sessions: Boolean(sessions),
        // Same rule: the toolkits are baked into the query at creation, so a
        // project-less session gaining a project must cold-start rather than
        // keep advertising a wall it no longer lacks.
        notes: Boolean(notes),
        // Same rule again: the prompt wall is baked into the query at creation.
        prompts: Boolean(prompts),
        // Toggling the project's data-science switch must cold-start: the
        // toolkits are baked into the query at creation.
        ds: Boolean(ds),
        // Same rule for the LaTeX switch.
        latex: Boolean(latex),
        display: Boolean(display),
        /** Same rule, and here it is the system prompt rather than a toolkit:
         *  `RUN_BRIEFING` is appended at creation, so a project-less session
         *  that gains a project must cold-start to be told about it. */
        run: Boolean(run),
        /**
         * Same rule again, and the reason the toggle means anything mid-session:
         * the orientation is appended at creation, so switching it off must
         * cold-start rather than leave a live query still carrying the
         * paragraph. The TEXT, not a boolean — a reworded preamble is a
         * different system prompt.
         */
        orientation: orientation ?? null,
        /**
         * Same rule once more, and here it is what makes "disable removes the
         * briefing" true rather than aspirational: the paragraph is appended at
         * query creation, so a session that stops being Main must cold-start
         * rather than keep a live query that is still carrying it.
         */
        mainBriefing: mainBriefing ?? null,
        /**
         * THE `telar` WALL'S LEASE. A STABLE TOKEN IS NOT CATALOG COHERENCE:
         * re-collecting per request keeps dispatch honest server-side, but a
         * reused query keeps advertising the list it was started with. The
         * capability booleans around this cold-start the provider when the SET
         * changes; the generation covers a rebind of the lease itself.
         */
        telarSocket: telarLease ? `${telarLease.url}#${telarLease.generation}` : null,
        /**
         * THE ENABLED PLUGIN SET. The wall re-collects per request, so dispatch
         * is already honest — but a reused query keeps advertising the catalog
         * it was started with, so a plugin toggled on or off must cold-start it.
         * Sorted: a map's key order is not a decision anybody made.
         */
        plugins: Object.keys(plugins ?? {}).sort(),
        gate: Boolean(canUseTool),
        instance: providerInstanceId ?? null,
      };
      /** CANONICAL, not `JSON.stringify`: key order is not identity, and an
       *  explicit deletion is. See ./claude-identity.ts. */
      const fingerprint = canonicalJson(fingerprintFields);
      const fingerprintDigests = fieldDigests(fingerprintFields);

      /** The child's environment with the patch's deletions APPLIED, resolved
       *  once so the query options and the fingerprint cannot disagree. */
      const childEnv = resolveChildEnv(process.env, env, contextEnv);

      const buildRuntime = (): ClaudeSessionRuntime<ClaudeTurnBindings, TaskSeed> => {
        const bindings: RuntimeBindings<ClaudeTurnBindings> = { current: turnBindings };
        // The socket wall reads through this. A cold start replaces the bindings
        // object and the lease — deliberately outliving it — follows.
        telarRef.current = bindings;

        /** The permission gate the QUERY holds: a stable wrapper over the
         *  current turn's `canUseTool`, because the worker's gate is bound to
         *  a claim token that dies with each turn while the query lives on. */
        const gate: SdkCanUseTool | undefined = canUseTool
          ? (toolName, input, options) => {
              const current = bindings.current.canUseTool;
              if (!current) return Promise.resolve({ behavior: "allow" as const });
              return current(toolName, input, options);
            }
          : undefined;

        const telarTools: unknown[] = [];

        /**
         * THE SESSIONS TOOLKIT, WHEN THE TURN CARRIES ONE.
         *
         * NO APPROVAL GATE ON ANY OF THESE, the judgement every toolkit below
         * inherits: not one of them lands anything. Creating a session starts no
         * work (nothing is queued until `sessions_send`), reading and stopping
         * are read-and-brake, and there is deliberately no merge, no accept and
         * no archive for a gate to guard. The guard that matters here is
         * structural — the store's live-session budget — not interactive.
         *
         * THE ONE GATE THAT IS NOT HERE AT ALL is a warp child's. `warp/spawn.ts`
         * withholds Telar's whole MCP server from a child and names these tools
         * in `WARP_CHILD_DISALLOWED_TOOLS` on top of that, because
         * `sessions_create` is fan-out wearing another hat.
         */
        if (sessions && sdk.tool) telarTools.push(...sessionsTools(sdk.tool, delegatingCapability(() => bindings.current.sessions)));

        /**
         * THE PROJECT'S NOTEBOOK, WHEN THE TURN CARRIES ONE — so "what does the
         * deploy note say?" is answerable, and "keep this where we can find it"
         * lands somewhere the human will actually see it.
         *
         * NO APPROVAL GATE, the sessions toolkit's judgement again: nothing here
         * lands anything, and writing a note changes no branch and queues no turn. The
         * one guard that matters is the wall's own — `notes_delete` removes only
         * notes an agent wrote, and refuses the user's in a sentence.
         */
        if (notes && sdk.tool) telarTools.push(...notesTools(sdk.tool, delegatingCapability(() => bindings.current.notes)));

        /**
         * THE PROMPT SHELF, WHEN THE TURN CARRIES A PROJECT — so a turn can end
         * by drafting the turn that should follow it, and a prompt asked for as
         * a product lands where it can be sent rather than in a transcript.
         *
         * NO APPROVAL GATE, and here the reason is the tool's whole point rather
         * than a judgement about blast radius: `prompt_draft` LANDS NOTHING BY
         * CONSTRUCTION. It queues no turn and starts no work — the prompt sits
         * on the shelf until a person presses it, which is the human decision
         * the tool exists to preserve. Gating it would ask for consent to ask
         * for consent. The wall's own fence is the one that matters:
         * `prompt_drop` removes only what an agent wrote.
         */
        if (prompts && sdk.tool) telarTools.push(...promptsTools(sdk.tool, delegatingCapability(() => bindings.current.prompts)));

        /**
         * THE DATA-SCIENCE TOOLKITS, WHEN THE PROJECT OPTED IN. No approval
         * gate: a kernel runs in the session's own working directory under
         * the same permissions the agent's Bash tool already has, and every
         * write these do is to a notebook the file tools could write anyway.
         */
        if (ds && sdk.tool) {
          telarTools.push(...notebookTools(sdk.tool, delegatingCapability(() => bindings.current.ds)));
          telarTools.push(...dsTools(sdk.tool, delegatingCapability(() => bindings.current.ds)));
        }

        /**
         * THE LATEX TOOLKIT, WHEN THE PROJECT OPTED IN. No approval gate, the
         * data-science judgement again: a compile runs in the session's own
         * tree under the permissions Bash already has, and tlmgr writes to a
         * distribution the person configured for exactly this.
         */
        if (latex && sdk.tool) telarTools.push(...latexTools(sdk.tool, delegatingCapability(() => bindings.current.latex)));

        /**
         * THE DISPLAY TOOLKIT, WHEN THE TURN CARRIES ONE. No approval gate,
         * the same judgement again: opening a panel on a file the human
         * could open themselves commits nothing. The worker's capability owns
         * the one check that matters — the path stays inside this turn's own
         * checkout.
         */
        if (display && sdk.tool) telarTools.push(...displayTools(sdk.tool, delegatingCapability(() => bindings.current.display)));

        const warp = warpTool(sdk.tool, {
          // Both delegate through the bindings — the tool is registered once
          // per session runtime, the spawn and the task sink change per turn.
          spawn: (input) => bindings.current.warpSpawn(input),
          onTask: (seed) => bindings.current.onWarpTask(seed),
          ...(providerInstanceId ? { instanceId: providerInstanceId } : {}),
          signal: () => bindings.current.signal,
        });
        if (warp) telarTools.push(warp);

        /**
         * ONE `telar` REGISTRATION, FROM WHICHEVER TRANSPORT THIS DEPLOYMENT HAS.
         *
         * With a lease the key is the worker-hosted http entry and the
         * in-process server is NOT built — two servers under one key is a
         * shadowing bug, not a fallback. The socket is what lets these same
         * tools, under these same names, reach Codex and OpenCode; the
         * in-process path remains for a deployment with no socket.
         */
        const telarServer = telarLease
          ? {
              [TELAR_MCP_SERVER]: {
                type: "http" as const,
                url: telarLease.url,
                headers: { Authorization: `Bearer ${telarLease.token}` },
              },
            }
          : telarTools.length > 0 && sdk.createSdkMcpServer
            ? { [TELAR_MCP_SERVER]: sdk.createSdkMcpServer({ name: TELAR_MCP_SERVER, version: "2.0.0", tools: telarTools }) }
            : undefined;

        // The worker-hosted browser socket, in the SDK's own http shape — the
        // same entry `claudeMcpServers` builds for a user's http server. The
        // token rides a header; the URL is loopback and the credential is
        // per-SESSION (the worker keeps one binding per session so this
        // baked-in entry stays valid for the life of the runtime).
        const telarBrowserServer = browserSocket
          ? {
              [TELAR_BROWSER_MCP_SERVER]: {
                type: "http" as const,
                url: browserSocket.url,
                headers: { Authorization: `Bearer ${browserSocket.token}` },
              },
            }
          : undefined;

        /**
         * TELAR'S SERVERS AND THE USER'S, IN ONE RECORD — and Telar's are applied
         * LAST on purpose. The keys become the `mcp__<key>__<tool>` addressing
         * every client parses, so a user server called `telar` would shadow the
         * engine's own capabilities and route their approvals to the generic arm.
         * Losing a colliding user server is the better failure of the two, and it
         * is the one the naming standard in ./protocol/tools.ts already assumes.
         */
        const mcpServers =
          userServers || telarServer || telarBrowserServer
            ? { ...(userServers ?? {}), ...(telarBrowserServer ?? {}), ...(telarServer ?? {}) }
            : undefined;

        const feed = new MessageFeed();
        /** Ends the PROCESS, never a turn — aborted only by `destroy`. */
        const processController = new AbortController();
        const query = sdk.query({
          /**
           * THE INPUT STREAM IS THE SESSION'S LIFETIME. The feed's generator
           * parks between turns, which is exactly what keeps the CLI process
           * alive — the SDK reads a closed input stream as "the session is
           * over" and tears everything down, background work included. The
           * kill switch keeps the old one-shot forms.
           */
          prompt: streaming
            ? (feed.stream() as AsyncIterable<SdkUserMessage>)
            : // THE KILL-SWITCH PATH KEEPS THE SYSTEM WRAPPER even though it
              // cannot carry an origin: `sdk.query`'s non-streaming form takes
              // a bare string with nowhere to stamp provenance, so the content
              // half is the whole of what this path can say — and it is the
              // half that does not silently drop.
              (attachments?.length ?? 0) > 0 || notification
              ? singleUserMessage(claudeInitialContent(notification ? claudeNotificationContent(prompt, notification) : prompt, attachments ?? []))
              : prompt,
          options: {
            cwd,
            permissionMode: "default",
            ...(briefings.length
              ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: briefings.join("\n\n") } }
              : {}),
            abortController: processController,
            includePartialMessages: true,
            forwardSubagentText: true,
            // Spare background tasks on a turn Stop, and get `stopTask` for the
            // per-task control the UI's "N tasks still working" chip needs.
            perTaskStopAffordance: true,
            ...(model ? { model } : {}),
            ...(sdkEffort ? { effort: sdkEffort } : {}),
            // Absent unless asked for: a settings override is a request for
            // non-default behaviour, and inventing one would make every session
            // inherit a choice nobody made.
            ...(fastMode === undefined ? {} : { settings: { fastMode } }),
            // COLD START ONLY. Continuity between turns is now the live
            // process's own; `resume` is what a NEW process uses to pick up a
            // conversation an old one carried.
            ...(providerSessionId ? { resume: providerSessionId } : {}),
            ...(gate ? { canUseTool: gate } : {}),
            ...(mcpServers ? { mcpServers } : {}),
            // WHOLE, NOT A PATCH, because that is what the SDK's option means:
            // "when omitted the subprocess inherits process.env", so supplying
            // one replaces it. The patch is applied over the worker's own
            // environment here, which is where the child's PATH and HOME come
            // from — and a key patched to `undefined` is DELETED rather than
            // left present-but-undefined, which is how a configured instance
            // stops inheriting a credential. See `resolveChildEnv`.
            ...(childEnv ? { env: childEnv } : {}),
            // Part of the fingerprint: a CLI that upgraded itself between two
            // turns changes the resolved path, and the runtime is recreated.
            ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
          },
        }) as RuntimeQuery;

        // An EXPLICIT iterator, held for the runtime's life. `for await`
        // would call `.return()` on any break — the SDK's cue to shut the
        // process down, which is the exact teardown this store exists to
        // avoid. `.return()` is reserved for `destroy` below.
        const iterator = query[Symbol.asyncIterator]();

        return {
          sessionId,
          fingerprint,
          fingerprintDigests,
          feed,
          query,
          iterator,
          bindings,
          // Seeded from the store's live rows so a process built cold — after
          // a restart, an eviction, a config change — still files a shell's
          // notification on the row the store already has. Settled rows are
          // deliberately absent: nothing left to report on, and a stale
          // terminal seed would only tempt the level signal to re-close it.
          tasks: taskMemoryFrom((seededTasks ?? []).filter((seed) => !isTerminalTaskState(seed.state))),
          pendingStep: undefined,
          parked: [],
          idlePump: undefined,
          streamEnded: false,
          destroy: () => {
            feed.end();
            if (typeof query.close === "function") query.close();
            else processController.abort(new Error("the session runtime was destroyed"));
            // The one place `.return()` is allowed: it runs the generator's
            // own cleanup for implementations without `close` (fake SDKs).
            // Swallowed because a generator busy at a yield point rejects the
            // return and there is nobody left to care.
            void Promise.resolve()
              .then(() => iterator.return?.(undefined))
              .catch(() => undefined);
          },
          model,
          // A NEW PROCESS IS A NEW QUERY, so its running cost total starts
          // unknown — which is not the same as zero.
          costTotalUsd: undefined,
          busy: true,
          wakeActive: false,
          lastUsedAt: Date.now(),
          echoesUserMessageUuid: false,
        };
      };

      /**
       * THE RUNTIME: with streaming input, ONE LIVE QUERY PER SESSION — the
       * whole point of ./claude-runtime.ts. Background shells, monitors and
       * backgrounded sub-agents live inside that process, so a turn ending
       * must not end it. The kill switch restores a process per turn, at the
       * cost of send-now and of anything outliving its turn.
       */
      const persistent = streaming;
      /**
       * ONE PUMP PER SESSION, EVER. Measured (session_7657b2ef…, turns
       * 112–113): a stopped turn's pump can stay parked on the iterator for up
       * to the interrupt escalation (10 s). A turn claimed in that window
       * pushed its prompt into the SAME runtime, and the escalation then
       * destroyed the process under it — "Claude ended without a successful
       * result" four seconds after the user typed. Wait for the previous
       * turn to let go; a runtime destroyed meanwhile just cold-starts below.
       */
      if (persistent) await runtimes.idle(sessionId);
      /**
       * WHICH FIELD BROKE REUSE — read BEFORE the claim, because a mismatched
       * claim destroys the runtime whose identity the answer needs.
       *
       * NAMES AND DIGESTS ONLY. Its predecessor printed the whole fingerprint
       * string, which carries the login's env patch, the browser socket's
       * bearer token and every user MCP server's headers — so the one
       * diagnostic worth turning on during a live latency investigation was the
       * one that could not safely be turned on.
       */
      const outgoing = persistent ? runtimes.peek(sessionId)?.fingerprintDigests : undefined;
      let claimed = persistent ? runtimes.claim(sessionId, fingerprint) : undefined;
      if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
        const changed = outgoing ? changedFields(outgoing, fingerprintDigests) : [];
        console.error(
          `[claude-runtime] session=${sessionId} reuse=${Boolean(claimed)} identity=${fieldDigest(fingerprintFields)}` +
            (changed.length > 0 ? ` changed=${changed.join(",")}` : ""),
        );
      }
      if (claimed && claimed.model !== model) {
        // The one knob a live query can turn. A query that cannot (a fake
        // SDK, an older CLI) is replaced instead of patched.
        //
        // A WINDOW CHANGE IS NOT A MODEL SWITCH. `opus` → `opus[1m]` asks for
        // a different context size, and whether a live process honours the
        // suffix through `setModel` is not something this driver can verify
        // — so it is a cold start, where the id is baked into the query and
        // the provider's first result reports the window it actually got.
        const setModel = claudeWindowOf(claimed.model) === claudeWindowOf(model) ? claimed.query.setModel?.bind(claimed.query) : undefined;
        let switched = false;
        if (setModel) {
          try {
            await setModel(model);
            claimed.model = model;
            switched = true;
          } catch {
            switched = false;
          }
        }
        if (!switched) {
          runtimes.destroy(sessionId);
          claimed = undefined;
        }
      }
      const runtime = claimed ?? buildRuntime();
      if (persistent && !claimed) runtimes.adopt(runtime);
      runtime.bindings.current = turnBindings;
      runtimeRef = runtime;
      // From here on the turn reads and writes the PROCESS's task memory.
      taskIdsBySdkId = runtime.tasks.bySdkId;
      knownTasks = runtime.tasks.known;
      suppressedTasks = runtime.tasks.suppressed;
      taskTypesBySdkId = runtime.tasks.typesBySdkId;

      /**
       * THIS TURN'S JOIN KEY. The CLI echoes it as `user_message_uuid` on the
       * first stream frame of the reply and on the `result` that ends it — and
       * on nothing it starts by itself. That last part is what the pump below
       * needs: a background task finishing between turns wakes the model for a
       * turn of the CLI's own, whose frames sit buffered on the shared iterator
       * until the next engine turn pumps them out.
       */
      const turnUuid = crypto.randomUUID();
      if (persistent) {
        // The turn begins as one message pushed into the open stream. Stamped
        // as the person's only when it IS the person's — see `promptFromHuman`
        // on the contract, and `FeedMessage.origin` for why `human` is the only
        // kind the CLI keeps.
        runtime.feed.push({
          type: "user",
          message: {
            role: "user",
            // A NOTIFICATION IS NOT THE PROMPT, it is an announcement the turn
            // is being opened ON — so it goes in system-authored and stamped
            // with its real provenance, never as the person's words (#550).
            content: notification
              ? claudeInitialContent(claudeNotificationContent(prompt, notification), attachments ?? [])
              : claudeInitialContent(prompt, attachments ?? []),
          },
          parent_tool_use_id: null,
          uuid: turnUuid,
          ...(notification
            ? { origin: claudeNotificationOrigin(notification) }
            : promptFromHuman
              ? { origin: { kind: "human" as const } }
              : {}),
        });
      }

      /**
       * SEND NOW, DELIVERED THE MOMENT IT ARRIVES. The old shape drained the
       * mailbox at the turn's END — a delivery window of effectively zero,
       * which is why every steer silently degraded into a requeued turn. With
       * the stream open for the session there is nothing to wait for: the
       * text goes straight in, mid-turn, exactly as typing at a running
       * Claude Code does. After the turn's result the pump stops taking;
       * anything later is the engine sweep's to requeue.
       */
      let turnDone = false;
      /**
       * Interrupts issued to deliver a person's steer, still unanswered — one
       * token each, not a count.
       *
       * IDENTITY, BECAUSE THE TWO EVENTS RACE. The SDK writes the interrupt
       * receipt before the interrupted result on a clean cut, but a turn that
       * crashes during interrupt handling emits its error result on a direct
       * path that may PRECEDE the receipt (sdk.d.ts, SDKControlInterruptResponse).
       * So a result can consume a token before that same call settles; with a
       * counter a late rejection would then decrement someone else's arm and
       * drive it negative. A token can only ever remove itself.
       *
       * Consumed by the next result whatever its subtype — the CLI emits
       * exactly one result per turn — so a cut that raced a finishing answer
       * leaves nothing behind to swallow an unrelated failure later.
       */
      const outstandingSteerCuts = new Set<symbol>();
      const consumeSteerCut = (): boolean => {
        const [first] = outstandingSteerCuts;
        if (first === undefined) return false;
        outstandingSteerCuts.delete(first);
        return true;
      };
      /**
       * THE CALLS THE CUT KILLED ARE OVER — AND SAYING SO IS WHAT LETS THE TURN
       * EVER END AGAIN (#465).
       *
       * A steer is delivered by interrupting the CLI, which kills the in-flight
       * response. A `Bash` the model had just called therefore never produces a
       * `tool_result` — and `openTopLevelTools` only ever loses an id ON a
       * tool_result. Left alone, that id sits in the set for the rest of the
       * turn, with two consequences that compound: the end-turn grace above
       * never arms (it requires an empty set, because a genuinely open call is
       * exactly what a turn SHOULD wait for), and every later `result` whose
       * `stop_reason` is null or `tool_use` trips `toolsStillRunning` and keeps
       * the pump waiting. Nothing in the stream can ever clear it, so only a
       * human pressing Stop ends the turn.
       *
       * That matches the measured session exactly: after the first steer landed
       * at 05:56 UTC every turn ended as `turn.stopped` and not one as
       * `turn.completed`, and the single turn that did complete was the first
       * turn of a fresh process, before any steer.
       *
       * CLOSED AS FAILED, WITH THE REASON ON THE ROW, rather than silently
       * dropped: the call really did not finish, and a spinner left on the
       * transcript for the rest of the turn is the same lie told visually. The
       * sub-agent rows are deliberately left to the turn-end sweep — a
       * backgrounded agent's rows legitimately outlive the turn, and only the
       * top-level set is what gates the turn's ending.
       */
      const closeCutTools = (): void => {
        for (const useId of [...openTopLevelTools]) {
          openTopLevelTools.delete(useId);
          const open = openTools.get(useId);
          if (!open) continue;
          openTools.delete(useId);
          emit({ kind: "item.completed", itemId: open.id, status: "failed", detail: withToolResult(open.detail, "cut by a steer") });
        }
      };
      if (persistent && steer) {
        void (async () => {
          for (;;) {
            await steer.wake();
            if (turnDone) return;
            const queued = steer.drain();
            if (queued.length > 0) {
              // ONE ROW PER MESSAGE, ONE PUSH FOR THE BATCH. The transcript
              // keeps every message's own sender and attachments — a batch
              // of a person's words and an agent's used to draw as one agent
              // bubble holding both, with the attachments' ownership lost.
              // The provider still gets them as one interruption, in order,
              // each agent message individually framed and a person's bare.
              for (const message of queued) onSteered(message);
              const text = queued.map((message) => framedSteerText(message)).join("\n\n");
              const attachments = queued.flatMap((message) => message.attachments ?? []);
              /**
               * WHETHER A PERSON IS IN THIS BATCH — read BEFORE the push,
               * because the push now carries it and the interrupt below reads
               * the same answer. A batch that mixes a person's words with an
               * agent's is the person's: the reason to honour it — someone
               * typed, mid-turn — is present either way, and it is the same
               * reading the interrupt has always taken.
               */
              const typedByAPerson = queued.some((message) => message.sender === undefined && message.wakeReason === undefined);
              /**
               * A BATCH OF NOTIFICATIONS AND NOTHING ELSE IS A NOTIFICATION
               * (#550). Mixed with a person's words it is the person's — same
               * reading `typedByAPerson` already takes, and for the same reason:
               * someone typed, mid-turn, and that is what the turn should
               * honour. A batch that is ONLY notifications has no such claim on
               * the person's channel, so it goes system-authored and stamped
               * with the provenance of the first one in it.
               */
              const notifications = queued.map((message) => message.notification).filter((detail) => detail !== undefined);
              const allNotifications = !typedByAPerson && notifications.length === queued.length && notifications[0] !== undefined;
              runtime.feed.push({
                type: "user",
                message: { role: "user", content: claudeInitialContent(allNotifications ? claudeNotificationContent(text, notifications[0]!) : text, attachments) },
                parent_tool_use_id: null,
                ...(allNotifications
                  ? { origin: claudeNotificationOrigin(notifications[0]!) }
                  : typedByAPerson
                    ? { origin: { kind: "human" as const } }
                    : {}),
              });
              /**
               * PUSHING IS NOT INTERRUPTING: the provider reads no further input
               * while it generates, so a pushed message waits out the old answer.
               * Interrupt as Esc does — the generation stops, the process and
               * session survive. Ordered AFTER the push so the words are already
               * in the feed when the provider comes back for input.
               *
               * Only for words a PERSON typed: an agent report or engine wake is
               * a notice, not a change of direction.
               */
              if (typedByAPerson && runtime.query.interrupt) {
                // Armed BEFORE the await: the pump is concurrent and the result
                // can land first. Disarmed only if the call itself refuses, which
                // leaves the message queued — late rather than lost.
                const cut = Symbol("steer-cut");
                outstandingSteerCuts.add(cut);
                try {
                  await runtime.query.interrupt();
                } catch {
                  // Removes only ITS OWN arm, and only if a result has not
                  // already consumed it — a refused cut leaves the message
                  // queued, which is late rather than lost.
                  outstandingSteerCuts.delete(cut);
                }
              }
              await flush();
            }
            if (steer.isClosed) return;
          }
        })().catch(() => undefined);
      }

      /**
       * STOP ENDS THE TURN, NOT THE PROCESS. `interrupt()` is what pressing
       * Esc does in Claude Code: the current work stops, the process — and
       * everything backgrounded inside it — survives. The escalation below is
       * for an interrupt the CLI never answers: this worker runs one turn at
       * a time, so a pump parked forever would park the whole worker.
       */
      let streamEnded = false;
      let cancelReap: (() => void) | undefined;
      const onAbort = () => {
        if (!persistent) {
          runtime.destroy();
          return;
        }
        const interrupted = runtime.query.interrupt?.();
        if (!interrupted) {
          runtimes.destroy(sessionId);
          return;
        }
        interrupted.catch(() => runtimes.destroy(sessionId));
        // The grace is named and shared now — see STOP_REAP_GRACE_MS for what
        // it does and does not bound (#409).
        cancelReap = runtimes.reapAfter(sessionId);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      /**
       * A read raced against the end-turn grace. The read itself is NOT
       * abandoned on a grace win: `takeStep` leaves it on `pendingStep`, and
       * the next pump (idle or the next turn) awaits that same promise, so
       * the frame it eventually yields is read exactly once.
       */
      const raceEndTurnGrace = async <S,>(read: Promise<S>): Promise<S | "end-turn-grace"> => {
        if (endTurnSeenAt === undefined || !persistent) return read;
        const remaining = Math.max(0, endTurnSeenAt + endTurnGraceMs - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<"end-turn-grace">((resolve) => {
          timer = setTimeout(() => resolve("end-turn-grace"), remaining);
          timer.unref?.();
        });
        try {
          return await Promise.race([read, grace]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      try {
        for (;;) {
          /**
           * FRAMES THE IDLE PUMP PARKED COME FIRST. A wake-up's opening frame
           * that arrived between turns, right as this turn was claimed, was
           * read by the idle pump and could not be handled idly (the engine
           * refused the provider turn because THIS turn had the session). It
           * is this turn's stream now; nothing is lost.
           */
          const step = runtime.parked.length > 0
            ? { done: false as const, value: runtime.parked.shift()! }
            : await raceEndTurnGrace(ClaudeRuntimeStore.takeStep(runtime));
          if (step === "end-turn-grace") {
            /**
             * THE MODEL SAID IT WAS DONE AND THE RESULT NEVER CAME (#465).
             * Settle as the result would have: the turn completes, the
             * process stays alive with its pending read parked on
             * `pendingStep` for the next pump, and the transcript says why.
             */
            // SILENT ON THE TRANSCRIPT. The first cut wrote a row here
            // ("Settled without the provider's result") and the owner read it
            // as noise: from the person's side the turn simply ended, and a
            // sentence about a frame they never see is a bad fit. The fact
            // goes to the opt-in diagnostic channel instead, where the person
            // chasing a missing result will look.
            if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
              console.error(`[claude-runtime] session=${sessionId} settled on the end-turn grace after ${endTurnGraceMs}ms; no result frame arrived`);
            }
            completed = true;
            await flush();
            if (persistent) break;
            continue;
          }
          if (step.done) {
            streamEnded = true;
            runtime.streamEnded = true;
            // The process took its background work with it — see
            // `reportLostBackgroundWork`. Flushed HERE rather than left to the
            // post-loop flush, because a turn that ends this way usually ends
            // by throwing and everything still in `pending` would go with it.
            reportLostBackgroundWork();
            await flush();
            break;
          }
          const message = step.value;
          const item = message as SdkFrame;

          if (str(item.session_id) && item.session_id !== reportedSessionId) {
            reportedSessionId = item.session_id;
            // REPORTED THE MOMENT IT IS KNOWN, not only in the result: a turn
            // that is stopped never completes, and without this the session
            // would lose its resume cursor — the next turn starting a fresh
            // provider session with all context silently gone.
            emit({ kind: "provider.session", providerSessionId: item.session_id! });
          }

          /**
           * Whose work is this?
           *
           * A SUB-AGENT'S OUTPUT MUST NOT BECOME THE TURN'S RESULT, which is
           * the trap `forwardSubagentText` opens: with it on, every sub-agent's
           * prose arrives as an ordinary `assistant` message, and appending it
           * to `finalText` would make the turn's summary the concatenation of
           * five agents talking at once instead of the main loop's answer.
           */
          const parentToolUseId = str(item.parent_tool_use_id ?? undefined);

          /**
           * A TURN THE CLI STARTED BY ITSELF IS NOT THIS TURN.
           *
           * MEASURED (session_7657b2ef…, turns 96–98, and reproduced against
           * CLI 2.1.259): a background shell or monitor that fires between
           * engine turns makes the CLI inject its own `task-notification` user
           * message and run a whole model turn on it — assistant text, tool
           * calls, a `result` — into the shared iterator, where it sits until
           * the next engine turn pumps. That next turn then read the wake-up's
           * prose as its own answer, its `result` as its own end (a `/compact`
           * turn "answered" with "Tick 1 arrived"), and the real reply landed
           * on the turn after. The CLI marks its own turns two ways: the
           * frames that answer OUR send carry `user_message_uuid` = the key we
           * pushed, and a CLI-originated result carries `origin`. A frame is
           * foreign from the first frame that names a different sender until
           * the result that closes it. Its rows are filed under the task that
           * fired it (the last notification, or the wake-up itself) so they
           * appear beside the shell that spoke, not as the assistant's reply.
           */
          if (item.type === "stream_event" && item.event?.type === "message_start" && !parentToolUseId) {
            const sender = str(item.user_message_uuid);
            if (sender === turnUuid) {
              // Our reply has begun. Later message_starts INSIDE it (the
              // continuation after a tool round) carry no uuid — measured —
              // and are ours by position.
              ownTurnOpen = true;
              foreignTurn = undefined;
              runtime.echoesUserMessageUuid = true;
            } else if (sender !== undefined || (runtime.echoesUserMessageUuid && !ownTurnOpen)) {
              // Another sender's turn, or — on a producer known to echo the
              // key — a turn with no sender at all before ours has begun:
              // the CLI's own. Its message_start carries no uuid (measured).
              // Filed under the shell that spoke; a wake-up with no task to
              // name still keeps its rows, under no owner, rather than being
              // dropped — the idle pump is the path that gives it a turn of
              // its own, and this one is merely the fallback for a wake-up
              // that landed in a human turn's window.
              foreignTurn = { taskId: runtime.tasks.lastWokenTaskId };
            }
          }
          if (item.type === "result" && !parentToolUseId) {
            /**
             * A RESULT WITH NO SENDER IS OURS unless something already said
             * otherwise. Measured (CLI 2.1.259): a `/compact` turn — and any
             * local command — answers with NO `message_start` and a `result`
             * carrying neither `user_message_uuid` nor `origin`. Treating that
             * as a stranger's parked the pump for 35 minutes on a compaction
             * that had finished in one second. The CLI's own turns are caught
             * by their `message_start` (above) or their `origin` (here).
             */
            /**
             * `origin` IS NOT A FOREIGN MARK ANY MORE — #465's whole cause.
             *
             * This used to treat ANY `origin` on a result as the CLI's own
             * turn. That was true while Telar stamped no origin on its sends.
             * #241 (1cf9b1c8, 2026-09-13 20:42) began stamping a person's
             * message `origin: {kind: "human"}`, and MEASURED on CLI 2.1.270
             * the result ECHOES that origin back — so from that commit on
             * every result answering a human's message was discarded here as
             * a stranger's, `completed` was never set, and the turn sat
             * `running` until the person pressed Stop. First stall: 23:36
             * the same evening, on the first nightly carrying #241.
             *
             * A result is foreign when a foreign turn is OPEN, or when it
             * names a DIFFERENT sender. An origin whose sender is ours (or
             * absent, on a CLI-started turn caught by its message_start) says
             * nothing about ownership.
             */
            const sender = str(item.user_message_uuid);
            const foreignResult =
              foreignTurn !== undefined ||
              (sender !== undefined && sender !== turnUuid) ||
              // A CLI-originated turn that produced no message_start (a
              // notification answered without streaming) is still caught
              // by an origin that is NOT a person's — `human` is the one
              // kind Telar itself stamps, and the CLI echoes it back.
              (str(item.origin?.kind) !== undefined && item.origin?.kind !== "human");
            if (foreignResult) {
              foreignTurn = undefined;
              runtime.tasks.lastWokenTaskId = undefined;
              await flush();
              continue;
            }
          }

          const ownerTaskId = parentToolUseId ? `task_${parentToolUseId}` : foreignTurn?.taskId;
          /** The MAIN LOOP OF OUR TURN — not a sub-agent's, not the CLI's own
           *  turn. Only this contributes to `finalText`, holds the turn open
           *  through `openTopLevelTools`, and moves the usage meter. A foreign
           *  turn with no task to name still shows its rows, but never as
           *  the answer to a question nobody asked. */
          const ours = !parentToolUseId && foreignTurn === undefined;

          // ── the provider made the turn wait, and said why ─────────────
          /**
           * WHAT THE SILENCE WAS. Before this, an SDK backoff and a rejected
           * rate limit produced no observation at all: the #201 sample has
           * nineteen quiet gaps totalling 36 minutes and nothing in the
           * journal can say which of them were provider waits. A blocking
           * wait opens an in-progress row; the next frame closes it, so the
           * pause is bounded rather than a marker floating in silence.
           */
          const waited = providerWaitFrom(item);
          if (waited) {
            closeProviderWait();
            const id = itemId();
            const detail: ItemDetail = { type: "provider_wait", wait: waited.detail };
            emit({ kind: "item.started", item: { id, detail, title: titleForProviderWait(waited.detail) } });
            if (waited.blocking) waitItemId = id;
            else emit({ kind: "item.completed", itemId: id, status: "completed", detail });
            // SECONDS TO MILLISECONDS, the one place it happens: the row above
            // keeps the provider's own units, and everything downstream of here
            // is a time the engine schedules against. See `TurnFailure.resumeAt`.
            if (waited.blocking && waited.detail.kind === "rate_limit" && waited.detail.resetsAt !== undefined) {
              standingLimit = {
                resumeAt: waited.detail.resetsAt * 1_000,
                ...(waited.detail.limitType === undefined ? {} : { limitType: waited.detail.limitType }),
              };
            }
            await flush();
            continue;
          }
          /**
           * ONLY OUR OWN MAIN LOOP RESUMING ENDS THE WAIT.
           *
           * The first version closed on the NEXT FRAME OF ANY KIND, which is
           * wrong twice over: a background shell's `task_notification` or the
           * CLI's own housekeeping arrives on the same iterator and proves
           * nothing about the request we are waiting on, and a sub-agent's
           * output proves even less — its model call is a different request
           * that was never retried. So the row closed on unrelated traffic and
           * reported a resumption that had not happened.
           *
           * Model output for THIS turn's main loop is the evidence: the request
           * went through. Anything else leaves the row open, and the turn's own
           * end closes it if nothing ever does.
           */
          const ourLoopSpoke =
            ours && (item.type === "stream_event" || item.type === "assistant" || item.type === "user" || item.type === "result");
          // THE REQUEST LANDED — whether or not the watch ever fired. Disarmed
          // unconditionally, because the common case is the happy one: a reply
          // that arrives in two seconds must not leave a timer standing to open
          // a row about a silence that ended twenty-eight seconds ago.
          if (ourLoopSpoke) disarmProviderSilence();
          /**
           * WHICH FRAMES DISARM THE END-TURN GRACE — and which do not.
           *
           * MEASURED on CLI 2.1.270 through the SDK: after the model finishes,
           * the frames arrive as `assistant` (envelope, `stop_reason: end_turn`),
           * then `stream_event/message_delta` (carrying the same end_turn), then
           * `stream_event/message_stop`, then `result`. The first cut of #465
           * disarmed on ANY frame of ours, so the two trailing stream frames of
           * the SAME message disarmed the grace every time and the settle never
           * fired — the nightly that shipped it still stalled (2026-09-14 10:15).
           *
           * Only frames that mean MORE IS COMING disarm it: a new message
           * beginning (`message_start`), a tool result (`user`) the model will
           * answer, or a `result` (which ends the turn on its own path). A
           * message's own trailing delta and stop are the end being spelled
           * out, not a continuation.
           */
          if (
            ourLoopSpoke &&
            (item.type === "user" || item.type === "result" || (item.type === "stream_event" && item.event?.type === "message_start"))
          ) {
            endTurnSeenAt = undefined;
          }
          if (waitItemId && ourLoopSpoke) {
            closeProviderWait();
            /**
             * MODEL OUTPUT CLEARS THE LIMIT; A `result` DOES NOT.
             *
             * A result ENDS the wait row either way, but it is not evidence the
             * request went through — a non-success result is the CLI giving up,
             * which is precisely the case this whole branch exists to catch. It
             * is in the set above because the row must close; it is excluded
             * here because clearing on it made every limit that ended a turn
             * fail as `driver_failed` (both mapping tests caught it). A
             * SUCCESSFUL result never reaches the throw, so the standing limit
             * is moot there.
             */
            if (item.type !== "result") standingLimit = undefined;
          }

          // ── compaction, announced then bounded ────────────────────────
          if (item.type === "system" && item.subtype === "status") {
            /**
             * A REQUEST JUST WENT OUT. From here until our own main loop speaks
             * the CLI reports nothing whatever happens, so this is where the
             * engine starts counting — see `armProviderSilence` and #263.
             *
             * Re-armed on every `requesting`, which is what makes it per
             * REQUEST rather than per turn: a turn with four tool rounds sends
             * four, and each gets its own clock.
             */
            if (str(item.status) === "requesting") armProviderSilence();
            /**
             * `status: "compacting"` opens the row; a later status carrying
             * `compact_result` closes it. Measured against CLI 2.1.246: a
             * `/compact` prompt produces exactly this pair (then a fresh
             * `init`). These messages were silently discarded before, which
             * is why compaction looked like the agent hanging and then
             * forgetting things.
             */
            if (str(item.status) === "compacting" && !compactionItemId) {
              compactionItemId = itemId();
              compactionSucceeded = false;
              compactionMeasured = false;
              emit({
                kind: "item.started",
                item: { id: compactionItemId, detail: { type: "context_compaction" }, title: "Compacting context" },
              });
              await flush();
            } else if (item.compact_result !== undefined && compactionItemId) {
              if (item.compact_result === "success") {
                // NOT CLOSED YET unless the numbers are already in. On CLI
                // 2.1.259 the `compact_boundary` — the one message with the
                // numbers — arrives AFTER this, and a row already closed made
                // the boundary open a second one ("Compacted context" twice,
                // measured). Whichever of the boundary and this comes last
                // closes the row; the turn's end closes it if neither does.
                compactionSucceeded = true;
                if (compactionMeasured) {
                  emit({ kind: "item.completed", itemId: compactionItemId, status: "completed" });
                  compactionItemId = undefined;
                }
              } else {
                emit({ kind: "item.completed", itemId: compactionItemId, status: "failed" });
                compactionItemId = undefined;
              }
              await flush();
            }
            continue;
          }
          if (item.type === "system" && item.subtype === "compact_boundary") {
            /**
             * The boundary carries the numbers: trigger and window occupancy
             * either side. An AUTO compaction may produce a boundary with no
             * `status` announcement first, so the row is opened here when
             * needed — a boundary alone still deserves a transcript row.
             */
            const metadata = asRecord(item.compact_metadata);
            const detail: ItemDetail = {
              type: "context_compaction",
              ...(str(metadata.trigger) ? { reason: str(metadata.trigger)! } : {}),
              ...(typeof metadata.pre_tokens === "number" ? { preTokens: metadata.pre_tokens } : {}),
              ...(typeof metadata.post_tokens === "number" ? { postTokens: metadata.post_tokens } : {}),
            };
            if (compactionItemId) {
              emit({ kind: "item.updated", item: { id: compactionItemId, detail, title: "Compacting context" } });
              compactionMeasured = true;
              if (compactionSucceeded) {
                emit({ kind: "item.completed", itemId: compactionItemId, status: "completed", detail });
                compactionItemId = undefined;
              }
            } else {
              const id = itemId();
              emit({ kind: "item.started", item: { id, detail, title: "Compacted context" } });
              emit({ kind: "item.completed", itemId: id, status: "completed", detail });
            }
            await flush();
            continue;
          }

          // ── sub-agents and background work ────────────────────────────
          // One handler, shared with the idle pump — the frames are the same
          // whether a turn is reading or the session is between turns.
          if (await handleTaskFrame(item)) {
            await flush();
            continue;
          }

          if (item.type === "result") {
            /**
             * A SUB-AGENT'S RESULT IS THE SUB-AGENT'S, NEVER THE TURN'S. The
             * SDK types say results are main-loop only, but this pump takes
             * whatever arrives — and a result carrying `parent_tool_use_id`
             * completing the PARENT turn (or, worse, a child's non-success
             * result FAILING it) would end a turn whose main loop is still
             * mid-thought. Discriminate before touching usage or completion.
             */
            if (parentToolUseId) {
              await flush();
              continue;
            }
            // THE PROVIDER'S WORD WINS OVER THE ASSUMPTION, in both directions.
            // The old `Math.max` let a selected 1M row override a reported
            // 200k window, which is exactly the meter that lied on the
            // dogfood app. A result with no table keeps the last known value.
            const reportedContextMax = contextMaxFrom(item.modelUsage);
            contextMax = reportedContextMax ?? contextMax;
            /**
             * THE LIFECYCLE SCALARS, TO THE GATED LOG AND NOWHERE ELSE.
             *
             * The #201 audit could not tell hidden thinking from provider
             * queueing from network wait, because the result's own timings were
             * read and discarded. These are whitelisted numbers — no prompt, no
             * header, no error text, no identifier — and they go to the same
             * opt-in diagnostic channel as the runtime line rather than into
             * the durable journal, which is not a performance ledger.
             */
            if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
              const scalar = (candidate: unknown): number | undefined => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined);
              console.error(
                `[claude-timing] session=${sessionId} ` +
                  JSON.stringify({
                    durationMs: scalar(item.duration_ms),
                    apiMs: scalar(item.duration_api_ms),
                    ttftMs: scalar(item.ttft_ms),
                    turns: scalar(item.num_turns),
                    stopReason: str(item.stop_reason ?? undefined) ?? null,
                    subtype: item.subtype ?? null,
                  }),
              );
            }
            // THIS TURN'S SPEND, not the query's running total — see `turnCostFrom`.
            usage = decorateUsage(usageFrom(item.usage, turnCostFrom(item.total_cost_usd, runtime)) ?? usage);
            if (usage) emit({ kind: "usage", usage });
            if (item.subtype !== "success") {
              // An interrupt surfaces as a non-success result; the human's
              // stop must read as a stop, never as a provider failure.
              if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
              // OUR OWN CUT, ANSWERING A STEER: not a failure and not the turn's
              // end. The words that caused it are already in the feed, so keep
              // pumping; the text streamed before the cut stays journalled.
              if (consumeSteerCut()) {
                // …but the calls the interrupt killed ARE over, and leaving
                // them open is what wedged every steered turn — see
                // `closeCutTools`.
                closeCutTools();
                await flush();
                continue;
              }
              /**
               * THE CLI GAVE UP WITH A LIMIT STILL STANDING — so say which
               * thing happened. `driver_failed` sends a person looking for a
               * fault that is not there; this one is a wait with an end, and
               * the engine can sit it out on its own.
               */
              if (standingLimit) throw new RateLimitedError(standingLimit.resumeAt, standingLimit.limitType);
              throw new Error(`Claude did not complete successfully${item.subtype ? ` (${item.subtype})` : ""}`);
            }
            /**
             * AND AN ERRORED RESULT CAN STILL SAY `success` (#779). The CLI's
             * own safeguards report `subtype: "success"` with `is_error: true`
             * — `[reasoning_extraction]` is the one we have seen — so the guard
             * above, which reads the subtype alone, is blind to exactly the
             * shape it looks like it catches. Today the SDK throws out of the
             * iterator before this line runs, which is why such a turn already
             * fails; this is what answers when it does not.
             *
             * SEPARATE from that branch on purpose, rather than widened into
             * it. A non-success subtype is how an interrupt, our own steer cut
             * and a standing limit arrive; an errored success is none of the
             * three, and routing it through `consumeSteerCut()` would spend the
             * cut token on a provider failure and pump on as if the turn were
             * still alive.
             */
            if (item.is_error === true) {
              // Same rule as above: the human's stop reads as a stop.
              if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
              throw new Error("Claude did not complete successfully (the result was flagged as an error)");
            }
            /**
             * IS THE QUERY ACTUALLY DONE? Reproduced on a live orchestration
             * session (session_7657b2ef…, events 15479–15560): the CLI can
             * emit a `result` for the assistant's text while tool_use blocks
             * from that same response are STILL EXECUTING — their tool_results
             * arrive afterwards and the model continues. Completing the engine
             * turn here settled the worker's claim, so every subsequent tool
             * call in the same response hit "turn is not running under this
             * worker claim" until the daemon was restarted.
             *
             * The result's own `stop_reason` is the discriminator the SDK
             * gives us: `"tool_use"` means the model stopped to run tools and
             * WILL continue — keep pumping to the next result. A `null` stop
             * reason with main-loop tool calls still unresolved is the same
             * situation stated less clearly (older CLIs), so it holds too. An
             * ABSENT field is an older producer (or a fake SDK) that never
             * says: for those the result stays what it always was, the end of
             * the turn — which also keeps a tool whose result never arrives
             * closing as failed rather than parking the pump forever.
             */
            const stopReason = "stop_reason" in item ? (item.stop_reason ?? null) : undefined;
            const toolsStillRunning = openTopLevelTools.size > 0 && (stopReason === "tool_use" || stopReason === null);
            if (persistent && toolsStillRunning) {
              await flush();
              continue;
            }
            /**
             * A SUCCESS ALSO ANSWERS AN OUTSTANDING CUT: the answer finished
             * before the interrupt landed. Consumed here so no token survives.
             *
             * AND THE PERSON'S WORDS ARE STILL OWED AN ANSWER. They are in the
             * CLI's command queue, which an interrupt spares — `queued_turn_count`
             * above zero is the SDK saying another turn follows with no further
             * input (sdk.d.ts). Completing here would end the engine turn with
             * the message already acked as delivered and nothing answering it,
             * so keep pumping until it has been. At zero it was already absorbed
             * into the answer just read; absent (older CLI) keeps the previous
             * behaviour, where the next turn's pump picks it up.
             */
            if (consumeSteerCut()) {
              const queuedTurns = "queued_turn_count" in item ? item.queued_turn_count : undefined;
              if (typeof queuedTurns === "number" && queuedTurns > 0) {
                await flush();
                continue;
              }
            }
            completed = true;
            await flush();
            /**
             * A FINAL RESULT ENDS THE TURN AND NOTHING ELSE. The pump stops
             * HERE, with the stream open and the process alive — that is the
             * whole design (see ./claude-runtime.ts); the next turn resumes
             * pumping this same iterator. On the kill-switch path the input
             * stream is already exhausted, so the loop instead runs on to the
             * stream's natural close, exactly as it always did.
             */
            if (persistent) break;
            continue;
          }

          // ── streaming text and reasoning ───────────────────────────────
          if (item.type === "stream_event") {
            const event = item.event ?? {};
            /**
             * KEYED BY OWNER AND INDEX, NOT BY INDEX ALONE.
             *
             * Content-block indices restart at 0 in every agent, so with
             * sub-agent text forwarded a child's block 0 and the main loop's
             * block 0 are two different blocks with one key — the child's
             * `content_block_start` would silently overwrite the parent's open
             * row and the parent's deltas would then append to the child's
             * item. Concurrent agents make this the common case, not an edge.
             */
            const index = `${parentToolUseId ?? ""}#${typeof event.index === "number" ? event.index : -1}`;

            if (event.type === "content_block_start") {
              const blockType = event.content_block?.type;
              // TOOL BLOCKS ARE DELIBERATELY NOT OPENED HERE. Their input
              // arrives as `input_json_delta` fragments that are only valid
              // JSON once complete, and the assistant envelope below repeats
              // every tool_use with its input already parsed. Opening in both
              // places is how a row gets emitted twice.
              if (blockType === "text" || blockType === "thinking") {
                const id = itemId();
                openBlocks.set(index, { id, kind: blockType, text: "" });
                emit({
                  kind: "item.started",
                  item: {
                    id,
                    detail: blockType === "text" ? { type: "assistant_message", text: "" } : { type: "reasoning", text: "" },
                    ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
                  },
                });
              }
              continue;
            }

            if (event.type === "content_block_delta") {
              const open = openBlocks.get(index);
              if (!open) continue;
              const text = event.delta?.type === "text_delta" ? event.delta.text : event.delta?.thinking;
              if (typeof text !== "string" || text.length === 0) continue;
              open.text += text;
              // The producer streams, whoever the text belongs to: the
              // envelope's own text is a repeat and must not become a row.
              if (open.kind === "text") receivedPartialText = true;
              if (open.kind === "text" && ours) finalText += text;
              emit({
                kind: "content.delta",
                itemId: open.id,
                stream: open.kind === "text" ? "assistant_text" : "reasoning_text",
                text,
              });
              // Coalesced for a frame rather than flushed per chunk — see
              // `flushSoon`. Every terminal frame below still flushes at once.
              flushSoon();
              continue;
            }

            if (event.type === "content_block_stop") {
              const open = openBlocks.get(index);
              if (!open) continue;
              openBlocks.delete(index);
              emit(closeBlock(open));
              await flush();
              continue;
            }

            /**
             * THE FINAL OUTPUT COUNT, which nothing else in the stream carries.
             *
             * Every earlier report of `output_tokens` for a response is a
             * placeholder: the SDK says so of the streamed assistant envelopes
             * ("message.usage is not final"), and the #201 sample shows it —
             * a 41-minute journal whose observations reported outputs of 6, 3
             * and 2 tokens. `message_delta` is the one frame that states the
             * response's real output, so it is folded onto the envelope's own
             * usage and the occupancy recomputed from the pair.
             *
             * Read only for OUR main loop: a sub-agent's output is reported on
             * its own task, never against the parent's meter.
             */
            /**
             * THE MODEL'S "I AM DONE", WHERE THE REAL SDK ACTUALLY SAYS IT
             * (#465). Probed on CLI 2.1.270: the `assistant` envelope the SDK
             * streams carries NO `stop_reason` (its own doc says so — "the
             * turn's stop reason arrives on the result message"); the on-disk
             * transcript does, which is what the envelope arm below was written
             * against, and why nightlies .2 and .3 never armed the grace on a
             * single real turn. On the wire, `end_turn` rides the closing
             * `message_delta`'s `delta.stop_reason`. Same conditions as the
             * envelope arm; both stay so either producer shape arms it.
             */
            if (
              event.type === "message_delta" &&
              ours &&
              str(asRecord(event.delta).stop_reason) === "end_turn" &&
              openTopLevelTools.size === 0
            ) {
              endTurnSeenAt = Date.now();
            }
            if (event.type === "message_delta" && ours && lastEnvelopeUsage) {
              const output = asRecord(event.usage).output_tokens;
              if (typeof output !== "number" || output < 0) continue;
              lastEnvelopeUsage = { ...asRecord(lastEnvelopeUsage), output_tokens: output };
              contextUsed = contextUsedFrom(lastEnvelopeUsage) ?? contextUsed;
              const snapshot = usageFrom(lastEnvelopeUsage, undefined);
              if (!snapshot) continue;
              // The cost already recorded for this turn is kept: this frame
              // says nothing about price, and dropping it would read as free.
              usage = decorateUsage({ ...snapshot, ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }) });
              emit({ kind: "usage", usage: usage! });
              await flush();
            }
            continue;
          }

          // ── tool calls, from the complete envelope ─────────────────────
          if (item.type === "assistant") {
            // A sub-agent's usage is reported on its own task, not folded into
            // the parent's running total, or the turn would double-count it
            // against the `result` message's authoritative figure.
            if (ours) {
              const snapshot = usageFrom(item.message?.usage, undefined);
              if (snapshot) {
                // Kept raw so the response's closing `message_delta` can
                // correct its placeholder output count against it.
                lastEnvelopeUsage = item.message?.usage;
                contextUsed = contextUsedFrom(item.message?.usage) ?? contextUsed;
                usage = decorateUsage(snapshot);
                /**
                 * EMITTED PER ENVELOPE, not held until the result — this is
                 * what makes the context ring move DURING a Claude turn, the
                 * way `thread/tokenUsage/updated` already moves it on Codex.
                 * Before this the local variable updated and nothing left the
                 * driver until the turn ended.
                 */
                emit({ kind: "usage", usage: usage! });
              }
            }
            for (const raw of contentBlocks(item.message?.content)) {
              const block = asRecord(raw);
              if (block.type === "tool_use") {
                const name = str(block.name) ?? "tool";
                const useId = str(block.id) ?? itemId();
                /**
                 * ONE PLAN ROW PER TURN, UPDATED IN PLACE.
                 *
                 * TodoWrite is called repeatedly with the WHOLE list, so a row
                 * per call leaves the transcript full of near-identical
                 * checklists — the exact failure the Codex seam already avoids,
                 * and the reason `plan` says "updated in place across a turn".
                 * The call is deliberately not registered in `openTools`, so
                 * its `tool_result` closes nothing; the plan closes with the
                 * turn.
                 */
                const plan = name === "TodoWrite" ? planDetailForTodos(block.input) : undefined;
                if (plan) {
                  const detail: ItemDetail = { type: "plan", plan };
                  if (planItemId) emit({ kind: "item.updated", item: { id: planItemId, detail, title: "Plan" } });
                  else {
                    planItemId = `item_plan_${crypto.randomUUID().replaceAll("-", "")}`;
                    emit({ kind: "item.started", item: { id: planItemId, detail, title: "Plan" } });
                  }
                  continue;
                }
                /**
                 * A `Task` call is a HANDLE, not a tool row.
                 *
                 * items.ts defines `task` as "the row is a handle; the detail
                 * is on the task events", and the id is derived from the
                 * tool_use id — the same derivation every message inside the
                 * sub-agent will produce from its `parent_tool_use_id`. That is
                 * what joins the handle to the work without a lookup table.
                 */
                const isTask = name === "Task" || name === "Agent";
                const detail: ItemDetail = isTask
                  ? { type: "task", taskId: `task_${useId}` }
                  : itemDetailForToolCall(name, block.input);
                const title = isTask
                  ? oneLine(str(asRecord(block.input).description) ?? str(asRecord(block.input).subagent_type) ?? name)
                  : titleForToolCall(name, detail);
                const seed: ItemSeed = {
                  id: `item_${useId}`,
                  detail,
                  title,
                  ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
                  providerRefs: { itemId: useId },
                };
                openTools.set(useId, { id: seed.id, detail });
                if (ours) openTopLevelTools.add(useId);
                emit({ kind: "item.started", item: seed });
                continue;
              }
              // With partial messages enabled the envelope REPEATS its text.
              // Emitting it again would double both the transcript and the
              // final result, so this is only the compatibility fallback for
              // an SDK that produced no stream events at all.
              if (block.type === "text" && !receivedPartialText) {
                const text = str(block.text);
                if (!text) continue;
                if (ours) finalText += text;
                const id = itemId();
                emit({
                  kind: "item.started",
                  item: { id, detail: { type: "assistant_message", text }, ...(ownerTaskId ? { taskId: ownerTaskId } : {}) },
                });
                emit({ kind: "item.completed", itemId: id, status: "completed" });
              }
            }
            /**
             * THE MODEL'S OWN "I AM DONE" (#465). With no top-level tool left
             * open there is nothing more this turn can wait for except the
             * CLI's `result`; arm the grace so a missing result cannot hold
             * the turn forever. A `tool_use` stop reason, or an open tool,
             * means more is coming and the grace stays down.
             */
            if (ours && item.message?.stop_reason === "end_turn" && openTopLevelTools.size === 0) endTurnSeenAt = Date.now();
            await flush();
            continue;
          }

          // ── tool results ──────────────────────────────────────────────
          if (item.type === "user") {
            const results = contentBlocks(item.message?.content).map(asRecord).filter((block) => block.type === "tool_result");
            /**
             * `tool_use_result` IS PER MESSAGE, NOT PER BLOCK.
             *
             * It carries the tool's full structured Output — for a file edit,
             * the `structuredPatch` this whole diff feature depends on. But the
             * SDK hangs it off the message rather than off the block, so with
             * two results in one message there is no way to know which it
             * describes. Attaching it anyway would put one file's diff on
             * another file's row, which is worse than having no diff at all.
             */
            const structured = results.length === 1 ? item.tool_use_result : undefined;
            for (const block of results) {
              const useId = str(block.tool_use_id);
              const open = useId ? openTools.get(useId) : undefined;
              if (!open || !useId) continue;
              openTools.delete(useId);
              openTopLevelTools.delete(useId);
              const failed = block.is_error === true;
              const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
              emit({
                kind: "item.completed",
                itemId: open.id,
                status: failed ? "failed" : "completed",
                detail: withToolResult(open.detail, output, structured),
              });
            }
            await flush();
          }
        }

        if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
        // THE OTHER WAY A LIMIT ENDS A TURN: the stream stops without a result
        // frame at all. Measured on the retry path, the CLI does not always get
        // as far as saying it failed — so the same evidence answers here, or a
        // rate-limited turn would fail as `driver_failed` purely because the
        // provider hung up quietly rather than loudly.
        if (!completed && standingLimit) throw new RateLimitedError(standingLimit.resumeAt, standingLimit.limitType);
        if (!completed) throw new Error("Claude ended without a successful result");

        // A tool whose result never arrived (the stream ended first) would
        // otherwise sit spinning in the UI forever.
        for (const [, open] of openTools) {
          emit({ kind: "item.completed", itemId: open.id, status: "failed" });
        }
        // A block the provider never closed still gets its accumulated text,
        // for the same reason: the projection has no other source for it.
        for (const [, open] of openBlocks) emit(closeBlock(open));
        // The plan is turn-scoped and has no tool_result to close it.
        if (planItemId) emit({ kind: "item.completed", itemId: planItemId, status: "completed" });
        // A wait the stream ended inside is over — the turn is not waiting for
        // anything any more, whatever the reason it stopped. The watch goes
        // with it: a timer left armed past the turn would open a row on a sink
        // that has stopped taking.
        closeProviderWait();
        disarmProviderSilence();
        // A compaction the stream ended inside is over: finished if the CLI
        // said so and only the boundary never came, failed otherwise.
        if (compactionItemId) emit({ kind: "item.completed", itemId: compactionItemId, status: compactionSucceeded ? "completed" : "failed" });
        /**
         * A task left running when the turn ended is closed as failed.
         *
         * THIS MATTERS MORE THAN THE TOOL CASE ABOVE. `livenessOf()` reads task
         * state to answer "is this session still working", and a sub-agent
         * stuck at `running` makes a finished detached session claim it is
         * still busy — forever, with no live stream to correct it and nothing
         * for a human to stop. BACKGROUND WORK is left alone: outliving its
         * turn is what background means — and that includes an agent that was
         * launched detached, which is still running inside the live process
         * and will report through the next turn's pump.
         */
        for (const [id, task] of knownTasks) {
          if (isBackgroundWork(task)) continue;
          if (task.state === "completed" || task.state === "failed" || task.state === "stopped") continue;
          emit({ kind: "task.completed", task: { ...task, id, state: "failed", failure: "the turn ended before this agent reported back" } });
        }
        await flush();

        return {
          text: finalText,
          ...(reportedSessionId ? { providerSessionId: reportedSessionId } : {}),
          ...(usage ? { usage } : {}),
        };
      } catch (error) {
        /**
         * DOES THE PROCESS SURVIVE THE FAILED TURN? Only for a stop that
         * interrupted cleanly — the stream is still open and ALIGNED, because
         * the interrupted turn's own result was consumed above (or never
         * will arrive, in which case the escalation already destroyed the
         * runtime and `streamEnded` says so). Anything else — stream death, a
         * non-success result, an SDK throw — leaves a process this driver
         * cannot vouch for, so the next turn cold-starts from `resume`.
         */
        if (persistent && (!signal.aborted || streamEnded)) runtimes.destroy(sessionId);
        throw error;
      } finally {
        turnDone = true;
        cancelReap?.();
        signal.removeEventListener("abort", onAbort);
        if (persistent) {
          runtimes.release(sessionId);
          // Only what the CLI says BETWEEN turns names a wake-up. A task that
          // spoke inside this turn (its own `task_started`) is not what woke
          // the model — measured: two monitor ticks both attributed to a
          // shell that had merely been launched in the same turn.
          runtime.tasks.lastWokenTaskId = undefined;
          // The turn is over; the process is not. Keep reading it.
          if (sessionHooks && !runtime.streamEnded) startIdlePump(runtime, sessionHooks);
        } else runtime.destroy();
      }

      /**
       * THE IDLE PUMP: what reads the stream when no turn does.
       *
       * Between turns the CLI keeps talking. Task frames (a monitor's tick,
       * a shell's ending, the level signal) go straight to the session's
       * `onTasks`, so a row closes when its shell exits instead of at the
       * next human message — the ten-hour "Wait for CI" row, measured. And
       * when the CLI wakes the model on a notification and runs a turn of its
       * own, the pump asks the engine for a PROVIDER TURN and reads that turn
       * through a binding of its own: a gate that decides its tool calls, a
       * sink its rows land in, a completion of its own. Before this, those
       * frames sat buffered until the next human turn, were read as a
       * stranger's, and their tool calls were refused against a settled
       * claim — the agent could wake but not act, and nobody saw it.
       *
       * Ends the moment a turn claims the runtime (`claim` calls `stop`); the
       * `next()` it was parked on is handed to that turn via `pendingStep`.
       */
      function startIdlePump(idleRuntime: ClaudeSessionRuntime<ClaudeTurnBindings, TaskSeed>, hooks: DriverSessionHooks): void {
        if (idleRuntime.idlePump) return;
        let stopped = false;
        idleRuntime.idlePump = { stop: () => { stopped = true; } };
        void (async () => {
          // A wake-up in flight, once the engine has opened a turn for it.
          let wake:
            | {
                binding: ProviderTurnBinding;
                text: string;
                usage: UsageSnapshot | undefined;
                gate: SdkCanUseTool | undefined;
                blocks: Map<string, { id: string; kind: "text" | "thinking"; text: string }>;
                tools: Map<string, { id: string; detail: ItemDetail }>;
                /** The open provider-wait row, exactly as a human turn keeps one. */
                waitItemId: string | undefined;
                /** The newest main-loop envelope's raw usage, so this turn's
                 *  closing `message_delta` can correct its placeholder output. */
                lastUsage: unknown;
              }
            | undefined;
          const idleSink = (observations: TurnObservation[]) => hooks.onTasks(observations);
          sink = idleSink;
          /** The engine refused a wake-up: a human turn has the session and
           *  will claim this runtime any moment. Everything read from here
           *  on is that turn's, in order — parked, not handled. */
          let parkingForTurn = false;
          const endWake = async (result: { text: string } | { failure: string }) => {
            if (!wake) return;
            const current = wake;
            wake = undefined;
            // The wake-up is over; the process may be evicted again.
            runtimes.setWakeActive(idleRuntime.sessionId, false);
            // A wait this turn ended inside is over, whatever ended it.
            if (current.waitItemId) emit({ kind: "item.completed", itemId: current.waitItemId, status: "completed" });
            for (const [, open] of current.tools) emit({ kind: "item.completed", itemId: open.id, status: "failed" });
            for (const [, open] of current.blocks) emit(closeBlock(open));
            await flush();
            sink = idleSink;
            idleRuntime.bindings.current = { ...idleRuntime.bindings.current, canUseTool: undefined };
            await current.binding.close("failure" in result ? result : { text: result.text, ...(current.usage ? { usage: current.usage } : {}) }).catch(() => undefined);
          };
          try {
            for (;;) {
              if (stopped) return;
              // NOT `takeStep`: a pump told to stop while parked must leave
              // the frame on `pendingStep` for the turn that stopped it —
              // the turn may not have awaited the promise yet.
              const step = idleRuntime.pendingStep ?? (idleRuntime.pendingStep = idleRuntime.iterator.next());
              const result = await step;
              if (stopped) return;
              if (idleRuntime.pendingStep === step) idleRuntime.pendingStep = undefined;
              if (result.done) {
                idleRuntime.streamEnded = true;
                /**
                 * THE CASE THE TURN PUMP CANNOT SEE, and the common one once a
                 * turn settles with its shells still alive: the process dies
                 * BETWEEN turns, with nobody's turn open to fail. Nothing else
                 * would ever close those rows — the turn that started them has
                 * long since ended and deliberately left background work alone
                 * — so the session would read as monitoring for ever.
                 *
                 * AFTER `endWake`, never before: it emits the wake-up's own
                 * closing rows into THAT turn's sink and only then restores
                 * `idleSink`. Reporting first would file a dead process's task
                 * rows on a turn that is about to settle.
                 */
                await endWake({ failure: "the provider process ended" });
                sink = idleSink;
                reportLostBackgroundWork();
                await flush();
                return;
              }
              const item = result.value as SdkFrame;
              if (parkingForTurn) {
                idleRuntime.parked.push(item);
                continue;
              }
              const parentToolUseId = str(item.parent_tool_use_id ?? undefined);
              if (str(item.session_id)) reportedSessionId = item.session_id;

              if (await handleTaskFrame(item)) {
                await flush();
                continue;
              }
              // Sub-agent frames between turns: a backgrounded agent still
              // working. Filed under its task like inside a turn.
              const ownerTaskId = parentToolUseId ? `task_${parentToolUseId}` : undefined;

              if (!wake) {
                const wokenTask = idleRuntime.tasks.lastWokenTaskId;
                /**
                 * THE REQUEST GOING OUT OPENS THE TURN — not the first token
                 * that comes back (#71).
                 *
                 * A turn is what makes the cockpit say anything at all: the
                 * working indicator and the sidebar's liveness dot read the
                 * session's live turn and nothing else. So for as long as the
                 * wake-up had no turn, a background task's ending was followed
                 * by complete silence on screen — measured twice, and read both
                 * times as "the task didn't wake you up" while a full response
                 * was being generated. The gap is the request itself: the CLI
                 * announces `system/status {requesting}` as it goes out and then
                 * reports NOTHING until the reply opens (#263 puts p90 near 15s
                 * at a large context, and measured a stall at sixty), so opening
                 * on `message_start` meant opening after the whole silence.
                 *
                 * ONLY WHEN A TASK HAS JUST SPOKEN, which is what makes this a
                 * wake-up rather than a guess. `lastWokenTaskId` is set by the
                 * notification (or a monitor's tick) and cleared the moment a
                 * turn opens, so exactly one request can be read this way — and
                 * a request the CLI sends between turns for its own reasons,
                 * which may never produce a main-loop `result` to close a turn
                 * with, cannot mint one. A wake that announced no task still
                 * opens the old way, on the reply.
                 *
                 * THE INPUT IS THE COST. The CLI echoes the notification it
                 * injected as a `user` frame, and whichever of the two comes
                 * first is the one that opens the turn — so a turn opened here
                 * has no `input` to carry (the echo that follows is not a row:
                 * `pumpFrame` reads tool results out of a user frame and
                 * nothing else). A wake row with no expandable text is a
                 * smaller loss than a wake nobody can see.
                 */
                const requesting =
                  item.type === "system" && item.subtype === "status" && str(item.status) === "requesting" && !parentToolUseId && wokenTask !== undefined;
                // Anything the main loop says with no turn open is the CLI
                // starting one of its own. Open a real turn for it.
                const opens = requesting || (item.type === "stream_event" && item.event?.type === "message_start") || item.type === "assistant" || (item.type === "user" && !parentToolUseId);
                if (!opens && !ownerTaskId) continue;
                if (ownerTaskId) {
                  // Sub-agent output with no turn: stays visible on its task.
                  sink = idleSink;
                  if (await pumpFrame(item, ownerTaskId, undefined)) await flush();
                  continue;
                }
                const text = item.type === "user" ? userText(item.message?.content) : undefined;
                const binding = await hooks.onProviderTurn({
                  input: text ?? "",
                  reason: wokenTask ? { kind: "task_notification", taskId: wokenTask } : { kind: "unknown" },
                });
                if (!binding) {
                  // A human turn took the session first. Park this and every
                  // frame after it for that turn; the pump ends when the turn
                  // claims the runtime.
                  parkingForTurn = true;
                  idleRuntime.parked.push(item);
                  continue;
                }
                idleRuntime.tasks.lastWokenTaskId = undefined;
                // LIVE WORK, so the pool stops treating this process as spare.
                // The engine has opened a real turn against it; evicting it now
                // would kill a turn nobody could see start.
                runtimes.setWakeActive(idleRuntime.sessionId, true);
                wake = {
                  binding,
                  text: "",
                  usage: undefined,
                  gate: binding.onRequest ? gateFor(binding.onRequest) : undefined,
                  blocks: new Map(),
                  tools: new Map(),
                  waitItemId: undefined,
                  lastUsage: undefined,
                };
                sink = (observations) => binding.onObservations(observations);
                idleRuntime.bindings.current = { ...idleRuntime.bindings.current, canUseTool: wake.gate };
                // The announcement said a request went out, and the turn just
                // opened above IS that. Nothing is left of it to render.
                if (requesting) continue;
                // The CLI's injected notification message is the turn's input
                // — already on the turn; not a row.
                if (item.type === "user" && !parentToolUseId && text !== undefined) continue;
              }

              /**
               * THE METER MOVES ON A WAKE-UP TOO. A turn the CLI starts on its
               * own spends context like any other, and until this the idle
               * pump read neither the envelope's usage nor the result's
               * `modelUsage` — so a session that worked for an hour on
               * monitor ticks reported the ring where the last human turn
               * left it. Same two reads as the turn pump, same rule: the
               * provider's reported window replaces the assumption.
               */
              /**
               * A WAKE-UP WAITS THE SAME WAY A HUMAN TURN DOES.
               *
               * The engine has opened a real turn with a real observation sink,
               * so there is somewhere to put the row — an earlier version of
               * this patch claimed otherwise and was wrong. A retry inside an
               * autonomous turn is exactly as invisible as one inside a human's
               * and just as worth explaining.
               *
               * EXPLICITLY LIMITED: a wait announced BEFORE the engine grants a
               * binding still goes unrecorded. Those frames belong to no turn
               * yet, and the session-level task channel takes task reports
               * rather than rows. That gap closes with the single-consumer
               * consolidation, not here.
               */
              const idleWaited = providerWaitFrom(item);
              if (idleWaited) {
                if (wake.waitItemId) emit({ kind: "item.completed", itemId: wake.waitItemId, status: "completed" });
                const id = itemId();
                const detail: ItemDetail = { type: "provider_wait", wait: idleWaited.detail };
                emit({ kind: "item.started", item: { id, detail, title: titleForProviderWait(idleWaited.detail) } });
                wake.waitItemId = idleWaited.blocking ? id : undefined;
                if (!idleWaited.blocking) emit({ kind: "item.completed", itemId: id, status: "completed", detail });
                await flush();
                continue;
              }
              // Same ownership rule as the turn pump: only this turn's own main
              // loop speaking proves the request went through.
              if (wake.waitItemId && !parentToolUseId && (item.type === "stream_event" || item.type === "assistant" || item.type === "user" || item.type === "result")) {
                emit({ kind: "item.completed", itemId: wake.waitItemId, status: "completed" });
                wake.waitItemId = undefined;
              }

              if (item.type === "assistant" && !parentToolUseId) {
                const snapshot = usageFrom(item.message?.usage, undefined);
                if (snapshot) {
                  // Kept raw so this turn's closing `message_delta` can correct
                  // its placeholder output count against it.
                  wake.lastUsage = item.message?.usage;
                  contextUsed = contextUsedFrom(item.message?.usage) ?? contextUsed;
                  wake.usage = decorateUsage(snapshot);
                  emit({ kind: "usage", usage: wake.usage! });
                }
              }
              /** The response's REAL output count, for a wake-up too — see the
               *  turn pump's copy of this. */
              if (item.type === "stream_event" && item.event?.type === "message_delta" && !parentToolUseId && wake.lastUsage) {
                const output = asRecord(item.event.usage).output_tokens;
                if (typeof output === "number" && output >= 0) {
                  wake.lastUsage = { ...asRecord(wake.lastUsage), output_tokens: output };
                  contextUsed = contextUsedFrom(wake.lastUsage) ?? contextUsed;
                  const snapshot = usageFrom(wake.lastUsage, undefined);
                  if (snapshot) {
                    wake.usage = decorateUsage({ ...snapshot, ...(wake.usage?.costUsd === undefined ? {} : { costUsd: wake.usage.costUsd }) });
                    emit({ kind: "usage", usage: wake.usage! });
                    await flush();
                  }
                }
                continue;
              }
              if (item.type === "result" && !parentToolUseId) {
                const stopReason = "stop_reason" in item ? (item.stop_reason ?? null) : undefined;
                if (wake.tools.size > 0 && (stopReason === "tool_use" || stopReason === null)) continue;
                contextMax = contextMaxFrom(item.modelUsage) ?? contextMax;
                // The same accounting a human turn gets: a wake-up spends
                // against the same query, so it takes the same baseline.
                wake.usage = decorateUsage(usageFrom(item.usage, turnCostFrom(item.total_cost_usd, idleRuntime)) ?? wake.usage);
                if (wake.usage) emit({ kind: "usage", usage: wake.usage });
                /**
                 * THE SAME TWO WAYS A RESULT FAILS as the turn pump's guards,
                 * because it is the same producer: a subtype that is not
                 * `success`, or a `success` the CLI flagged `is_error` anyway
                 * (#779). Reading the subtype alone would file a safeguard's
                 * error as the wake-up's answer. Widened inline here — this
                 * branch has no interrupt, steer or limit handling to disturb.
                 */
                const failure =
                  item.subtype !== "success"
                    ? `Claude did not complete successfully${item.subtype ? ` (${item.subtype})` : ""}`
                    : item.is_error === true
                      ? "Claude did not complete successfully (the result was flagged as an error)"
                      : undefined;
                await endWake(failure ? { failure } : { text: wake.text });
                continue;
              }
              const text = await pumpFrame(item, ownerTaskId, wake);
              if (text) wake.text += text;
              await flush();
            }
          } catch {
            await endWake({ failure: "the provider stream failed between turns" }).catch(() => undefined);
            // A stream that threw is a process that is going away, with the
            // same consequence for its shells — see `reportLostBackgroundWork`.
            sink = idleSink;
            reportLostBackgroundWork();
            await flush().catch(() => undefined);
            runtimes.destroy(idleRuntime.sessionId);
          } finally {
            if (idleRuntime.idlePump?.stop === undefined || stopped) idleRuntime.idlePump = undefined;
          }
        })();
      }

      /**
       * One frame of assistant output — text, thinking, tool calls, tool
       * results — into rows, for the idle pump. The turn pump has its own
       * inlined copy of this logic with more state (usage, compaction, the
       * plan row); this is the subset a wake-up produces. Returns the
       * main-loop text the frame added, so the turn's `resultText` can be
       * built; true-ish when it emitted anything.
       */
      async function pumpFrame(
        item: SdkFrame,
        ownerTaskId: string | undefined,
        wake: { blocks: Map<string, { id: string; kind: "text" | "thinking"; text: string }>; tools: Map<string, { id: string; detail: ItemDetail }> } | undefined,
      ): Promise<string> {
        const blocks = wake?.blocks ?? new Map<string, { id: string; kind: "text" | "thinking"; text: string }>();
        const tools = wake?.tools ?? new Map<string, { id: string; detail: ItemDetail }>();
        let added = "";
        if (item.type === "stream_event") {
          const event = item.event ?? {};
          const index = `${ownerTaskId ?? ""}#${typeof event.index === "number" ? event.index : -1}`;
          if (event.type === "content_block_start") {
            const blockType = event.content_block?.type;
            if (blockType === "text" || blockType === "thinking") {
              const id = itemId();
              blocks.set(index, { id, kind: blockType, text: "" });
              emit({ kind: "item.started", item: { id, detail: blockType === "text" ? { type: "assistant_message", text: "" } : { type: "reasoning", text: "" }, ...(ownerTaskId ? { taskId: ownerTaskId } : {}) } });
            }
          } else if (event.type === "content_block_delta") {
            const open = blocks.get(index);
            const text = event.delta?.type === "text_delta" ? event.delta.text : event.delta?.thinking;
            if (open && typeof text === "string" && text.length > 0) {
              open.text += text;
              if (open.kind === "text" && !ownerTaskId) added += text;
              emit({ kind: "content.delta", itemId: open.id, stream: open.kind === "text" ? "assistant_text" : "reasoning_text", text });
            }
          } else if (event.type === "content_block_stop") {
            const open = blocks.get(index);
            if (open) {
              blocks.delete(index);
              emit(closeBlock(open));
            }
          }
          return added;
        }
        if (item.type === "assistant") {
          for (const raw of contentBlocks(item.message?.content)) {
            const block = asRecord(raw);
            if (block.type !== "tool_use") continue;
            const name = str(block.name) ?? "tool";
            const useId = str(block.id) ?? itemId();
            const isTask = name === "Task" || name === "Agent";
            const detail: ItemDetail = isTask ? { type: "task", taskId: `task_${useId}` } : itemDetailForToolCall(name, block.input);
            const title = isTask ? oneLine(str(asRecord(block.input).description) ?? str(asRecord(block.input).subagent_type) ?? name) : titleForToolCall(name, detail);
            tools.set(useId, { id: `item_${useId}`, detail });
            emit({ kind: "item.started", item: { id: `item_${useId}`, detail, title, ...(ownerTaskId ? { taskId: ownerTaskId } : {}), providerRefs: { itemId: useId } } });
          }
          return added;
        }
        if (item.type === "user") {
          const results = contentBlocks(item.message?.content).map(asRecord).filter((block) => block.type === "tool_result");
          const structured = results.length === 1 ? item.tool_use_result : undefined;
          for (const block of results) {
            const useId = str(block.tool_use_id);
            const open = useId ? tools.get(useId) : undefined;
            if (!open || !useId) continue;
            tools.delete(useId);
            const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
            emit({ kind: "item.completed", itemId: open.id, status: block.is_error === true ? "failed" : "completed", detail: withToolResult(open.detail, output, structured) });
          }
        }
        return added;
      }
    },
  };
}

/** The plain text of a user message's content — the CLI's own injected
 *  notification, when it wakes the model. */
function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map(asRecord).filter((block) => block.type === "text").map((block) => str(block.text) ?? "").join("\n");
  return text.length > 0 ? text : undefined;
}

/**
 * Fold a tool's result into the detail its call opened with.
 *
 * `structured` is the SDK's full Output object, which is where the interesting
 * half lives: a file edit's `structuredPatch`. The string `output` is only what
 * was sent to the MODEL, and for an edit that is a confirmation sentence.
 */
export function withToolResult(detail: ItemDetail, output: string, structured?: unknown): ItemDetail {
  if (detail.type === "file_change") {
    const hunks = patchHunksOf(structured);
    if (!hunks) return detail;
    return {
      ...detail,
      change: {
        ...detail.change,
        unifiedDiff: unifiedDiff(detail.change.path, hunks),
        ...countDiffLines(hunks),
      },
    };
  }
  return withToolOutput(detail, output);
}

/** Fold a tool's output into the detail its call opened with. */
function withToolOutput(detail: ItemDetail, output: string): ItemDetail {
  const preview = output.length > 4_000 ? `${output.slice(0, 4_000)}…` : output;
  switch (detail.type) {
    case "command_execution":
      return { ...detail, command: { ...detail.command, outputPreview: preview } };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    // A browser action's output is its snapshot or its console dump, and it is
    // the whole reason the row is expandable. Omitted before this arm existed.
    case "browser_action":
      return { ...detail, call: { ...detail.call, output: preview } };
    default:
      return detail;
  }
}
