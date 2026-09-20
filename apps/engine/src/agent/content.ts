/**
 * WHAT THE ASSISTANT ACTUALLY SAID — from either shape a model answers in
 * (#571).
 *
 * ── THE ONE THING THE THREE ROUTES DO NOT AGREE ABOUT ───────────────────────
 * `./model.ts` builds a different client per route — `ChatOpenAI`,
 * `ChatAnthropic`, `ChatOpenAI` in its Responses mode — and hands every one of
 * them back as a `BaseChatModel`. That is what lets `./runtime.ts` be
 * route-blind, and it is very nearly complete: LangChain normalises `tool_calls`
 * and `usage_metadata` into identical objects on all three.
 *
 * `content` is the exception, and it does not announce itself. Measured, for
 * one answer that says "Looking." and calls a tool:
 *
 *   chat/completions  →  "Looking."                                  (a string)
 *   /messages         →  [{type:"text",text:"Looking."},
 *                         {type:"tool_use",id,name,input}]             (blocks)
 *   /responses        →  [{type:"text",text:"Looking.",
 *                          annotations:[]}]                            (blocks)
 *
 * So `typeof content === "string" ? content : ""` is not a type guard. It is a
 * route branch nobody wrote on purpose, and it was the shape of this read in
 * four places: the streamed delta, the `assistant_message` row, the turn's
 * answer, and the line a folded turn becomes. On the two new routes each one
 * silently produced an empty string or a JSON blob — a person watching a turn
 * would have seen the model say nothing, and found nothing in the transcript
 * afterwards.
 *
 * ── ITS OWN MODULE, RATHER THAN A HOME IN ONE OF THE FOUR ───────────────────
 * `runtime.ts` and `compact.ts` both need it and neither owns it, and putting
 * it in `model.ts` — where the shapes are chosen, which is the tempting answer
 * — would make the fold depend on the client factory and drag two provider
 * libraries into a module that is pure message arithmetic.
 *
 * ── TEXT BLOCKS ONLY, JOINED IN ORDER ───────────────────────────────────────
 * A `tool_use` block is the CALL, which `tool_calls` already carries in a shape
 * its readers handle properly; a `thinking` block is reasoning, which is not the
 * assistant's words to a person and has never been a transcript row. Both are
 * skipped rather than rendered. Anything else contributes NOTHING rather than a
 * guess: this answers what was SAID, and `[object Object]` in a speech bubble is
 * what inventing a string for an unknown block shape looks like.
 *
 * `agent-runtime-parity.test.ts` drives the whole runtime over all three shapes
 * and compares the answers to each other, which is the real proof; its last
 * test pins this function directly, including the cases no conversation
 * produces.
 */
export function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    if (typeof block !== "object" || block === null) continue;
    const row = block as { type?: unknown; text?: unknown };
    if (row.type === "text" && typeof row.text === "string") text += row.text;
  }
  return text;
}
