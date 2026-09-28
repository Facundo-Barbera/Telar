import { type ClaudeSessionRuntime, type RuntimeBindings, MessageFeed, type RuntimeQuery, taskMemoryFrom } from "./runtime";
import { type ClaudeTurnBindings, type SdkCanUseTool, type SdkUserMessage, singleUserMessage, claudeInitialContent, claudeNotificationContent } from "./sdk";
import { type TaskSeed, TELAR_MCP_SERVER, TELAR_BROWSER_MCP_SERVER } from "@telar/engine-client";
import { advertiseLeanSchemas, toSdkTools, telarWall } from "../../domains/agent-tools";
import { isTerminalTaskState } from "./tasks";
import { type TurnState, type Rest } from "./turn";

export type RuntimeCtx = {
  turn: TurnState;
  attachments: { id: string; name: string; mediaType: string; bytes: number; path: string; tags?: string[] | undefined; producer?: string | undefined; title?: string | undefined; createdAt?: number | undefined; }[] | undefined;
  browserSocket: { url: string; token: string; } | undefined;
  fastMode: boolean | undefined;
  model: string | undefined;
  notification: { kind: "wake" | "peer_message" | "request"; summary: string; fetch: { sessionId: string; runId: string; }; body: string; sessionId?: string | undefined; runId?: string | undefined; requestId?: string | undefined; wakeKind?: "turn_completed" | "turn_failed" | "turn_stopped" | "request_opened" | undefined; intent?: "task" | "report" | "result" | "blocker" | undefined; entries?: { kind: "wake" | "peer_message" | "request"; summary: string; sessionId?: string | undefined; runId?: string | undefined; requestId?: string | undefined; wakeKind?: "turn_completed" | "turn_failed" | "turn_stopped" | "request_opened" | undefined; intent?: "task" | "report" | "result" | "blocker" | undefined; }[] | undefined; deliveries?: number | undefined; cohortId?: string | undefined; cohortOpenedAt?: number | undefined; } | undefined;
  prompt: string;
  providerSessionId: string | undefined;
  seededTasks: TaskSeed[] | undefined;
  sessionId: string;
  ultracode: boolean | undefined;
};

export const buildRuntime = (ctx: RuntimeCtx): ClaudeSessionRuntime<ClaudeTurnBindings, TaskSeed> => {
  const bindings: RuntimeBindings<ClaudeTurnBindings> = { current: ctx.turn.turnBindings };
  /** The permission gate the QUERY holds: a stable wrapper over the
   *  current turn's `canUseTool`, because the worker's gate is bound to
   *  a claim token that dies with each turn while the query lives on. */
  const gate: SdkCanUseTool | undefined = ctx.turn.canUseTool
    ? (toolName, input, options) => {
        const current = bindings.current.canUseTool;
        if (!current) return Promise.resolve({ behavior: "allow" as const });
        return current(toolName, input, options);
      }
    : undefined;

  const telarTools = ctx.turn.sdk.tool ? toSdkTools(telarWall(() => bindings.current), ctx.turn.sdk.tool) : [];
  const telarServer =
    telarTools.length > 0 && ctx.turn.sdk.createSdkMcpServer
      ? { [TELAR_MCP_SERVER]: advertiseLeanSchemas(ctx.turn.sdk.createSdkMcpServer({ name: TELAR_MCP_SERVER, version: "2.0.0", tools: telarTools })) }
      : undefined;

  const telarBrowserServer = ctx.browserSocket
    ? {
        [TELAR_BROWSER_MCP_SERVER]: {
          type: "http" as const,
          url: ctx.browserSocket.url,
          headers: { Authorization: `Bearer ${ctx.browserSocket.token}` },
        },
      }
    : undefined;

  const mcpServers =
    ctx.turn.userServers || telarServer || telarBrowserServer
      ? { ...ctx.turn.userServers, ...telarBrowserServer, ...telarServer }
      : undefined;

  const feed = new MessageFeed();
  /** Ends the PROCESS, never a turn — aborted only by `destroy`. */
  const processController = new AbortController();
  const query = ctx.turn.sdk.query({
    prompt: ctx.turn.streaming
      ? (feed.stream() as AsyncIterable<SdkUserMessage>)
      : // THE KILL-SWITCH PATH KEEPS THE SYSTEM WRAPPER even though it
        (ctx.attachments?.length ?? 0) > 0 || ctx.notification
        ? singleUserMessage(claudeInitialContent(ctx.notification ? claudeNotificationContent(ctx.prompt, ctx.notification) : ctx.prompt, ctx.attachments ?? []))
        : ctx.prompt,
    options: {
      cwd: ctx.turn.cwd,
      permissionMode: "default",
      ...(ctx.turn.briefings.length
        ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: ctx.turn.briefings.join("\n\n") } }
        : {}),
      abortController: processController,
      includePartialMessages: true,
      forwardSubagentText: true,
      // Spare background tasks on a turn Stop, and get `stopTask` for the
      // per-task control the UI's "N tasks still working" chip needs.
      perTaskStopAffordance: true,
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.turn.sdkEffort ? { effort: ctx.turn.sdkEffort } : {}),
      ...(ctx.fastMode === undefined && ctx.ultracode === undefined
        ? {}
        : {
            settings: {
              ...(ctx.fastMode === undefined ? {} : { fastMode: ctx.fastMode }),
              ...(ctx.ultracode === undefined ? {} : { ultracode: ctx.ultracode }),
            },
          }),
      // COLD START ONLY. Continuity between turns is now the live
      // process's own; `resume` is what a NEW process uses to pick up a
      // conversation an old one carried.
      ...(ctx.providerSessionId ? { resume: ctx.providerSessionId } : {}),
      ...(gate ? { canUseTool: gate } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(ctx.turn.childEnv ? { env: ctx.turn.childEnv } : {}),
      // Part of the fingerprint: a CLI that upgraded itself between two
      // turns changes the resolved path, and the runtime is recreated.
      ...(ctx.turn.executable ? { pathToClaudeCodeExecutable: ctx.turn.executable } : {}),
    },
  }) as RuntimeQuery;

  const iterator = query[Symbol.asyncIterator]();

  return {
    sessionId: ctx.sessionId,
    fingerprint: ctx.turn.fingerprint,
    fingerprintDigests: ctx.turn.fingerprintDigests,
    feed,
    query,
    iterator,
    bindings,
    tasks: taskMemoryFrom((ctx.seededTasks ?? []).filter((seed) => !isTerminalTaskState(seed.state))),
    pendingStep: undefined,
    parked: [],
    idlePump: undefined,
    streamEnded: false,
    destroy: () => {
      feed.end();
      if (typeof query.close === "function") query.close();
      else processController.abort(new Error("the session runtime was destroyed"));
      void Promise.resolve()
        .then(() => iterator.return?.(undefined))
        .catch(() => undefined);
    },
    model: ctx.model,
    // A NEW PROCESS IS A NEW QUERY, so its running cost total starts
    // unknown — which is not the same as zero.
    costTotalUsd: undefined,
    busy: true,
    wakeActive: false,
    lastUsedAt: Date.now(),
    echoesUserMessageUuid: false,
    reportsSessionState: false,
  };
};

export function bindRuntime(ctx: RuntimeCtx) {
  return {
    buildRuntime: (...args: Rest<typeof buildRuntime>) => buildRuntime(ctx, ...args),
  };
}
