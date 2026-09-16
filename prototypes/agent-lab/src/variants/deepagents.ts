/**
 * VARIANT B — DEEP AGENTS JS.
 *
 * Same walls, same model, same checkpointer as A. Only the framework differs,
 * which is the only way the win/loss table means anything.
 *
 * ── WHAT `createDeepAgent` WILL NOT LET YOU TURN OFF ────────────────────────
 * `FilesystemMiddleware` and `SubAgentMiddleware` are both in the package's own
 * `REQUIRED_MIDDLEWARE_NAMES` and throw if excluded. So a Telar Agent — which
 * has no project, no checkout and no cwd — is handed `ls`, `read_file`,
 * `write_file`, `edit_file`, `delete`, `glob`, `grep` and `task` whether it
 * wants them or not. `filesystem: "narrow"` shrinks that to the smallest set
 * the API permits (`read_file` is mandatory in an explicit allowlist, and
 * `task` survives `generalPurposeAgent: false` with no subagents). Both
 * settings are measured; see `deepagents-audit/FINDINGS-B.md` §2.
 *
 * ── TWO APPROVAL MODES, BECAUSE THE BUILT-IN ONE CANNOT EXPRESS OUR POLICY ──
 * `"builtin"` is `createDeepAgent({ interruptOn })` — the package's own gate.
 * It keys on the TOOL NAME only: `InterruptOnConfig` carries `allowedDecisions`
 * and a `description`, and nothing that sees the arguments. Telar's policy is
 * `sessions_send` *with `intent: "task"`* — a `report` is passive and must not
 * wake anybody. The built-in gate cannot say that, so in this mode a passive
 * report stops the graph too. That is not a bug in the package; it is the shape
 * of the feature, and it is a finding.
 *
 * `"policy"` is a `wrapToolCall` middleware that reproduces A's semantics
 * exactly — arg-aware gate, effects ledgered in checkpointed state, a replayed
 * call short-circuited before it reaches the wall and before it wakes anyone.
 * The scenarios run in this mode so that A and B are compared like for like.
 * The whole of it is ~70 lines below, and that is the honest measure of what
 * Deep Agents gives you for free here: nothing. The ledger and the arg-aware
 * gate are exactly as much work as they were in A.
 *
 * ── THE TRANSLATION LAYER ───────────────────────────────────────────────────
 * `drive()` and the seven scenarios speak A's `ApprovalRequest` /
 * `ApprovalDecision`. Deep Agents' HITL speaks `{actionRequests, reviewConfigs}`
 * and resumes with `{decisions: [{type: "approve"}]}`. `wrapGraph` translates
 * both directions so one driver runs both variants. It is thin, but it is real
 * integration cost and it is counted as such in the report.
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { Command, interrupt } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { createDeepAgent, createFilesystemMiddleware, createSubAgentMiddleware, createSummarizationMiddleware, StateBackend } from "deepagents";
import * as z from "zod";
import type { Meter } from "../harness/meter";
import {
  defaultApprovalPolicy,
  defaultIdempotencyPolicy,
  effectKey,
  type ApprovalDecision,
  type ApprovalRequest,
} from "./langgraph";

export { effectKey };

const DEFAULT_PROMPT =
  "You are Telar's built-in Agent. You have no project and no checkout of your own; Telar sessions are resources you " +
  "operate on through the sessions tools. Answer from tool results rather than memory, and say plainly when you have not " +
  "checked something.";

export type DeepApprovalMode = "policy" | "builtin";

export type DeepAgentOptions = {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  checkpointer: BaseCheckpointSaver;
  meter: Meter;
  systemPrompt?: string;
  approvalPolicy?: (call: ToolCall) => boolean;
  idempotencyPolicy?: (call: ToolCall) => string | undefined;
  /** See the header. `"policy"` matches A; `"builtin"` is the package's gate. */
  approvalMode?: DeepApprovalMode;
  /** `"default"` keeps all 8 injected tools; `"narrow"` cuts to the API floor. */
  filesystem?: "default" | "narrow";
  /** Opt in to `SummarizationMiddleware`'s thresholds being overridden, so
   *  scenario 7 can force a summary inside forty turns instead of at 170k. */
  summarizeAfterTokens?: number;
  recursionLimit?: number;
};

export type BuiltDeepAgent = {
  graph: { invoke(input: unknown, config?: unknown): Promise<any>; getState(config: unknown): Promise<any>; stream(input: unknown, config?: unknown): Promise<any> };
  approvalMode: DeepApprovalMode;
  recursionLimit: number;
  /** The tool names the model was actually shown, for the report's cost table. */
  injectedToolNames(): string[];
};

/**
 * THE GATE AND THE LEDGER, as one middleware.
 *
 * `wrapToolCall` runs per call with the state in hand, which is what makes both
 * halves possible: the ledger is read before the wall is reached, and the
 * interrupt is raised before any effect in this call. Unlike A's two-pass tools
 * node there is no ordering hazard to manage — each call is wrapped
 * individually, so an interrupt in one cannot lose another's state write.
 */
function policyMiddleware(options: {
  approvalPolicy: (call: ToolCall) => boolean;
  idempotencyPolicy: (call: ToolCall) => string | undefined;
}) {
  return createMiddleware({
    name: "TelarApprovalAndEffectLedger",
    stateSchema: z.object({
      effects: z.record(z.string(), z.string()).default({}),
    }),
    wrapToolCall: async (request: any, handler: any) => {
      const call = request.toolCall as ToolCall;
      const key = options.idempotencyPolicy(call);
      const ledger: Record<string, string> = request.state?.effects ?? {};

      // A replayed effect never reaches the wall and never asks again.
      if (key && ledger[key] !== undefined) {
        return new ToolMessage({
          tool_call_id: call.id ?? "",
          name: call.name,
          content: `${ledger[key]}\n\n[this exact call was already made on this thread; the recorded answer is above and nothing was sent again]`,
        });
      }

      if (options.approvalPolicy(call)) {
        const ask: ApprovalRequest = {
          type: "approval",
          tool: call.name,
          args: (call.args ?? {}) as Record<string, unknown>,
          toolCallId: call.id ?? "",
          reason: "This call puts another session to work. A person approves it, not the model.",
        };
        const decision = interrupt<ApprovalRequest, ApprovalDecision>(ask);
        if (decision !== "accept") {
          return new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content: "Declined by the person. Do not retry this call; tell them it was declined and ask what they want instead.",
          });
        }
      }

      const answer = await handler(request);
      if (!key) return answer;
      // The effect and its record commit in the same state write. `wrapToolCall`
      // may only return a ToolMessage or a Command, so the ledger entry has to
      // travel as a Command carrying the tool message alongside it.
      const text = typeof answer === "string" ? answer : String((answer as ToolMessage).content);
      const message =
        typeof answer === "string"
          ? new ToolMessage({ tool_call_id: call.id ?? "", name: call.name, content: answer })
          : (answer as ToolMessage);
      return new Command({ update: { messages: [message], effects: { [key]: text } } });
    },
  });
}

/** Counts model calls into the shared meter, so A and B are metered identically. */
function meterMiddleware(meter: Meter) {
  return createMiddleware({
    name: "TelarMeter",
    afterModel: async (state: any) => {
      const last = state.messages?.[state.messages.length - 1] as AIMessage | undefined;
      if (last?.getType?.() === "ai") {
        meter.recordModelCall({
          promptTokens: last.usage_metadata?.input_tokens ?? 0,
          completionTokens: last.usage_metadata?.output_tokens ?? 0,
          messages: state.messages.length,
        });
      }
      return undefined;
    },
  });
}

/** A's `ApprovalRequest` out of Deep Agents' HITL payload, for `"builtin"` mode. */
function toApprovalRequest(value: unknown): ApprovalRequest {
  const request = value as { actionRequests?: Array<{ name: string; args: Record<string, unknown>; description?: string }> };
  const action = request?.actionRequests?.[0];
  if (!action) return value as ApprovalRequest;
  return {
    type: "approval",
    tool: action.name,
    args: action.args ?? {},
    toolCallId: "",
    reason: action.description ?? "Deep Agents' built-in gate stopped this call.",
  };
}

/**
 * One graph surface both variants' scenarios can drive.
 *
 * In `"policy"` mode the interrupt payload is already A's shape and the resume
 * is already A's string, so this is a pass-through. In `"builtin"` mode it
 * translates: `{actionRequests…}` out, `{decisions:[{type:"approve"}]}` in.
 */
function wrapGraph(graph: any, mode: DeepApprovalMode): BuiltDeepAgent["graph"] {
  if (mode === "policy") return graph;
  return {
    stream: (input: unknown, config?: unknown) => graph.stream(translateResume(input), config),
    invoke: (input: unknown, config?: unknown) => graph.invoke(translateResume(input), config),
    getState: async (config: unknown) => {
      const state = await graph.getState(config);
      const tasks = (state.tasks ?? []).map((task: any) => ({
        ...task,
        interrupts: (task.interrupts ?? []).map((one: any) => ({ ...one, value: toApprovalRequest(one.value) })),
      }));
      return { ...state, tasks };
    },
  };
}

function translateResume(input: unknown): unknown {
  if (!(input instanceof Command)) return input;
  const resume = (input as { resume?: unknown }).resume;
  if (typeof resume !== "string") return input;
  return new Command({ resume: { decisions: [{ type: resume === "accept" ? "approve" : "reject" }] } });
}

export function buildDeepAgent(options: DeepAgentOptions): BuiltDeepAgent {
  const approvalMode = options.approvalMode ?? "policy";
  const approvalPolicy = options.approvalPolicy ?? defaultApprovalPolicy;
  const idempotencyPolicy = options.idempotencyPolicy ?? defaultIdempotencyPolicy;

  const middleware: unknown[] = [meterMiddleware(options.meter)];
  if (approvalMode === "policy") middleware.unshift(policyMiddleware({ approvalPolicy, idempotencyPolicy }));
  // The default trigger is 170k tokens for a model that declares no window,
  // which forty Telar-sized turns never reach. Overriding it is the only way
  // to observe the summariser actually running — and to find out whether the
  // approval state from turn 3 survives it.
  // `backend` is optional in the type but NOT in practice: without it the
  // middleware throws `undefined is not an object (evaluating 'backend.delete')`
  // inside `adaptBackendProtocol` — and only at the moment summarisation first
  // fires, which is deep in a long conversation rather than at construction.
  if (options.summarizeAfterTokens !== undefined) {
    middleware.unshift(
      createSummarizationMiddleware({
        backend: ((config: never) => new StateBackend(config)) as never,
        trigger: { type: "tokens", value: options.summarizeAfterTokens },
        keep: { type: "messages", value: 6 },
      }) as never,
    );
  }
  if (options.filesystem === "narrow") {
    middleware.unshift(
      createFilesystemMiddleware({ tools: ["read_file"] }) as never,
      createSubAgentMiddleware({ defaultModel: options.model as never, subagents: [], generalPurposeAgent: false }) as never,
    );
  }

  const graph = createDeepAgent({
    model: options.model as never,
    tools: options.tools as never,
    systemPrompt: options.systemPrompt ?? DEFAULT_PROMPT,
    checkpointer: options.checkpointer,
    middleware: middleware as never,
    ...(approvalMode === "builtin"
      ? { interruptOn: { sessions_send: { allowedDecisions: ["approve", "reject"] as const } } as never }
      : {}),
  }) as any;

  let shown: string[] = [];
  const model = options.model as { bindTools?: (tools: unknown[]) => unknown };
  const originalBind = model.bindTools?.bind(model);
  if (originalBind) {
    (model as { bindTools: (tools: unknown[]) => unknown }).bindTools = (tools: unknown[]) => {
      shown = (tools as Array<{ name?: string }>).map((one) => one.name ?? "(unnamed)");
      return originalBind(tools);
    };
  }

  return {
    graph: wrapGraph(graph, approvalMode),
    approvalMode,
    recursionLimit: options.recursionLimit ?? 24,
    injectedToolNames: () => shown,
  };
}

/** The config every call on a thread carries — same shape as A's. */
export function threadConfig(threadId: string, extra: Record<string, unknown> = {}) {
  return { configurable: { thread_id: threadId }, ...extra };
}

/** The assistant's last answer. Deep Agents keeps the same message list shape. */
export function finalText(state: { messages: BaseMessage[] }): string {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message.getType() !== "ai") continue;
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    if (content.trim()) return content;
  }
  return "";
}

export { HumanMessage, SystemMessage };
