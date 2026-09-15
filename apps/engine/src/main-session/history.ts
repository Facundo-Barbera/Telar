/**
 * THE CONVERSATION, REBUILT FROM THE TRANSCRIPT, EVERY TURN (#526).
 *
 * The other three drivers hand their provider a session id and let it remember;
 * this one has no provider-side session to resume, so what the model sees is
 * assembled here out of the rows the engine already wrote. That is a cost — a
 * full rebuild per turn — and it buys the property that matters most while this
 * loop is new: THE TRANSCRIPT IS THE TRUTH. There is no second copy of the
 * conversation to drift from what the person is reading.
 *
 * ── A CHARACTER BUDGET, NOT A TOKEN COUNT ───────────────────────────────────
 * Tokens would need a tokenizer per model, and the model is a setting that can
 * name anything OpenCode Go serves. Characters are a crude proxy and an honest
 * one: it is a BACKSTOP against sending a whole year of conversation, not an
 * attempt to fill a context window exactly. Compaction is explicitly out of
 * scope for #526, and when it arrives this is what it replaces.
 *
 * ── NEWEST FIRST, AND TWO THINGS ARE NEVER DROPPED ──────────────────────────
 * The system prompt survives because a model that forgot what it is would be
 * worse than one that forgot last Tuesday. The CURRENT turn survives because
 * dropping it means answering a question nobody asked. Everything between them
 * is kept from the newest backwards until the budget runs out.
 *
 * ── A TOOL RESULT NEVER OUTLIVES ITS CALL ───────────────────────────────────
 * The chat format requires every `tool` message to name a `tool_call_id` the
 * assistant actually asked for; an orphan is a 400 from the API, not a slightly
 * shorter history. So trimming works in BLOCKS — a call and its result are one
 * indivisible unit — rather than message by message.
 */
import type { Item } from "@telar/engine-client";

export type GoToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type GoMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: GoToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * The default ceiling, in characters.
 *
 * 120k is roughly a 30k-token conversation — comfortably inside anything this
 * API serves, and far enough above an ordinary coordinating session that the
 * trim never fires in practice. It is deliberately not "as much as the model
 * takes": the point is a bound that exists, not one tuned to a model id that
 * the person can change in a text field.
 */
export const DEFAULT_HISTORY_BUDGET_CHARS = 120_000;

/** What one message costs against the budget. The role and the JSON scaffolding
 *  are a rounding error next to the text, but counting them keeps the estimate
 *  on the safe side rather than the optimistic one. */
function costOf(message: GoMessage): number {
  return JSON.stringify(message).length;
}

/** Tool output as a string the chat format accepts. Already a string stays
 *  one — re-encoding it would double every quote in a diff. */
function toolContent(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Tool arguments as the chat format wants them: a JSON *string*, not an
 *  object. `{}` when there were none, because the field is required. */
function toolArguments(input: unknown): string {
  if (input === undefined) return "{}";
  try {
    return JSON.stringify(input) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * One indivisible run of messages. A plain message is a block of one; a tool
 * call and its result are a block of two, for the reason the header states.
 */
type Block = { messages: GoMessage[]; cost: number };

const blockOf = (messages: GoMessage[]): Block => ({ messages, cost: messages.reduce((sum, message) => sum + costOf(message), 0) });

/**
 * The transcript's rows as chat messages, oldest first.
 *
 * WHAT IS DELIBERATELY DROPPED. Reasoning rows (the model's own scratch, which
 * this API does not take back), plan rows, task rows, compaction markers, and
 * every row shaped like a provider event rather than a turn of conversation.
 * An error row is dropped too: the turn that produced it already ended, and
 * replaying an old failure as if the model had said it invites it to apologise
 * for something nobody asked about.
 *
 * A TOOL CALL WITH NO `toolUseId` IS DROPPED WHOLE, rather than sent with an
 * invented id. The id is what pairs a result to a call; making one up here
 * would pair a result to a call the model never made.
 */
export function transcriptMessages(items: readonly Item[]): GoMessage[][] {
  const ordered = [...items].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  const blocks: GoMessage[][] = [];
  for (const item of ordered) {
    const detail = item.detail;
    if (detail.type === "user_message") {
      // The NOTICE rather than the body when the engine wrote one: it is what
      // the provider was handed at the time, so the rebuilt history says what
      // the model actually saw rather than a fuller version of it.
      const text = detail.notice ?? detail.text;
      if (text.trim()) blocks.push([{ role: "user", content: text }]);
      continue;
    }
    if (detail.type === "assistant_message") {
      if (detail.text.trim()) blocks.push([{ role: "assistant", content: detail.text }]);
      continue;
    }
    if (detail.type === "mcp_tool_call" || detail.type === "dynamic_tool_call") {
      const call = detail.call;
      if (!call.toolUseId) continue;
      blocks.push([
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: call.toolUseId, type: "function", function: { name: call.name, arguments: toolArguments(call.input) } }],
        },
        { role: "tool", tool_call_id: call.toolUseId, content: toolContent(call.output) },
      ]);
    }
  }
  return blocks;
}

/**
 * The whole request body's messages: system, as much history as fits, then this
 * turn.
 *
 * `items` MAY INCLUDE THE CURRENT RUN'S OWN ROWS and must not be filtered by
 * the caller's memory of which those are — pass `currentRunId` and this drops
 * them, because the current turn is supplied as `prompt` and a conversation
 * that asked the same question twice is a conversation that answers itself.
 */
export function buildGoMessages(input: {
  system: string;
  items: readonly Item[];
  prompt: string;
  currentRunId?: string;
  budgetChars?: number;
}): GoMessage[] {
  const system: GoMessage = { role: "system", content: input.system };
  const current: GoMessage = { role: "user", content: input.prompt };
  const budget = input.budgetChars ?? DEFAULT_HISTORY_BUDGET_CHARS;
  const fixed = costOf(system) + costOf(current);

  const history = transcriptMessages(
    input.currentRunId === undefined ? input.items : input.items.filter((item) => item.runId !== input.currentRunId),
  ).map(blockOf);

  /**
   * NEWEST BACKWARDS, AND IT STOPS AT THE FIRST BLOCK THAT DOES NOT FIT rather
   * than skipping it to squeeze a smaller older one in. Keeping a contiguous
   * tail is what makes the history a conversation; a history with a hole in the
   * middle reads as a model that forgot one exchange and remembers the two
   * around it, which is worse than a shorter one.
   */
  const kept: Block[] = [];
  let spent = fixed;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const block = history[index]!;
    if (spent + block.cost > budget) break;
    spent += block.cost;
    kept.push(block);
  }
  kept.reverse();

  return [system, ...kept.flatMap((block) => block.messages), current];
}
