/**
 * The Codex seam: one turn, one `codex app-server` subprocess, the SAME
 * normalized observations `./driver.ts` produces for Claude.
 *
 * THAT SAMENESS IS THE WHOLE POINT. The contract's item vocabulary is
 * provider-agnostic (`packages/engine-client/src/protocol/items.ts`), so a
 * Codex `commandExecution` and a Claude `Bash` must arrive as the same
 * `command_execution` row or the cockpit grows a second renderer, a second
 * approval card and a second definition of "what did this turn cost". A
 * provider driver is a leaf: it reports what it saw and owns no state.
 *
 * WHAT IT DOES NOT DO, deliberately, because the legacy bridge did and this engine
 * has nowhere to put it yet:
 *   - no dynamic tools. Telar's in-process tool namespaces do not exist in
 *     the engine, and declaring `dynamicTools: []` is WORSE than silence (see the
 *     omit-when-empty note on `threadParams`).
 *   - no on-demand compaction or rollback. Those are session operations, not
 *     turn operations, and `TurnDriver` runs turns.
 *   - NO CONTEXT-WINDOW OR FAST-MODE SWITCH. Both are Claude-side concepts —
 *     an Agent SDK `betas` flag and an inline `settings.fastMode` — and the
 *     app-server exposes no equivalent. `DriverRun` carries them and this driver
 *     ignores them; the cockpit only offers them on a Claude session.
 *
 * WHAT THIS FILE USED TO SAY IT COULD NOT DO, and how that was settled — twice,
 * because the first answer was also wrong.
 *
 * The header claimed user-configured MCP servers were unreachable: "the shape
 * its `thread/start` `config` overlay accepts for servers is not something this
 * driver can verify against anything. Guessing it would fail the whole turn on
 * an unknown key." Every clause was reasonable and the conclusion was false,
 * because nobody had asked the binary. `codex app-server generate-json-schema`
 * publishes the overlay, and a real MCP server driven through it starts and
 * lists its tools (`codexMcpServers` below).
 *
 * Then every injected tool came back "user rejected MCP tool call", and the
 * first fix was to pre-approve them all in the injected config. That worked and
 * was wrong for a better reason than it was right: it moved the decision out of
 * the engine, which everything else in this file exists to prevent. The actual
 * approval is `mcpServer/elicitation/request` — an MCP elicitation with the
 * approval in its `_meta` — found by running a turn and logging what the
 * app-server asked. It is answered through `onRequest` like every other one.
 *
 * The lesson is cheaper than either bug: the app-server ships its own schema
 * and will answer questions about itself, and a workaround that makes the
 * symptom go away is not evidence that the cause was understood.
 */
import crypto from "node:crypto";
import type { ItemDetail, ItemSeed, McpServer, RequestDecision, TurnAttachment, TurnObservation, UsageSnapshot } from "@telar/engine-client";
import { CodexAppServer, resolveCodexBinary, type CodexServerRequest } from "./codex/app-server";
import { codexApprovalRequest, codexItemDetail, codexItemFailed, codexItemStatus, codexPlanDetail, codexUsage, MCP_ELICITATION } from "./codex/items";
import type { DriverRun, DriverResult, TurnDriver } from "./driver";

/**
 * The posture a thread runs under.
 *
 * STRUCTURALLY IDENTICAL TO `codexThreadConfig()`'s return in
 * `packages/core/src/runtime-mode.ts`, and taken as a parameter rather than
 * derived here so that policy stays defined once. `apps/engine` does not depend
 * on `@telar/core`; a caller that does can pass `codexThreadConfig(mode)`
 * verbatim.
 */
export type CodexThreadConfig = {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalsReviewer: "user" | "auto_review";
};

export type CodexDriverOptions = {
  model?: string;
  /** Codex's reasoning effort. Omitted entirely when unset — the app-server has
   *  its own default and an invented one would silently override the model's. */
  effort?: string;
  serviceTier?: string;
  /** Overlaid on `process.env` for the subprocess. The child needs PATH and the
   *  Codex home like any other process; this is for tests and for an account's
   *  credentials once Telar has accounts. */
  env?: Record<string, string | undefined>;
  /** The seam for `codexExecutablePath()` from `@telar/core` — see
   *  `resolveCodexBinary`'s header for why it is not imported here. */
  resolveBin?: () => string;
  threadConfig?: CodexThreadConfig;
};

export const DEFAULT_CODEX_MODEL = "gpt-5.5";

/**
 * The posture used when the caller names none.
 *
 * DERIVED FROM WHETHER THERE IS A GATE AT ALL, which is the same signal
 * `./driver.ts` documents on `onRequest`: absent means "no gate", the
 * full-access shape, which is what the tests use. Present means the engine
 * wants to be asked — so Codex is told to ask about everything, and the
 * ENGINE's `autoResolution()` decides. Codex must never apply its own policy on
 * top of the engine's, because then two parties are deciding and only one of
 * them is recorded.
 */
function defaultThreadConfig(gated: boolean): CodexThreadConfig {
  return gated
    ? { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" }
    : { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" };
}

/**
 * `turn/start`'s input array.
 *
 * `text_elements: []` IS REQUIRED AND IS snake_case, alone among every field on
 * this wire. It is not a typo to be tidied: the app-server's `UserInput` schema
 * declares it, and a text item without it is rejected.
 */
export function codexTurnInput(prompt: string, attachments: TurnAttachment[] = []): Array<Record<string, unknown>> {
  /**
   * THE APP-SERVER TAKES A PATH FOR AN IMAGE, NOT BYTES. Its `UserInput` union
   * has a `localImage` arm carrying `path` — verified against the installed
   * binary's own schema strings rather than assumed — which suits this engine
   * exactly: the file is already on the same disk, written by the engine, so
   * there is nothing to inline.
   *
   * Everything else is named in the text with its path. Codex has a Read tool
   * and a file it can open is worth more than a copy it cannot re-read, which
   * is the same choice the Claude seam makes for non-images.
   */
  const images = attachments.filter((attachment) => attachment.mediaType.startsWith("image/"));
  const others = attachments.filter((attachment) => !attachment.mediaType.startsWith("image/"));
  const text =
    others.length === 0
      ? prompt
      : `${prompt}\n\nAttached files:\n${others.map((attachment) => `- ${attachment.name} (${attachment.mediaType}) at ${attachment.path}`).join("\n")}`;
  return [
    { type: "text", text, text_elements: [] },
    ...images.map((attachment) => ({ type: "localImage", path: attachment.path })),
  ];
}

/**
 * `turn/start` takes a richer sandbox policy than `thread/start`'s enum, and it
 * is the one that actually decides network access. Derived from the same
 * `sandbox` value so the two can never disagree.
 */
export function codexSandboxPolicy(sandbox: CodexThreadConfig["sandbox"], cwd: string): Record<string, unknown> {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

/**
 * The user's MCP servers in the shape `codex app-server` accepts.
 *
 * A TRANSLATION, NOT A PASS-THROUGH, exactly as `claudeMcpServers` is on the
 * other seam. Codex names its fields after `~/.codex/config.toml`'s own
 * `RawMcpServerConfig` — `url`, `http_headers`, `startup_timeout_sec` — and the
 * contract's `McpServerSpec` is deliberately not that shape.
 *
 * WHY THIS EXISTS NOW, having been documented as impossible: the file's header
 * used to say the overlay's shape "is not something this driver can verify
 * against anything. Guessing it would fail the whole turn on an unknown key."
 * That was an honest statement of what was known and it was wrong, and the way
 * it was found to be wrong is the point — the binary was asked instead of
 * reasoned about. `codex app-server generate-json-schema` publishes
 * `ThreadStartParams.config` as a free-form object, and driving a real MCP
 * server through it showed all four shapes reaching `ready` with their tools
 * listed under the thread:
 *
 *     stdio (command/args)         ready · tools=["ping"] · auth=unsupported
 *     http (url)                   ready · tools=["ping"] · auth=unsupported
 *     http + bearer_token_env_var  ready · tools=["ping"] · auth=bearerToken
 *     http + http_headers          ready · tools=["ping"] · auth=bearerToken
 *
 * THE OVERLAY TRAVELS ON STDIN, WHICH IS WHY HEADERS MAY GO IN IT. t3 code
 * injects its own browser-control server as `-c mcp_servers.t3-code.url=…` and
 * is then forced to pass the token as `bearer_token_env_var`, because an argv is
 * world-readable through `ps` to every process running as this user — including
 * the sandboxed shells of the agent sessions. `thread/start`'s `config` has no
 * such exposure, so a token can be sent directly and the transport keeps this
 * file's own rule: `codex app-server` is still spawned with exactly one
 * argument, forever.
 *
 * SSE IS SENT AS `url` TOO. Codex has one HTTP client and picks the transport
 * from what the server answers; there is no separate `sse` key to set, and
 * inventing one would be the unknown-key failure the old comment feared.
 */
export function codexMcpServers(servers: McpServer[] | undefined): Record<string, Record<string, unknown>> | undefined {
  if (!servers?.length) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    if (server.spec.transport === "stdio") {
      out[server.id] = {
        command: server.spec.command,
        ...(server.spec.args?.length ? { args: server.spec.args } : {}),
        ...(server.spec.env && Object.keys(server.spec.env).length > 0 ? { env: server.spec.env } : {}),
      };
      continue;
    }
    out[server.id] = {
      url: server.spec.url,
      ...(server.spec.headers && Object.keys(server.spec.headers).length > 0 ? { http_headers: server.spec.headers } : {}),
    };
  }
  return out;
}

/**
 * NO `default_tools_approval_mode`, AND THAT IS A REVERSAL WORTH RECORDING.
 *
 * The first version of this set `approve` on every injected server, because an
 * MCP tool call was ending every turn with "user rejected MCP tool call" and
 * pre-approving made it work. It did work, and it was wrong: it moved the
 * decision out of the engine and into Codex's config, which is the one thing
 * this driver's header says must never happen — two parties deciding, only one
 * of them recorded.
 *
 * The reason it looked necessary was that the approval had not been FOUND yet.
 * Codex asks through `mcpServer/elicitation/request` (see `mcpToolApproval` in
 * ./codex/items.ts), which the driver now answers through the engine's own
 * gate. `codex app-server` names the enum when it rejects a bad value —
 * `auto | prompt | writes | approve` — and the right choice among them is to
 * set none of them and let the client answer, which is also what t3 code does:
 * it never writes this key.
 */

const LEGACY_APPROVAL_METHODS = new Set(["execCommandApproval", "applyPatchApproval"]);

const dropUndefined = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Cancellation carried out of the readline callback, where nothing may throw.
 *  A method name no app-server message can collide with. */
const CANCEL_SENTINEL = "@telar/cancelled";

class CodexTurnCancelled extends Error {
  constructor() {
    super("The human cancelled this turn.");
    this.name = "CodexTurnCancelled";
  }
}

export function createCodexDriver(options: CodexDriverOptions = {}): TurnDriver {
  const resolveBin = options.resolveBin ?? resolveCodexBinary;

  return {
    async run({
      prompt,
      cwd,
      signal,
      model: turnModel,
      effort: turnEffort,
      attachments,
      providerSessionId,
      env: instanceEnv,
      mcpServers: userMcpServers,
      onObservations,
      onRequest,
    }: DriverRun): Promise<DriverResult> {
      /**
       * PER-TURN FIRST, then the driver's construction default, then Codex's.
       *
       * The session's choice is the most specific thing anyone said about this
       * turn, so it wins; `CodexDriverOptions.model` remains the deployment-wide
       * default for a worker started without one.
       */
      const model = turnModel ?? options.model ?? DEFAULT_CODEX_MODEL;
      const effort = turnEffort ?? options.effort;
      // Throws `ProviderUnavailableError` when Codex is not installed, BEFORE a
      // subprocess exists — a missing CLI must read as a missing CLI, not as an
      // app-server that exited with a null code.
      const bin = resolveBin();
      const threadConfig = options.threadConfig ?? defaultThreadConfig(Boolean(onRequest));
      /**
       * THE TURN'S INSTANCE WINS OVER THE DEPLOYMENT'S DEFAULT, the same
       * ordering `model` uses two lines up: `options.env` is what a worker was
       * started with, and `instanceEnv` is what the human configured for the
       * login this session actually runs as. `dropUndefined` is what makes a
       * scrub work — an owned variable patched to `undefined` is removed from
       * the child's environment rather than passed through as the string
       * "undefined".
       */
      const client = new CodexAppServer(bin, dropUndefined({ ...process.env, ...options.env, ...instanceEnv }));

      let finalText = "";
      let usage: UsageSnapshot | undefined;
      let cancelled = false;
      let rootThreadId = "";
      let rootTurnId = "";

      /** Rows keyed by Codex's item id, so a completion closes the row its
       *  start opened rather than opening a second one. */
      const open = new Map<string, { id: string; detail: ItemDetail }>();
      /** Rows already closed. Codex re-publishes some items as later snapshots
       *  (a collab tool call is touched again by every wait/send/close), and
       *  without this each snapshot would open and close a fresh duplicate row. */
      const closed = new Set<string>();
      /** Text accumulated per item from deltas. Kept per item, not per turn:
       *  it is both the double-count guard below and the only copy of a
       *  reasoning block's text, which Codex never sends as a whole. */
      const streamedText = new Map<string, string>();
      /** The turn's single plan row, updated in place across the turn. */
      let planItemId: string | undefined;

      const pending: TurnObservation[] = [];
      const emit = (observation: TurnObservation): void => void pending.push(observation);
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        await onObservations(pending.splice(0, pending.length));
      };

      const abort = () => client.kill();
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });

      /**
       * Answer one approval REQUEST, detached.
       *
       * DETACHED IS THE LOAD-BEARING WORD. This is started from the stdout
       * reader and never awaited there: a parked approval waits for a human,
       * and awaiting it inline would stall every line behind it — including
       * this same turn's text deltas, which is how the legacy bridge froze a
       * session that was still perfectly alive.
       */
      const answerApproval = async (request: CodexServerRequest): Promise<void> => {
        const approval = codexApprovalRequest(request.method, request.params);
        // Only reachable when `onServerRequest` below already matched.
        if (!approval || !onRequest) return;
        let decision: RequestDecision;
        try {
          decision = await onRequest(approval);
        } catch {
          // A gate that failed is a DECLINE, never a hang: the app-server has
          // no deadline on an unanswered request.
          decision = "decline";
        }
        // `acceptForSession` widens the SESSION's posture, which the engine
        // records itself (`RequestDecision` in the contract). Codex only needs
        // to hear yes about this call.
        const accepted = decision === "accept" || decision === "acceptForSession";
        // THREE ANSWER VOCABULARIES FOR ONE QUESTION, and none of them errors
        // when you use the wrong one — the app-server simply ignores a decision
        // it cannot read, which presents as a turn that hangs or silently
        // refuses. `accept`/`decline` under `decision` for the `item/*` pair,
        // `approved`/`denied` (ReviewDecision) for the legacy pair, and
        // `action` rather than `decision` for an MCP elicitation, whose shape
        // comes from MCP itself rather than from Codex.
        client.respond(
          request.id,
          request.method === MCP_ELICITATION
            ? { action: accepted ? "accept" : "decline", ...(accepted ? { content: {} } : {}) }
            : {
                decision: LEGACY_APPROVAL_METHODS.has(request.method)
                  ? accepted
                    ? "approved"
                    : "denied"
                  : accepted
                    ? "accept"
                    : "decline",
              },
        );
        if (decision === "cancel") {
          // `cancel` withdraws the WHOLE turn, not just this call. The decline
          // still goes out first — a subprocess torn down mid-answer leaves the
          // app-server waiting on a request that will never arrive — and the
          // withdrawal reaches the run loop as a sentinel rather than as a
          // kill, so the teardown stays in the one place that owns it.
          cancelled = true;
          client.notifications.push({ method: CANCEL_SENTINEL, params: {} });
        }
      };

      // Assigned BEFORE the first await, so no stdout line can be processed
      // against a client that cannot yet answer approvals.
      client.onServerRequest = (request) => {
        if (onRequest && codexApprovalRequest(request.method, request.params)) {
          void answerApproval(request);
          return true;
        }
        /**
         * AN ELICITATION WE CANNOT ANSWER IS DECLINED, NOT REFUSED.
         *
         * A `-32601` and a decline look the same to this process and are not
         * the same to Codex: it reads a refused REQUEST as a refused TOOL and
         * reports "user rejected MCP tool call", naming a user who was never
         * asked. That is exactly how the MCP gap presented before the approval
         * arm existed, so anything still reaching here — an ungated turn, a
         * server eliciting a form or a URL the engine has no answer for —
         * answers in the elicitation's own vocabulary instead.
         *
         * DECLINE RATHER THAN ACCEPT for the ungated case too: `onRequest`
         * being absent means there is no gate to consult, and inventing a yes
         * on behalf of an absent human is the one answer this engine never
         * gives (see `user_input` in the contract).
         */
        if (request.method === MCP_ELICITATION) {
          client.respond(request.id, { action: "decline" });
          return true;
        }
        return false;
      };

      const itemIdFor = (codexId: string): string => `item_${codexId}`;

      const refsFor = (codexId: string, threadId: string): ItemSeed["providerRefs"] => ({
        itemId: codexId,
        ...(rootTurnId ? { turnId: rootTurnId } : {}),
        // Only a CHILD thread's id says something the root refs do not. It is
        // how a sub-agent's rows can be re-filed once tasks exist.
        ...(threadId && threadId !== rootThreadId ? { sessionId: threadId } : {}),
      });

      /**
       * A sub-agent, in Codex, IS a child thread.
       *
       * There is no `task_started` notification to key off the way Claude has
       * one — the app-server simply starts emitting items under a threadId that
       * is not the root's. So the task is declared the first time such a thread
       * speaks, which is also the earliest moment anything is knowable about it.
       * Deriving the id from the thread id means every subsequent row files
       * itself with no lookup, exactly as `parent_tool_use_id` does for Claude.
       */
      const childTasks = new Set<string>();
      const taskIdForThread = (threadId: string): string | undefined =>
        threadId && rootThreadId && threadId !== rootThreadId ? `task_${threadId}` : undefined;

      const noteThread = (threadId: string): string | undefined => {
        const taskId = taskIdForThread(threadId);
        if (!taskId || childTasks.has(threadId)) return taskId;
        childTasks.add(threadId);
        // No title: Codex names its child threads nothing, and inventing one
        // ("Sub-agent 1") would read as provider-reported when it is not.
        emit({ kind: "task.started", task: { id: taskId, kind: "agent", state: "running", providerTaskId: threadId } });
        return taskId;
      };

      const closeThreadTask = (threadId: string, state: "completed" | "failed"): void => {
        const taskId = taskIdForThread(threadId);
        if (!taskId || !childTasks.delete(threadId)) return;
        emit({ kind: "task.completed", task: { id: taskId, kind: "agent", state, providerTaskId: threadId } });
      };

      /** Open a row for a Codex item if it has none yet. */
      const openItem = (threadId: string, codexId: string, detail: ItemDetail, title?: string): string => {
        const existing = open.get(codexId);
        if (existing) return existing.id;
        const id = itemIdFor(codexId);
        const taskId = noteThread(threadId);
        open.set(codexId, { id, detail });
        emit({
          kind: "item.started",
          item: {
            id,
            detail,
            ...(title ? { title } : {}),
            ...(taskId ? { taskId } : {}),
            providerRefs: refsFor(codexId, threadId),
          },
        });
        return id;
      };

      const handleItem = (threadId: string, raw: unknown, terminal: boolean): void => {
        const item = record(raw);
        const codexId = str(item.id);
        if (!codexId || closed.has(codexId)) return;
        const mapped = codexItemDetail(item);
        if (!mapped) return;

        if (!terminal) {
          openItem(threadId, codexId, mapped.detail, mapped.title);
          return;
        }

        // Some items are only ever seen once, at completion. Opening the row
        // here keeps the journal's started→completed pairing intact rather than
        // emitting a completion for a row nothing started.
        const id = openItem(threadId, codexId, mapped.detail, mapped.title);
        open.delete(codexId);
        closed.add(codexId);

        const status = codexItemStatus(item.status, "completed");
        let detail = mapped.detail;
        const streamed = streamedText.get(codexId);
        if (detail.type === "assistant_message") {
          // THE DOUBLE-COUNT GUARD. `agentMessage` re-sends its FULL text on
          // completion, so a turn that already streamed it as deltas must not
          // append it a second time — the same guard `./driver.ts` keeps
          // against Claude's repeated assistant envelope. A child thread's text
          // is never this turn's answer either.
          if (streamed === undefined && threadId === rootThreadId) finalText += detail.text;
          // A completion that arrived without its text would otherwise blank a
          // row the deltas already filled in.
          if (detail.text.length === 0 && streamed) detail = { type: "assistant_message", text: streamed };
        }
        // Reasoning text exists ONLY as deltas — the item carries none — so the
        // stored row would read empty without this.
        if (detail.type === "reasoning" && streamed) detail = { type: "reasoning", text: streamed };
        emit({
          kind: "item.completed",
          itemId: id,
          status: codexItemFailed(item, status) ? "failed" : status,
          detail,
        });
      };

      const handleDelta = (
        threadId: string,
        params: Record<string, unknown>,
        kind: "assistant" | "reasoning",
      ): void => {
        const codexId = str(params.itemId);
        const text = typeof params.delta === "string" ? params.delta : undefined;
        // A delta for a row that already closed has nowhere to land; opening a
        // second row for it would be worse than dropping it.
        if (!codexId || !text || closed.has(codexId)) return;
        const id = openItem(
          threadId,
          codexId,
          kind === "assistant" ? { type: "assistant_message", text: "" } : { type: "reasoning", text: "" },
        );
        streamedText.set(codexId, (streamedText.get(codexId) ?? "") + text);
        // Reasoning is NOT part of the turn's answer, and a child thread's text
        // is not this turn's answer either.
        if (kind === "assistant" && threadId === rootThreadId) finalText += text;
        emit({
          kind: "content.delta",
          itemId: id,
          stream: kind === "assistant" ? "assistant_text" : "reasoning_text",
          text,
        });
      };

      try {
        await client.request("initialize", {
          clientInfo: { name: "telar", title: "Telar", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        client.notify("initialized");

        /**
         * OMIT-WHEN-EMPTY IS PROTOCOL-SIGNIFICANT HERE. `dynamicTools`,
         * `developerInstructions` and `config` are absent rather than empty
         * because an explicit `dynamicTools: []` states "this client has no
         * tools", which is a different sentence from saying nothing — and a
         * resumed thread that says it LOSES the tools it started with. So
         * `config` carries `mcp_servers` only when there ARE servers: a session
         * with none must say nothing rather than declare an empty registry,
         * which would read as "forget the ones in config.toml".
         */
        const mcpServers = codexMcpServers(userMcpServers);
        const threadParams = {
          cwd,
          approvalPolicy: threadConfig.approvalPolicy,
          approvalsReviewer: threadConfig.approvalsReviewer,
          sandbox: threadConfig.sandbox,
          model,
          ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
          // OVERLAID ON `~/.codex/config.toml`, NOT REPLACING IT: a Codex user
          // keeps the servers they configured for the CLI and gains the ones
          // Telar knows about. A shared id means Telar's wins for this thread,
          // which is the same shadowing rule the two Telar scopes already use.
          ...(mcpServers ? { config: { mcp_servers: mcpServers } } : {}),
        };
        const thread = providerSessionId
          ? await client.request<{ thread?: { id?: string } }>("thread/resume", {
              threadId: providerSessionId,
              ...threadParams,
            })
          : await client.request<{ thread?: { id?: string } }>("thread/start", threadParams);
        // A resume that comes back without a thread id still resumed the thread
        // the engine named; falling back to it keeps continuity rather than
        // stranding the next turn with no cursor.
        rootThreadId = str(thread.thread?.id) ?? providerSessionId ?? "";
        if (!rootThreadId) throw new Error("codex app-server started no thread");

        const turn = await client.request<{ turn?: { id?: string } }>("turn/start", {
          threadId: rootThreadId,
          input: codexTurnInput(prompt, attachments ?? []),
          ...(effort ? { effort } : {}),
          model,
          approvalPolicy: threadConfig.approvalPolicy,
          approvalsReviewer: threadConfig.approvalsReviewer,
          sandboxPolicy: codexSandboxPolicy(threadConfig.sandbox, cwd),
          ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        });
        rootTurnId = str(turn.turn?.id) ?? "";

        for (;;) {
          const { value: notification, done } = await client.notifications.next();
          if (done) throw new Error("codex app-server closed the connection mid-turn");
          if (notification.method === CANCEL_SENTINEL) throw new CodexTurnCancelled();
          const params = notification.params;
          const threadId = str(params.threadId) ?? "";

          switch (notification.method) {
            case "item/started":
              handleItem(threadId, params.item, false);
              break;

            case "item/completed":
              handleItem(threadId, params.item, true);
              break;

            case "item/agentMessage/delta":
              handleDelta(threadId, params, "assistant");
              break;

            case "item/reasoning/textDelta":
              handleDelta(threadId, params, "reasoning");
              break;

            case "turn/plan/updated": {
              if (threadId !== rootThreadId) break;
              const detail = codexPlanDetail(params);
              if (!detail) break;
              // ONE ROW, UPDATED IN PLACE, which is what `plan` means in the
              // contract. The legacy bridge minted a fresh TodoWrite-shaped
              // tool call per update and left the transcript full of near-
              // identical checklists.
              if (planItemId) emit({ kind: "item.updated", item: { id: planItemId, detail } });
              else {
                planItemId = `item_plan_${crypto.randomUUID().replaceAll("-", "")}`;
                emit({ kind: "item.started", item: { id: planItemId, detail, title: "Plan" } });
              }
              break;
            }

            case "thread/tokenUsage/updated": {
              // GATED ON THE ROOT THREAD: a sub-agent's tokens are reported
              // against its own thread and adding them here would bill the
              // parent turn twice for the same work.
              if (threadId !== rootThreadId) break;
              const snapshot = codexUsage(params);
              if (!snapshot) break;
              usage = snapshot;
              // Emitted per update rather than once at the end so the cockpit's
              // context meter moves during a long turn.
              emit({ kind: "usage", usage: snapshot });
              break;
            }

            case "error": {
              const message = str(record(params.error).message) ?? "Codex reported an error";
              // A retryable error, or one belonging to a child thread, is a row
              // — not the end of the turn. Only the root thread's terminal
              // failure ends it.
              if (threadId === rootThreadId && params.willRetry !== true) throw new Error(message);
              const id = `item_error_${crypto.randomUUID().replaceAll("-", "")}`;
              const taskId = noteThread(threadId);
              emit({
                kind: "item.started",
                item: { id, detail: { type: "error", error: { message } }, ...(taskId ? { taskId } : {}) },
              });
              emit({ kind: "item.completed", itemId: id, status: "failed" });
              break;
            }

            case "turn/completed": {
              const turnRecord = record(params.turn);
              if (threadId !== rootThreadId) {
                // A sub-agent finishing. Not this turn finishing — but it is
                // the only signal that the child is done, and a task left
                // running makes the session claim it is still working forever.
                closeThreadTask(threadId, turnRecord.status === "failed" ? "failed" : "completed");
                break;
              }
              // A sub-agent's turn completing is not this turn completing.
              if (rootTurnId && str(turnRecord.id) && str(turnRecord.id) !== rootTurnId) break;
              if (turnRecord.status === "failed") {
                throw new Error(str(record(turnRecord.error).message) ?? "Codex turn failed");
              }
              // Rows the app-server never closed would sit spinning forever.
              for (const [, row] of open) emit({ kind: "item.completed", itemId: row.id, status: "failed" });
              open.clear();
              // Same for a child thread that never reported its own completion.
              for (const child of [...childTasks]) closeThreadTask(child, "failed");
              if (planItemId) emit({ kind: "item.completed", itemId: planItemId, status: "completed" });
              await flush();
              if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
              return {
                text: finalText,
                providerSessionId: rootThreadId,
                ...(usage ? { usage } : {}),
              };
            }

            default:
              // Everything else — thread/started (a documented duplicate of
              // thread/start's own response), turn/started, rate limits, MCP
              // startup status — is not this driver's concern.
              break;
          }
          // Per notification, not per batch: buffering streamed text until the
          // turn ends is not streaming.
          await flush();
        }
      } catch (error) {
        // A killed subprocess reports itself as an exit code, and an in-flight
        // request rejects with that same exit — neither of which is what
        // actually happened. Whatever the app-server said on its way out, an
        // aborted or withdrawn turn is reported as one.
        if (cancelled) throw new CodexTurnCancelled();
        if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        // ONE SUBPROCESS PER TURN, ALWAYS REAPED. `TurnDriver.run` is a promise
        // rather than a generator, so nothing else will do this for us and a
        // failed turn would otherwise leak an app-server per attempt.
        client.kill();
      }
    },
  };
}
