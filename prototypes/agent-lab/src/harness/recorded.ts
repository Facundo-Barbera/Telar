/**
 * THE RECORDED MODEL — a chat model that replays a JSON fixture.
 *
 * Six of the seven scenarios must run offline, deterministically, in CI, and on
 * a machine with no OpenCode key. A fake model is how; the question is only
 * what it keys its answer on.
 *
 * ── THE CURSOR IS THE HISTORY, NOT A COUNTER ────────────────────────────────
 * It replies with step N where N is how many assistant messages are already in
 * the conversation it was handed. That is the one cursor that survives a
 * PROCESS RESTART — scenarios 1, 3 and 5 all resume a thread in a new process,
 * and an in-memory counter would restart at zero and replay the first answer
 * forever. It also survives a retry after a tool failure, which is scenario 6.
 *
 * ── THE TOKENS ARE ESTIMATED, AND SAY SO ────────────────────────────────────
 * A fixture has no provider to report usage, so prompt size is estimated at
 * four characters per token over the serialised messages. Scenario 7's question
 * is the SHAPE of the growth — does it bend, where, and is the approval state
 * still in the window — and an estimate that is monotone in the real thing
 * answers it. Every number this model produces is labelled `estimated: true`,
 * and the live scenarios report the provider's own counts beside them.
 */
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput, ToolDefinition } from "@langchain/core/language_models/base";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { Runnable } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";

export type RecordedToolCall = { name: string; args: Record<string, unknown>; id?: string };

export type RecordedStep = {
  /** What the assistant says. Streamed in words when the caller streams. */
  text?: string;
  /** What it asks for. An empty list (or absent) ends the agent loop. */
  toolCalls?: RecordedToolCall[];
  /** Provider-reported usage, when this step was captured from a live call. */
  usage?: { promptTokens: number; completionTokens: number };
};

export type RecordedScript = {
  name: string;
  steps: RecordedStep[];
  /** Used once the steps run out. A script that ends mid-loop would otherwise
   *  loop forever; this is the answer that always ends it. */
  fallback?: RecordedStep;
};

/** Four characters a token — the usual rough rule, and stated everywhere it is
 *  used so no number in the report reads as a provider's count. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The same estimate over a whole conversation — content plus the tool calls
 *  and results, because on this wall the results are most of the prompt. */
export function estimatePromptTokens(messages: BaseMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
    const calls = (message as AIMessage).tool_calls;
    if (calls?.length) chars += JSON.stringify(calls).length;
  }
  return Math.ceil(chars / 4);
}

export type RecordedChatModelParams = BaseChatModelParams & {
  script: RecordedScript;
  name?: string;
  /** Called on every reply, with the step index. Lets a scenario watch the
   *  model without wrapping it. */
  onReply?: (index: number, step: RecordedStep, messages: BaseMessage[]) => void;
};

export class RecordedChatModel extends BaseChatModel {
  private readonly script: RecordedScript;
  private readonly onReply?: (index: number, step: RecordedStep, messages: BaseMessage[]) => void;
  /** Bound for shape only — the script decides what is asked for. Kept so a
   *  scenario can assert the walls actually reached the model. */
  boundTools: Array<StructuredToolInterface | ToolDefinition> = [];
  readonly modelName: string;

  constructor(params: RecordedChatModelParams) {
    super(params);
    this.script = params.script;
    this.modelName = params.name ?? params.script.name;
    if (params.onReply) this.onReply = params.onReply;
  }

  _llmType(): string {
    return "telar-agent-lab-recorded";
  }

  override bindTools(tools: Array<StructuredToolInterface | ToolDefinition>): Runnable<BaseLanguageModelInput, AIMessageChunk> {
    this.boundTools = tools;
    return this as unknown as Runnable<BaseLanguageModelInput, AIMessageChunk>;
  }

  /** How many answers this conversation already holds — the step to play. */
  private cursor(messages: BaseMessage[]): number {
    return messages.filter((message) => message.getType() === "ai").length;
  }

  private step(messages: BaseMessage[]): { index: number; step: RecordedStep } {
    const index = this.cursor(messages);
    const step = this.script.steps[index] ?? this.script.fallback ?? { text: "(the recorded script ended here)" };
    return { index, step };
  }

  private usage(step: RecordedStep, messages: BaseMessage[]): { input_tokens: number; output_tokens: number; total_tokens: number } {
    const promptTokens = step.usage?.promptTokens ?? estimateTokens(JSON.stringify(messages.map((one) => [one.getType(), one.content, (one as AIMessage).tool_calls ?? []])));
    const completionTokens = step.usage?.completionTokens ?? estimateTokens(`${step.text ?? ""}${JSON.stringify(step.toolCalls ?? [])}`);
    return { input_tokens: promptTokens, output_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  }

  private message(step: RecordedStep, index: number, messages: BaseMessage[]): AIMessage {
    const usage = this.usage(step, messages);
    return new AIMessage({
      content: step.text ?? "",
      tool_calls: (step.toolCalls ?? []).map((call, position) => ({
        name: call.name,
        args: call.args,
        id: call.id ?? `call_${this.script.name}_${index}_${position}`,
        type: "tool_call" as const,
      })),
      usage_metadata: usage,
      response_metadata: { recorded: true, estimated: step.usage === undefined, step: index, model: this.modelName },
    });
  }

  async _generate(messages: BaseMessage[], _options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    const { index, step } = this.step(messages);
    this.onReply?.(index, step, messages);
    const message = this.message(step, index, messages);
    if (step.text) await runManager?.handleLLMNewToken(step.text);
    return {
      generations: [{ text: step.text ?? "", message }],
      llmOutput: { tokenUsage: { promptTokens: message.usage_metadata?.input_tokens ?? 0, completionTokens: message.usage_metadata?.output_tokens ?? 0 } },
    };
  }

  /** Streaming, in words — scenario 2 asserts that tokens arrive before the
   *  answer is complete, and one chunk carrying the whole string would pass a
   *  test about streaming without streaming anything. */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const { index, step } = this.step(messages);
    this.onReply?.(index, step, messages);
    const text = step.text ?? "";
    const pieces = text.length ? text.split(/(?<=\s)/) : [];
    for (const piece of pieces) {
      await runManager?.handleLLMNewToken(piece);
      yield new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) });
    }
    const final = this.message(step, index, messages);
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        content: "",
        tool_call_chunks: (final.tool_calls ?? []).map((call, position) => ({
          name: call.name,
          args: JSON.stringify(call.args),
          id: call.id,
          index: position,
          type: "tool_call_chunk" as const,
        })),
        usage_metadata: final.usage_metadata,
        response_metadata: final.response_metadata,
      }),
    });
  }
}
