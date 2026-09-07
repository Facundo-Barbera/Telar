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
import fs from "node:fs";
import { z } from "zod";
import type {
  ItemDetail,
  ItemSeed,
  McpServer,
  TurnAttachment,
  RequestDecision,
  RequestDetail,
  RequestKind,
  PlanDetail,
  TaskKind,
  TaskSeed,
  TaskState,
  TurnObservation,
  UsageSnapshot,
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
import { spoolTools, type SpoolCapability } from "./spool/tools";
import type { SteerMailbox } from "./steering";
import { sessionsTools, type SessionsCapability } from "./sessions-tools/tools";
import { notebookTools } from "./ds/notebook-tools";
import { dsTools } from "./ds/ds-tools";
import type { DsCapability } from "./ds/capability";

export type { SpoolCapability, SessionsCapability, DsCapability, DisplayCapability };

/** What the provider wants to do, in the contract's vocabulary. */
export type DriverRequest = {
  kind: RequestKind;
  detail: RequestDetail;
  /** The provider's own tool-use id, so the row and the request correlate. */
  toolUseId: string;
};

/**
 * The engine's answer — and, for a `user_input` request, what the human
 * actually typed. A bare `RequestDecision` remains a legal answer (it is what
 * every test and every approval-shaped caller returns); `normalizeOutcome`
 * is how a consumer that cares about answers reads both shapes.
 */
export type DriverRequestOutcome = { decision: RequestDecision; answers?: Record<string, unknown> };

export function normalizeOutcome(value: RequestDecision | DriverRequestOutcome): DriverRequestOutcome {
  return typeof value === "string" ? { decision: value } : value;
}

/**
 * WHY THE QUESTION TOOL RIDES `canUseTool`, NOT THE DIALOG CHANNEL. The CLI
 * does define a `request_user_dialog` kind for it
 * (`permission_ask_user_question`), but claude-cli 2.1.246 never emits it to
 * SDK 0.3.224 even with the kinds declared in initialize — measured by
 * running it. What DOES work, also measured: `canUseTool` answering
 * `{behavior:"allow", updatedInput:{...input, answers}}`, which completes the
 * tool with the human's answers. See the AskUserQuestion arm in `canUseTool`.
 */

export type DriverRun = {
  prompt: string;
  /**
   * WHICH SESSION THIS TURN BELONGS TO — the key the Claude driver holds its
   * live runtime under (see ./claude-runtime.ts). Without it every turn is an
   * island and nothing a turn leaves running can survive the turn's end,
   * which was precisely the bug: one SDK query per turn meant one CLI process
   * per turn, and backgrounded shells, monitors and sub-agents all died with
   * their parent at every turn boundary.
   */
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  /**
   * SEND NOW: text a human pushed into this running turn. The worker fills
   * it from the heartbeat; how a driver injects it is the driver's own
   * affair — Claude yields it at the next turn boundary of its streaming
   * prompt, Codex sends `turn/steer` the moment it lands. Absent means the
   * deployment (or test) has no send-now channel, and the driver behaves
   * exactly as before it existed.
   */
  steer?: SteerMailbox;
  /**
   * The session's door to the user's item store.
   *
   * PER-RUN, NOT PER-DRIVER, unlike `browser`. A browser is a machine resource
   * the deployment owns and every session borrows; the spool arrives already
   * SCOPED to the project this turn belongs to, and that scope is a fact about
   * the turn. Capturing one at construction would give every session the first
   * session's slice.
   *
   * ABSENT MEANS NO SPOOL TOOLS, which is what a test gets and what an older
   * worker produces — not an empty spool. The difference matters: a model told
   * "no items" would report that as the truth.
   */
  spool?: SpoolCapability;
  /**
   * The session's door to OTHER sessions — create, send, read, status, stop,
   * diff.
   *
   * PER-RUN, like the spool and for a related reason: it is assembled out of
   * the worker's own client, so a deployment with no client has no toolkit
   * rather than a broken one.
   *
   * ABSENT MEANS NO SESSIONS TOOLS, which is what a test gets and what an older
   * worker produces — never an empty engine. A model told "no sessions exist"
   * would report that as the truth.
   *
   * IT CARRIES NO IDENTITY. There is nothing on this capability that says which
   * session is holding it, because nothing downstream records one: a session
   * created through here is a PEER, not a child, and the absence of a link is
   * the design rather than a gap in it.
   */
  sessions?: SessionsCapability;
  /**
   * The session's kernel, notebooks and analysis tools — present only when
   * the project opted in (the claim carried `dataScience`). Per-run like the
   * spool: assembled from the worker's client, scoped to this session.
   * ABSENT MEANS THE TOOLKITS DO NOT EXIST, never an empty kernel.
   */
  ds?: DsCapability;
  /**
   * The session's door to the human's SCREEN — `display_open`, the tool that
   * shows one workspace file in the cockpit's right panel. Per-run like the
   * spool: the worker assembles it around this turn's checkout, so the fence
   * is the turn's own. ABSENT MEANS THE TOOL DOES NOT EXIST, which is what a
   * test gets and what an older worker produces.
   */
  display?: DisplayCapability;
  /**
   * Which model to run, resolved by the engine from the session.
   *
   * ABSENT MEANS "the provider's own default", and that is a distinct state
   * from any string this code could invent. A driver that substituted a name
   * here would silently override whatever the installed harness is configured
   * to use, and the session would report a model it is not running.
   */
  model?: string;
  /** Reasoning effort, where the provider has the concept. Same absent rule. */
  effort?: string;
  /** Latency over quality, where the provider offers it. Claude-only. */
  fastMode?: boolean;
  /**
   * Files the human attached to THIS message, already on disk.
   *
   * The engine wrote them and owns the paths; a driver reads them and decides
   * how its provider wants them. That split is deliberate — a driver that
   * accepted bytes would have to be trusted with where they came from.
   */
  attachments?: TurnAttachment[];
  /** The user's own MCP servers, already filtered to the enabled ones by the
   *  engine. Telar's in-process servers are added by the driver on top. */
  mcpServers?: McpServer[];
  /**
   * WHICH LOGIN THIS TURN RUNS AS, expressed as an environment patch over the
   * worker's own — the config dir, whatever the instance declares, and (for a
   * configured instance) `undefined` for each ambient variable that would
   * otherwise silently replace its identity.
   *
   * A PATCH RATHER THAN A WHOLE ENVIRONMENT because the child still needs PATH
   * and HOME like any other process, and a driver handed a complete environment
   * would be the one deciding which of the worker's variables survive.
   */
  env?: Record<string, string | undefined>;
  /**
   * The binary THIS LOGIN runs, when it pinned one — an absolute path, or a
   * bare name to look up the way a terminal would.
   *
   * SEPARATE FROM `env` because it is not one: it decides which executable is
   * spawned, not what that executable inherits. Absent means the driver's own
   * default name, which is what every login had before this existed.
   */
  binaryPath?: string;
  /**
   * WHICH CONFIGURED LOGIN this turn runs as, by id.
   *
   * The driver does not spend it — `env` and `binaryPath` are what actually
   * shape the child process. It is here because a WARP agent's task row carries
   * a `ModelSelection`, and the contract defines that as "which login, and which
   * model on it": a row that named a model without naming whose account ran it
   * would be unattributable. Absent means no selection is recorded, which is
   * what every task did before warps existed.
   */
  providerInstanceId?: string;
  /**
   * Telar's browser, as an HTTP MCP server the WORKER hosts — see
   * `browser/socket.ts`. PER-RUN because the token is: it binds this turn's
   * scope, gate and observation sink, and dies with the turn. The driver only
   * registers the endpoint with its provider; scoping and approval are already
   * bound behind it.
   */
  browserSocket?: { url: string; token: string };
  /**
   * The `sessions_*` wall as an HTTP MCP server the WORKER hosts — see
   * `sessions-tools/run-socket.ts`. FOR PROVIDERS THAT TAKE SERVERS AS CONFIG
   * (Codex): the Claude driver ignores it and keeps its in-process
   * registration under `telar`, because renaming a shipped tool would split
   * its identity. The token is per-session — the bound capability closes over
   * `self`, so a subscription made through it wakes the right session.
   */
  sessionsSocket?: { url: string; token: string };
  /** Engine-owned provider continuity from the preceding completed turn. */
  providerSessionId?: string;
  /**
   * THE SESSION'S TASK ROWS AS THE ENGINE HAS THEM, for a runtime that has to
   * be built cold. A live runtime remembers every task its process launched
   * (`TaskMemory`); a runtime rebuilt after a restart or an eviction knows
   * nothing, and the first `task_notification` a still-running shell sends it
   * would mint a ghost row for a task the store already has. Carried on the
   * claim like `resumeCursor`, and for the same reason: the worker holds no
   * store handle. Absent (an older engine, a test) means an empty memory.
   */
  tasks?: TaskSeed[];
  /**
   * THE SESSION'S DOOR FOR WHAT HAPPENS BETWEEN TURNS. The Claude process
   * outlives the turn and keeps talking after it: a monitor reports, a shell
   * ends, and — the important case — the CLI wakes the model on that ending
   * and runs a whole turn of its own. With this present the driver keeps
   * reading the stream after `run()` returns, files task frames through
   * `onTasks`, and opens a real turn through `onProviderTurn` for the
   * CLI's own — with a gate and an observation sink of that turn's own, so
   * its tool calls are decided rather than refused against a settled claim.
   * Absent (an older worker, a test) means the stream is read only while a
   * turn pumps it, exactly as before.
   */
  session?: DriverSessionHooks;
  /** Batched back to the engine. Never called after the run settles. */
  onObservations(observations: TurnObservation[]): Promise<void>;
  /**
   * Ask whether a tool call may proceed. Resolves with the engine's answer,
   * which may take an arbitrarily long time — a parked approval waits for a
   * human. ABSENT means the driver runs with no gate at all, which is the
   * `full-access` shape and is what the tests use.
   */
  onRequest?(request: DriverRequest): Promise<RequestDecision | DriverRequestOutcome>;
};

export type DriverResult = {
  text: string;
  providerSessionId?: string;
  usage?: UsageSnapshot;
};

/**
 * What a turn the PROVIDER started needs from the engine: the same three
 * things a human turn's claim carries. Returned by `onProviderTurn.open`,
 * handed back whole at `close`.
 */
export type ProviderTurnBinding = {
  runId: string;
  onObservations(observations: TurnObservation[]): Promise<void>;
  onRequest?(request: DriverRequest): Promise<RequestDecision | DriverRequestOutcome>;
  /** Settle the turn. `text` is the model's final prose; a failure ends it failed. */
  close(result: DriverResult | { failure: string }): Promise<void>;
};

export type DriverSessionHooks = {
  /** Task frames read between turns — the level signal, a notification, a Ctrl+B. */
  onTasks(observations: TurnObservation[]): Promise<void>;
  /**
   * The CLI began a turn of its own. Resolves with the binding the driver
   * pumps that turn through, or `undefined` if the engine refused (a human
   * turn claimed the session first — the frames are then that turn's).
   */
  onProviderTurn(input: { input: string; reason: { kind: "task_notification" | "unknown"; taskId?: string } }): Promise<ProviderTurnBinding | undefined>;
};

export type TurnDriver = {
  run(input: DriverRun): Promise<DriverResult>;
  /**
   * Close every live provider process this driver holds. OPTIONAL because
   * only the Claude driver keeps any (its session runtimes); the worker calls
   * it on stop so a shutdown does not orphan a CLI per open session.
   */
  dispose?(): void;
  /**
   * Stop ONE lingering background task inside a session's live process, by its
   * provider task id — the id the task's `task.started` carried as
   * `providerTaskId`. OPTIONAL for the same reason as `dispose`: only the
   * Claude driver holds a live process a task can linger inside. Resolves
   * `true` when a live runtime took the request, `false` when there is none
   * (the process is already gone, so the task is too).
   */
  stopTask?(sessionId: string, providerTaskId: string): Promise<boolean>;
};

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

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
 * spool and sessions capabilities to the worker client that assembled them,
 * and the warp spawn to this turn's model and login.
 */
type ClaudeTurnBindings = {
  signal: AbortSignal;
  canUseTool: SdkCanUseTool | undefined;
  spool: SpoolCapability | undefined;
  sessions: SessionsCapability | undefined;
  ds: DsCapability | undefined;
  display: DisplayCapability | undefined;
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
 * Telar no longer offers Claude's 200k variants. Keep 1M enabled for every
 * supported Claude family spelling, including older sessions that stored the
 * bare alias before the catalogue stopped publishing it.
 */
function claudeContextEnvForModel(model: string | undefined): Record<string, string> | undefined {
  if (!model || !isClaudeLongContextFamily(model)) return undefined;
  return { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" };
}

function selectedContextMaxFromModel(model: string | undefined): number | undefined {
  if (!model || !isClaudeLongContextFamily(model)) return undefined;
  return 1_000_000;
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
 * WHAT THE DIRECTING AGENT READS, and the only documentation of Warp that a
 * model ever sees.
 *
 * Written as instructions for choosing, not as a description of parameters: the
 * failure this guards against is not a malformed call, it is a warp launched for
 * work that one agent should have done in a straight line. A fan-out costs a
 * real process per child on the user's own machine.
 */
const WARP_DESCRIPTION = `Run a Warp: a script that fans work out across several sub-agents and returns their combined result.

The script is JavaScript and it is where the structure lives — loops, conditionals, fan-out and the plain code between stages are yours to write, and they run deterministically rather than being decided turn by turn. Reach for this when the work is wide (many files, many angles, many candidates) or when confidence matters more than speed (independent attempts, adversarial verification). For anything a single straight line of work covers, do it yourself — this spawns a real process per concurrent child.

The script must begin with a pure object literal:

  export const meta = { name: 'find-flaky-tests', description: 'Find flaky tests and propose fixes', phases: [{ title: 'Scan' }, { title: 'Fix' }] }

Then write statements at the top level. Top-level await and top-level return both work; whatever you return becomes this tool's result. Available as globals:

- agent(prompt, opts?) -> Promise<any>. One sub-agent. Resolves to its final text, or — with opts.schema (a JSON Schema) — to a validated object, which is what makes the code between stages ordinary code instead of another agent hired to read the last one's paragraphs. Resolves to null if the child died, so .filter(Boolean) before using results. opts: { model, effort, schema, label, phase, maxTurns, agentType }. Omit model to inherit the session's.
- parallel(thunks) -> Promise<any[]>. Concurrent, WITH A BARRIER: everything settles before it resolves. Correct only when the next step genuinely needs all of the previous one at once — a dedupe across the whole set, an early exit on a total, a prompt that compares one finding against the others.
- pipeline(items, ...stages) -> Promise<any[]>. Each item through every stage independently, NO barrier. This is the default for multi-stage work: item A can be in stage 3 while item B is still in stage 1, so the run costs the slowest single chain rather than the sum of the slowest-per-stage. Every stage receives (previousResult, originalItem, index). A stage that throws drops that item to null and keeps the others flowing.
- phase(title) opens a progress group; log(message) narrates to the human; args is the JSON value passed alongside the script.

Date.now(), new Date() and Math.random() THROW — a script that branched on the clock could not be replayed. require, import, process and fs are absent; the script orchestrates agents and does not touch the host itself. A script that cannot parse, is missing its meta, or reaches for a banned name is refused before anything is spent, with the line number.

A Warp child may not create work that outlives the run or escapes the script: fan-out (Agent, Task, Workflow), scheduling (cron, wake-ups), messaging other sessions, and switching worktrees are all withheld from it. So the script is the only place parallelism is expressed. Children run in the same checkout as this session and inherit its permissions.`;

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
  sdk: ClaudeSdk,
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
  const { tool } = sdk;
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
 * FOUND BY DRIVING THE MASTER CHAT. The Spool's front door opened, the assistant
 * reached for `spool_list_items` to answer "where did I stop?", and the turn
 * parked — asking the user to approve READING THEIR OWN TASK LIST. That is the
 * exact friction the module exists to remove, on the one screen it exists to be.
 *
 * THE FIX IS A CLASSIFICATION, NOT A BYPASS, and the distinction matters. The
 * engine already has a ladder: `approval-required` auto-accepts `file_read` and
 * parks everything else. These tools ARE reads — they return the user's own
 * stored items and change nothing — so naming them correctly lets the existing
 * rule do its job. Nothing here can skip a mode's decision; it only stops
 * mis-declaring a read as an action.
 *
 * THE LIST IS EXPLICIT, NEVER A PREFIX MATCH ON "list". `spool_create_item`,
 * `spool_update_item` and `spool_consult_expert` all stay `tool_call` and keep
 * parking: two of them write, and the third spends money. A rule shaped like
 * "anything that sounds like a read" would silently adopt the next tool whose
 * name starts well.
 */
// `display_open` is not literally a read, but it is read-SHAPED: it writes
// nothing, spends nothing, and its whole effect is a panel opening on the
// human's own screen — which they watch happen. Parking an approval card for
// "may I show you this?" would be the card answering itself.
const TELAR_READ_TOOLS = new Set<string>(["spool_list_items", "spool_list_lanes", "ds_packages", "ds_kernel", "display_open"]);

export function requestKindForTool(name: string): RequestKind {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "command_execution";
  if (name === "Read" || name === "NotebookRead" || name === "Glob" || name === "Grep") return "file_read";
  if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "file_change";
  const parsed = parseToolName(name);
  // Only OUR servers' tools qualify — a user-configured server that happened to
  // name a tool `spool_list_items` must not inherit the engine's own posture.
  if (isTelarMcpServer(parsed.server) && TELAR_READ_TOOLS.has(parsed.tool)) return "file_read";
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
  } = {},
): TurnDriver {
  const resolveExecutable = options.resolveExecutable ?? defaultClaudeExecutable;
  /** sessionId → live query. Owned per driver instance so every test gets
   *  isolation and each worker deployment owns exactly its own processes. */
  const runtimes = new ClaudeRuntimeStore<ClaudeTurnBindings, TaskSeed>();
  return {
    dispose: () => runtimes.destroyAll(),
    stopTask: (sessionId, providerTaskId) => runtimes.stopTask(sessionId, providerTaskId),
    async run({
      prompt,
      sessionId,
      cwd,
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
      spool,
      sessions,
      ds,
      display,
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
      const decorateUsage = (snapshot: UsageSnapshot | undefined): UsageSnapshot | undefined =>
        snapshot === undefined
          ? undefined
          : {
              ...snapshot,
              ...(contextUsed === undefined ? {} : { contextUsed }),
              ...(contextMax === undefined ? {} : { contextMax }),
            };
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
          kind: patch.kind ?? known?.kind ?? "agent",
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
        message?: { content?: unknown[]; usage?: unknown };
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
        patch?: { status?: string; description?: string; error?: string; is_backgrounded?: boolean };
        event?: {
          type?: string;
          index?: number;
          content_block?: { type?: string };
          delta?: { type?: string; text?: string; thinking?: string };
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
          emitTask(
            terminal ? "task.completed" : "task.progress",
            str(item.task_id),
            {
              state,
              ...(str(item.patch?.description) ? { title: oneLine(item.patch!.description!) } : {}),
              ...(str(item.patch?.error) ? { failure: item.patch!.error! } : {}),
              ...(backgrounded ? { backgrounded: true } : {}),
              ...(backgrounded && !known ? { kind: "background" as const } : {}),
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
              const id = str(asRecord(raw).task_id);
              return id ? [id] : [];
            }),
          );
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
      const flush = (): Promise<void> => {
        // The sink is read at FLUSH time, not at emit: `emit` then `flush`
        // are always adjacent, and the pump swaps the sink between frames.
        const target = sink;
        const next = flushQueue.then(async () => {
          if (pending.length === 0) return;
          const batch = pending.splice(0, pending.length);
          await target(batch);
        });
        // The CHAIN must survive a rejection or every later flush inherits it;
        // the caller still sees the failure on the promise it was handed.
        flushQueue = next.catch(() => undefined);
        return next;
      };
      const emit = (observation: TurnObservation): void => {
        pending.push(observation);
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
              const fields = questions.flatMap((question) => {
                const text = str(question.question);
                if (!text) return [];
                const choices = Array.isArray(question.options)
                  ? question.options.map(asRecord).flatMap((option) => (str(option.label) ? [str(option.label)!] : []))
                  : [];
                // KEYED BY THE QUESTION TEXT — that is AskUserQuestionOutput's
                // own answer key. The label repeats it because the header is a
                // 12-character chip, not a sentence a human can answer.
                return [{ key: text, label: text, kind: "choice" as const, choices, required: true }];
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
                      if (value !== undefined) answers[field.key] = Array.isArray(value) ? value.join(", ") : String(value);
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
       * TELAR'S IN-PROCESS TOOLS, IN ONE SERVER — the spool and `warp`.
       *
       * THE BROWSER IS NOT HERE ANY MORE: it is served by the worker's own
       * `BrowserToolSocket` and registered below as an HTTP entry, the same
       * registration the Codex driver makes — one transport, both providers.
       * Its approval gate rides the socket's binding, which is why `canUseTool`
       * above waves its calls through.
       */
      const onSteered = (text: string, attachments: TurnAttachment[]) => {
        const id = itemId();
        emit({
          kind: "item.started",
          item: {
            id,
            detail: { type: "user_message", text, ...(attachments.length > 0 ? { attachments } : {}) },
            title: "Sent now",
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
        spool,
        sessions,
        ds,
        display,
        warpSpawn,
        onWarpTask,
      };

      const streaming = claudeStreamingInputEnabled();

      /**
       * EVERYTHING THE QUERY BAKES IN AT CREATION. A turn whose fingerprint
       * differs from the live runtime's cannot reuse it — the options below
       * are fixed for the life of the process — so the store destroys the old
       * one and this turn cold-starts. `model` is deliberately absent: it is
       * the one knob a live query can turn (`setModel`).
       */
      const fingerprint = JSON.stringify({
        cwd,
        env: env ?? null,
        effort: sdkEffort ?? null,
        contextEnv: contextEnv ?? null,
        fastMode: fastMode ?? null,
        executable: executable ?? null,
        /**
         * ID AND SPEC ONLY, never the whole record. Measured on the dev app:
         * the auto-registered Computer Use server is re-stamped
         * (`createdAt`/`updatedAt`) on every turn, and hashing those
         * timestamps cold-started a new process per turn — killing the very
         * background work this runtime exists to keep alive. Only what shapes
         * the spawned process belongs here.
         */
        servers: userMcpServers?.map((server) => ({ id: server.id, enabled: server.enabled, spec: server.spec })) ?? null,
        browser: browserSocket ?? null,
        spool: Boolean(spool),
        sessions: Boolean(sessions),
        // Toggling the project's data-science switch must cold-start: the
        // toolkits are baked into the query at creation.
        ds: Boolean(ds),
        display: Boolean(display),
        gate: Boolean(canUseTool),
        instance: providerInstanceId ?? null,
      });

      const buildRuntime = (): ClaudeSessionRuntime<ClaudeTurnBindings, TaskSeed> => {
        const bindings: RuntimeBindings<ClaudeTurnBindings> = { current: turnBindings };

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
         * THE SPOOL, WHEN THE TURN CARRIES ONE — CAP-12's "tasks are a
         * Telar-wide substrate", which is only true if an ordinary project
         * session can reach them.
         *
         * NO APPROVAL GATE ON ANY OF THESE, and that is the same judgement the
         * legacy server made about the same four verbs: none of them is a commit.
         * Filing a task starts nothing, and the two things a human must decide —
         * a verdict, and a sub-task's promotion — have no tool input that can
         * spell them. The one gate that matters here is structural, not
         * interactive.
         */
        if (spool && sdk.tool) telarTools.push(...spoolTools(sdk.tool, delegatingCapability(() => bindings.current.spool)));

      /**
       * THE SESSIONS TOOLKIT, WHEN THE TURN CARRIES ONE.
       *
       * NO APPROVAL GATE ON ANY OF THESE, the same judgement the spool's verbs
       * get and for the same reason: not one of them lands anything. Creating a
       * session starts no work (nothing is queued until `sessions_send`),
       * reading and stopping are read-and-brake, and there is deliberately no
       * merge, no accept and no archive for a gate to guard. The guard that
       * matters here is structural — the store's live-session budget — not
       * interactive.
       *
       * THE ONE GATE THAT IS NOT HERE AT ALL is a warp child's. `warp/spawn.ts`
       * withholds Telar's whole MCP server from a child and names these tools
       * in `WARP_CHILD_DISALLOWED_TOOLS` on top of that, because
       * `sessions_create` is fan-out wearing another hat.
       */
        if (sessions && sdk.tool) telarTools.push(...sessionsTools(sdk.tool, delegatingCapability(() => bindings.current.sessions)));

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
         * THE DISPLAY TOOLKIT, WHEN THE TURN CARRIES ONE. No approval gate,
         * the spool's judgement again: opening a panel on a file the human
         * could open themselves commits nothing. The worker's capability owns
         * the one check that matters — the path stays inside this turn's own
         * checkout.
         */
        if (display && sdk.tool) telarTools.push(...displayTools(sdk.tool, delegatingCapability(() => bindings.current.display)));

        const warp = warpTool(sdk, {
          // Both delegate through the bindings — the tool is registered once
          // per session runtime, the spawn and the task sink change per turn.
          spawn: (input) => bindings.current.warpSpawn(input),
          onTask: (seed) => bindings.current.onWarpTask(seed),
          ...(providerInstanceId ? { instanceId: providerInstanceId } : {}),
          signal: () => bindings.current.signal,
        });
        if (warp) telarTools.push(warp);

        const telarServer =
          telarTools.length > 0 && sdk.createSdkMcpServer
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
            : (attachments?.length ?? 0) > 0
              ? singleUserMessage(claudeInitialContent(prompt, attachments ?? []))
              : prompt,
          options: {
            cwd,
            permissionMode: "default",
            ...(browserSocket
              ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: BROWSER_BRIEFING } }
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
            // from — and a key patched to `undefined` genuinely disappears,
            // which is how a configured instance stops inheriting a credential.
            ...(env || contextEnv ? { env: { ...process.env, ...env, ...contextEnv } } : {}),
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
          busy: true,
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
      let claimed = persistent ? runtimes.claim(sessionId, fingerprint) : undefined;
      // Field diagnosis only: which fingerprint field broke reuse. Off unless asked.
      if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
        console.error(`[claude-runtime] session=${sessionId} reuse=${Boolean(claimed)} fp=${fingerprint}`);
      }
      if (claimed && claimed.model !== model) {
        // The one knob a live query can turn. A query that cannot (a fake
        // SDK, an older CLI) is replaced instead of patched.
        const setModel = claimed.query.setModel?.bind(claimed.query);
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
        // The turn begins as one message pushed into the open stream.
        runtime.feed.push({
          type: "user",
          message: { role: "user", content: claudeInitialContent(prompt, attachments ?? []) },
          parent_tool_use_id: null,
          uuid: turnUuid,
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
      if (persistent && steer) {
        void (async () => {
          for (;;) {
            await steer.wake();
            if (turnDone) return;
            const queued = steer.drain();
            if (queued.length > 0) {
              // Joined rather than pushed one at a time: they arrived while a
              // single turn was running, so they are one interruption with
              // several sentences — and one set of attachments, built into
              // the message exactly as a queued turn's are (images as pixels,
              // everything else as a path).
              const text = queued.map((message) => message.text).join("\n\n");
              const attachments = queued.flatMap((message) => message.attachments ?? []);
              onSteered(text, attachments);
              runtime.feed.push({
                type: "user",
                message: { role: "user", content: claudeInitialContent(text, attachments) },
                parent_tool_use_id: null,
              });
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
      let interruptEscalation: ReturnType<typeof setTimeout> | undefined;
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
        interruptEscalation = setTimeout(() => runtimes.destroy(sessionId), 10_000);
        interruptEscalation.unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

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
            : await ClaudeRuntimeStore.takeStep(runtime);
          if (step.done) {
            streamEnded = true;
            runtime.streamEnded = true;
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
            const sender = str(item.user_message_uuid);
            const foreignResult =
              foreignTurn !== undefined || (sender !== undefined && sender !== turnUuid) || str(item.origin?.kind) !== undefined;
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

          // ── compaction, announced then bounded ────────────────────────
          if (item.type === "system" && item.subtype === "status") {
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
            const reportedContextMax = contextMaxFrom(item.modelUsage);
            contextMax =
              reportedContextMax === undefined
                ? contextMax
                : Math.max(contextMax ?? 0, reportedContextMax);
            usage = decorateUsage(usageFrom(item.usage, item.total_cost_usd) ?? usage);
            if (usage) emit({ kind: "usage", usage });
            if (item.subtype !== "success") {
              // An interrupt surfaces as a non-success result; the human's
              // stop must read as a stop, never as a provider failure.
              if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
              throw new Error(`Claude did not complete successfully${item.subtype ? ` (${item.subtype})` : ""}`);
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
            const toolsStillRunning = stopReason === "tool_use" || (stopReason === null && openTopLevelTools.size > 0);
            if (persistent && toolsStillRunning) {
              await flush();
              continue;
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
              // Flush per delta: buffering streamed text defeats streaming.
              await flush();
              continue;
            }

            if (event.type === "content_block_stop") {
              const open = openBlocks.get(index);
              if (!open) continue;
              openBlocks.delete(index);
              emit(closeBlock(open));
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
        if (interruptEscalation !== undefined) clearTimeout(interruptEscalation);
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
          let wake: { binding: ProviderTurnBinding; text: string; gate: SdkCanUseTool | undefined; blocks: Map<string, { id: string; kind: "text" | "thinking"; text: string }>; tools: Map<string, { id: string; detail: ItemDetail }> } | undefined;
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
            for (const [, open] of current.tools) emit({ kind: "item.completed", itemId: open.id, status: "failed" });
            for (const [, open] of current.blocks) emit(closeBlock(open));
            await flush();
            sink = idleSink;
            idleRuntime.bindings.current = { ...idleRuntime.bindings.current, canUseTool: undefined };
            await current.binding.close("failure" in result ? result : { text: result.text }).catch(() => undefined);
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
                await endWake({ failure: "the provider process ended" });
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
                // Anything the main loop says with no turn open is the CLI
                // starting one of its own. Open a real turn for it.
                const opens = (item.type === "stream_event" && item.event?.type === "message_start") || item.type === "assistant" || (item.type === "user" && !parentToolUseId);
                if (!opens && !ownerTaskId) continue;
                if (ownerTaskId) {
                  // Sub-agent output with no turn: stays visible on its task.
                  sink = idleSink;
                  if (await pumpFrame(item, ownerTaskId, undefined)) await flush();
                  continue;
                }
                const wokenTask = idleRuntime.tasks.lastWokenTaskId;
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
                wake = { binding, text: "", gate: binding.onRequest ? gateFor(binding.onRequest) : undefined, blocks: new Map(), tools: new Map() };
                sink = (observations) => binding.onObservations(observations);
                idleRuntime.bindings.current = { ...idleRuntime.bindings.current, canUseTool: wake.gate };
                // The CLI's injected notification message is the turn's input
                // — already on the turn; not a row.
                if (item.type === "user" && !parentToolUseId && text !== undefined) continue;
              }

              if (item.type === "result" && !parentToolUseId) {
                const stopReason = "stop_reason" in item ? (item.stop_reason ?? null) : undefined;
                if (stopReason === "tool_use" || (stopReason === null && wake.tools.size > 0)) continue;
                const failed = item.subtype !== "success";
                await endWake(failed ? { failure: `Claude did not complete successfully${item.subtype ? ` (${item.subtype})` : ""}` } : { text: wake.text });
                continue;
              }
              const text = await pumpFrame(item, ownerTaskId, wake);
              if (text) wake.text += text;
              await flush();
            }
          } catch {
            await endWake({ failure: "the provider stream failed between turns" }).catch(() => undefined);
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
