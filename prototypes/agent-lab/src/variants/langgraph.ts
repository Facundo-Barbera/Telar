/**
 * VARIANT A — LANGGRAPH.JS.
 *
 * ── WHY A HAND-BUILT StateGraph AND NOT createReactAgent ────────────────────
 * Because the installed package says not to. `@langchain/langgraph@1.4.15`
 * ships `createReactAgent` with a deprecation on its own types:
 *
 *     @deprecated `CreateReactAgentParams` has been moved to the langchain
 *     package. Update your import to `import { CreateAgentParams } from
 *     "langchain";`
 *
 * — and LangChain's v1 migration guide says the same: the prebuilt is replaced
 * by `createAgent` in the `langchain` package. That leaves two honest readings
 * of "the LangGraph.js baseline" the issue asks for, and neither is the
 * deprecated prebuilt:
 *
 *   · `createAgent` from `langchain` — a different package from the two the
 *     issue names, and an AGENT ABSTRACTION with its own middleware system.
 *     That is the same shape of thing Deep Agents is, so making it the baseline
 *     would compare two agent frameworks and never measure the substrate.
 *   · A StateGraph over `@langchain/langgraph` + `@langchain/core` — the
 *     non-deprecated, in-scope API, and the one that shows what the framework
 *     itself provides before anybody's agent opinions are added.
 *
 * The second is what A is, so that B's wins (planning, summarisation, subagents,
 * skills) are measured against the substrate rather than against another
 * framework's defaults. `createAgent` is noted in the report as the third
 * option a real integration should weigh.
 *
 * ── THE TWO THINGS THIS GRAPH DOES THAT A PREBUILT WOULD NOT ────────────────
 * 1. APPROVAL IS A FIRST-CLASS PASS. Every gated call is interrupted BEFORE any
 *    effect in the same node runs — `interrupt()` propagates by throwing, so a
 *    node that ran one tool and then interrupted would lose that tool's state
 *    write and re-run it on resume. Two passes, approvals then effects, is what
 *    makes the gate safe rather than merely present.
 * 2. EFFECTS ARE LEDGERED IN STATE, so the ledger is checkpointed with the
 *    messages that produced it. A retry after a worker failure — scenario 6 —
 *    finds the send already recorded and returns the first answer instead of
 *    sending twice. This is "checkpoint-before-effect" done the only way a
 *    checkpointer can actually give you: the effect and its record commit
 *    together, and a crash between them replays the node rather than the send.
 */
import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { Annotation, END, MessagesAnnotation, START, StateGraph, interrupt } from "@langchain/langgraph";
import { createHash } from "node:crypto";
import type { Meter } from "../harness/meter";

/** The ledger's key for one effect, and the reason it is a hash rather than the
 *  arguments: a key is compared, never read, and a `sessions_send` argument is
 *  a whole message. */
export function effectKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 16)}`;
}

/**
 * WHICH CALLS THE HUMAN HAS TO SEE FIRST.
 *
 * `sessions_send` with `intent: task` is the issue's own example and the right
 * one: it is the call that puts another agent to work, which is the thing a
 * person would want to have agreed to. Reads are never gated — a gate on
 * `sessions_list` teaches a user to click through gates.
 */
export function defaultApprovalPolicy(call: ToolCall): boolean {
  if (call.name !== "sessions_send") return false;
  return (call.args as { intent?: unknown } | undefined)?.intent === "task";
}

/** Which calls must not happen twice. The two that LAND something. */
export function defaultIdempotencyPolicy(call: ToolCall): string | undefined {
  if (call.name === "sessions_send" || call.name === "sessions_create") return effectKey(call.name, call.args as Record<string, unknown>);
  return undefined;
}

/** What an interrupt hands the caller — enough to render an approval prompt
 *  without the caller having to re-derive which call it is about. */
export type ApprovalRequest = {
  type: "approval";
  tool: string;
  args: Record<string, unknown>;
  toolCallId: string;
  reason: string;
};

export type ApprovalDecision = "accept" | "decline";

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** The effect ledger: key → the tool answer that effect already produced. */
  effects: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
});

export type AgentStateType = typeof AgentState.State;

export type AgentOptions = {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  checkpointer: BaseCheckpointSaver;
  meter: Meter;
  systemPrompt?: string;
  approvalPolicy?: (call: ToolCall) => boolean;
  idempotencyPolicy?: (call: ToolCall) => string | undefined;
  /**
   * `"interrupt"` (default) is the current JS API: a dynamic `interrupt()`
   * inside the tools node, carrying the call it is about, resumed with
   * `new Command({ resume })`.
   *
   * `"interruptBefore"` is the static compile-time gate — the graph stops
   * BEFORE the whole tools node, with no payload about which call triggered it,
   * and is resumed by invoking with `null`. Kept because the issue asks for
   * both, and because the difference is evidence: see `REPORT.md`.
   */
  approvalMode?: "interrupt" | "interruptBefore";
  /** Ceiling on model↔tool laps, so a scripted loop cannot run forever. */
  recursionLimit?: number;
};

const DEFAULT_PROMPT =
  "You are Telar's built-in Agent. You have no project and no checkout of your own; Telar sessions are resources you " +
  "operate on through the sessions tools. Answer from tool results rather than memory, and say plainly when you have not " +
  "checked something.";

export type BuiltAgent = {
  graph: ReturnType<ReturnType<typeof buildGraph>["compile"]>;
  approvalMode: "interrupt" | "interruptBefore";
  recursionLimit: number;
};

function buildGraph(options: AgentOptions) {
  const approvalPolicy = options.approvalPolicy ?? defaultApprovalPolicy;
  const idempotencyPolicy = options.idempotencyPolicy ?? defaultIdempotencyPolicy;
  const byName = new Map(options.tools.map((one) => [one.name, one]));
  const system = new SystemMessage(options.systemPrompt ?? DEFAULT_PROMPT);

  const callModel = async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const bound = options.model.bindTools?.(options.tools) ?? options.model;
    const messages: BaseMessage[] = [system, ...state.messages];
    const answer = (await bound.invoke(messages)) as AIMessage;
    options.meter.recordModelCall({
      promptTokens: answer.usage_metadata?.input_tokens ?? 0,
      completionTokens: answer.usage_metadata?.output_tokens ?? 0,
      messages: messages.length,
    });
    return { messages: [answer] };
  };

  const callTools = async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    const calls = last?.tool_calls ?? [];
    if (calls.length === 0) return {};

    // PASS 1 — every approval, before any effect. `interrupt()` throws, and a
    // throw after a side effect is a side effect nobody recorded.
    const decisions = new Map<string, ApprovalDecision>();
    for (const call of calls) {
      if (!approvalPolicy(call)) continue;
      const request: ApprovalRequest = {
        type: "approval",
        tool: call.name,
        args: (call.args ?? {}) as Record<string, unknown>,
        toolCallId: call.id ?? "",
        reason: "This call puts another session to work. A person approves it, not the model.",
      };
      const decision = interrupt<ApprovalRequest, ApprovalDecision>(request);
      decisions.set(call.id ?? "", decision);
    }

    // PASS 2 — the effects, each recorded in the same state write as its answer.
    const messages: ToolMessage[] = [];
    const effects: Record<string, string> = {};
    for (const call of calls) {
      const id = call.id ?? "";
      if (approvalPolicy(call) && decisions.get(id) !== "accept") {
        messages.push(
          new ToolMessage({
            tool_call_id: id,
            name: call.name,
            content: "Declined by the person. Do not retry this call; tell them it was declined and ask what they want instead.",
          }),
        );
        continue;
      }
      const key = idempotencyPolicy(call);
      const already = key ? state.effects[key] : undefined;
      if (already !== undefined) {
        messages.push(
          new ToolMessage({
            tool_call_id: id,
            name: call.name,
            content: `${already}\n\n[this exact call was already made on this thread; the recorded answer is above and nothing was sent again]`,
          }),
        );
        continue;
      }
      const tool = byName.get(call.name);
      if (!tool) {
        messages.push(new ToolMessage({ tool_call_id: id, name: call.name, content: `No tool goes by "${call.name}".` }));
        continue;
      }
      const answer = (await tool.invoke(call)) as ToolMessage | string;
      const text = typeof answer === "string" ? answer : String(answer.content);
      if (key) effects[key] = text;
      messages.push(typeof answer === "string" ? new ToolMessage({ tool_call_id: id, name: call.name, content: answer }) : answer);
    }
    return { messages, effects };
  };

  const shouldContinue = (state: AgentStateType): typeof END | "tools" => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    return (last?.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  };

  return new StateGraph(AgentState)
    .addNode("model", callModel)
    .addNode("tools", callTools)
    .addEdge(START, "model")
    .addConditionalEdges("model", shouldContinue, ["tools", END])
    .addEdge("tools", "model");
}

export function buildAgent(options: AgentOptions): BuiltAgent {
  const approvalMode = options.approvalMode ?? "interrupt";
  const graph = buildGraph(options).compile({
    checkpointer: options.checkpointer,
    ...(approvalMode === "interruptBefore" ? { interruptBefore: ["tools" as const] } : {}),
  });
  return { graph, approvalMode, recursionLimit: options.recursionLimit ?? 24 };
}

/** The config every call on a thread carries. `thread_id` is also the
 *  `x-opencode-session` header on the live model — one conversation, one id. */
export function threadConfig(threadId: string, extra: Record<string, unknown> = {}) {
  return { configurable: { thread_id: threadId }, ...extra };
}

/** The assistant's last answer, for a scenario that only needs the text. */
export function finalText(state: { messages: BaseMessage[] }): string {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message.getType() !== "ai") continue;
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    if (content.trim()) return content;
  }
  return "";
}
