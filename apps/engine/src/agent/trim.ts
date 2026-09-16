/**
 * THE PRE-MODEL STEP: AS MUCH CONVERSATION AS FITS (#531).
 *
 * ── WHY THIS EXISTS AT ALL, WHEN THE FRAMEWORK IS THE RUNTIME ───────────────
 * Measured in `prototypes/agent-lab` across 40 turns: LangGraph manages no
 * context whatever, and the prompt NEVER FELL. `MessagesAnnotation` appends,
 * the checkpointer stores what it is given, and the prompt is whatever the
 * graph hands the model — linear until the provider refuses. That is not a
 * defect; the package is a runtime, not a context manager. It does mean the
 * trim `main-session/history.ts` already had is code to KEEP rather than
 * retire, which is what this file is.
 *
 * ── THE SAME RULES, ON THE FRAMEWORK'S MESSAGES INSTEAD OF THE TRANSCRIPT ───
 * `history.ts` rebuilt the conversation from the journal every turn, because
 * that driver had no provider-side memory and the transcript was the truth.
 * Here the conversation IS the checkpoint, so nothing is rebuilt — but the
 * three rules that made the trim safe are unchanged:
 *
 *   · A CHARACTER BUDGET, NOT A TOKEN COUNT. Tokens would need a tokenizer per
 *     model and the model is a setting that can name anything OpenCode Go
 *     serves. This is a BACKSTOP against sending a year of conversation, not an
 *     attempt to fill a window exactly.
 *   · NEWEST FIRST, AND A CONTIGUOUS TAIL. It stops at the first block that
 *     does not fit rather than skipping it to squeeze a smaller older one in: a
 *     history with a hole in the middle reads as a model that forgot one
 *     exchange and remembers the two around it.
 *   · A TOOL RESULT NEVER OUTLIVES ITS CALL. Every `tool` message must name a
 *     `tool_call_id` the assistant actually asked for; an orphan is a 400 from
 *     the API, not a slightly shorter history. So the unit is a BLOCK.
 *
 * ── WHAT IS DIFFERENT, AND IT IS ONE THING ──────────────────────────────────
 * The system prompt is not in the message list — the graph prepends it — so it
 * is charged against the budget by the caller passing its length, rather than
 * being a message this function has to promise never to drop.
 */
import type { AIMessage, BaseMessage } from "@langchain/core/messages";

/**
 * The default ceiling, in characters — `DEFAULT_HISTORY_BUDGET_CHARS`'s own
 * number and its own argument. 120k is roughly a 30k-token conversation:
 * comfortably inside anything this API serves, and far enough above an ordinary
 * coordinating conversation that the trim never fires in practice. Deliberately
 * not "as much as the model takes": the point is a bound that exists, not one
 * tuned to a model id a person can change in a text field.
 */
export const DEFAULT_AGENT_BUDGET_CHARS = 120_000;

/** What one message costs. The role and the JSON scaffolding are a rounding
 *  error next to the text, but counting them keeps the estimate on the safe
 *  side rather than the optimistic one. */
function costOf(message: BaseMessage): number {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  const calls = (message as AIMessage).tool_calls;
  return content.length + (calls ? JSON.stringify(calls).length : 0) + 32;
}

/** One indivisible run of messages: a plain message is a block of one, an
 *  assistant turn that asked for tools is that message plus every result that
 *  answers it. */
type Block = { messages: BaseMessage[]; cost: number };

/**
 * Group the list into blocks, oldest first.
 *
 * A `tool` MESSAGE WITH NO CALL ABOVE IT JOINS THE PREVIOUS BLOCK rather than
 * becoming one of its own. It should not happen — the graph writes both halves
 * in one state update — but a checkpoint written by an older build, or one
 * truncated by a crash, must not produce a block the trim can keep alone and
 * then 400 the API with.
 */
export function messageBlocks(messages: readonly BaseMessage[]): Block[] {
  const blocks: Block[] = [];
  for (const message of messages) {
    const isResult = message.getType() === "tool";
    const previous = blocks.at(-1);
    if (isResult && previous) {
      previous.messages.push(message);
      previous.cost += costOf(message);
      continue;
    }
    blocks.push({ messages: [message], cost: costOf(message) });
  }
  return blocks;
}

/**
 * The tail of the conversation that fits, in order.
 *
 * THE NEWEST BLOCK ALWAYS SURVIVES, whatever it costs. Dropping it means
 * answering a question nobody asked — `history.ts`'s rule about the current
 * turn, expressed as "the last block" because here the current turn is simply
 * the newest message rather than a separate argument.
 */
export function trimAgentMessages(
  messages: readonly BaseMessage[],
  options: { budgetChars?: number; reservedChars?: number } = {},
): BaseMessage[] {
  const budget = options.budgetChars ?? DEFAULT_AGENT_BUDGET_CHARS;
  const blocks = messageBlocks(messages);
  if (blocks.length === 0) return [];

  const kept: Block[] = [];
  let spent = options.reservedChars ?? 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (kept.length > 0 && spent + block.cost > budget) break;
    spent += block.cost;
    kept.push(block);
  }
  kept.reverse();
  return kept.flatMap((block) => block.messages);
}
