import { z } from "zod";
import type { PreparedPrompt } from "@telar/engine-client";
import { err, failure, fillWithin, json, ok, type ToolFactory } from "../agent-tools";

// Every member mirrors one store call; the rules live in `store.ts`, not in the wall.
export type PromptsCapability = {
  list(): Promise<PreparedPrompt[]>;
  create(input: { title: string; text: string; reason?: string; sessionId?: string }): Promise<PreparedPrompt>;
  remove(promptId: string): Promise<boolean>;
  self: { projectId: string; sessionId?: string };
};

const shape = (prompt: PreparedPrompt) => ({
  id: prompt.id,
  title: prompt.title,
  ...(prompt.reason ? { reason: prompt.reason } : {}),
  author: prompt.author,
  ...(prompt.sessionId ? { forThisSession: true } : {}),
  created: prompt.created,
  chars: prompt.text.length,
});

const PREVIEW_CHARS = 120;
const LIST_LIMIT = 50;
const LIST_CHARS = 9_000;

const listShape = (prompt: PreparedPrompt) => ({
  ...shape(prompt),
  preview: prompt.text.length <= PREVIEW_CHARS ? prompt.text : `${prompt.text.slice(0, PREVIEW_CHARS)}…`,
});

const DRAFT = `Put a prepared prompt in front of the human instead of acting on it yourself — it lands in their composer's stash, one keystroke from being sent, and NOTHING runs until they press it. Two uses: ending a turn by drafting the follow-up you would send next, and writing a prompt as the product when that is what you were asked for. Title it in a few words, give the message verbatim as \`text\`, and say in one line why you are offering it. Saying "you could ask me X next" in your answer instead leaves them to select, copy and paste it; this does not.`;

const LIST = `The prepared prompts on this project's shelf — yours and the person's own set-aside ones. Titles and a 120-character preview; promptId reads one whole.`;

const DROP = `Remove a prepared prompt an AGENT wrote; one the person set aside is theirs and this refuses it. Use it when a draft you offered is now wrong — a stale follow-up is worse than no follow-up, because it looks considered.`;

export function promptsTools(tool: ToolFactory, capability: PromptsCapability): unknown[] {
  type Reply = { content: unknown[]; isError?: boolean };
  const withPrompt = (handle: (found: PreparedPrompt) => Reply | Promise<Reply>) => async (args: Record<string, unknown>) => {
    const id = String(args.promptId);
    try {
      const found = (await capability.list()).find((prompt) => prompt.id === id);
      if (!found) return err(`No prepared prompt goes by "${id}" on this project's shelf.`);
      return await handle(found);
    } catch (error) {
      return err(failure(error));
    }
  };

  return [
    tool(
      "prompt_draft",
      DRAFT,
      {
        title: z.string().min(1).max(200).describe("A few words naming what it asks for. This is the row the human reads."),
        text: z.string().min(1).describe("The message itself, verbatim — exactly what would be sent if they press it."),
        reason: z.string().max(400).optional().describe("One line on why you are offering this. Shown under the title."),
        forThisSession: z
          .boolean()
          .optional()
          .describe(
            "Default true: a follow-up belongs in THIS conversation's composer. Pass false for a prompt written as a product, which every composer on the project should see.",
          ),
      },
      async (args) => {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const text = typeof args.text === "string" ? args.text : "";
        if (!title) return err("Name it — a few words saying what the prompt asks for.");
        if (!text.trim()) return err("A prepared prompt needs its text: the message that would be sent.");
        const scoped = args.forThisSession !== false;
        try {
          const created = await capability.create({
            title,
            text,
            ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim() } : {}),
            ...(scoped && capability.self.sessionId ? { sessionId: capability.self.sessionId } : {}),
          });
          return ok(
            `Drafted "${created.title}" onto ${scoped && created.sessionId ? "this session's" : "the project's"} prompt shelf. ` +
              "The human sees it in their composer and decides whether to send it; nothing is running, and you should not act on it yourself. " +
              `Its id is ${created.id} if you need to replace it.`,
          );
        } catch (error) {
          return err(failure(error));
        }
      },
    ),

    tool("prompt_list", LIST, { promptId: z.string().optional().describe("One prepared prompt in full.") }, async (args) => {
      if (typeof args.promptId === "string") return await withPrompt((found) => json({ ...shape(found), text: found.text }))(args);
      try {
        const prompts = await capability.list();
        const { rows } = fillWithin(prompts, listShape, { limit: LIST_LIMIT, chars: LIST_CHARS });
        return json({
          prompts: rows,
          count: prompts.length,
          ...(prompts.length > rows.length ? { notShown: prompts.length - rows.length } : {}),
          note:
            prompts.length === 0
              ? "Nothing is on this project's shelf."
              : "`author: \"you\"` is the person's own; `\"session\"` is an agent's. Only an agent's can be dropped.",
        });
      } catch (error) {
        return err(failure(error));
      }
    }),

    tool(
      "prompt_drop",
      DROP,
      { promptId: z.string() },
      withPrompt(async (found) => {
        if (found.author !== "session") {
          return err(
            `"${found.title}" was set aside by the person, and their own prompts are theirs to remove. ` +
              "Tell them it is there and let them drop it from the composer's stash.",
          );
        }
        await capability.remove(found.id);
        return ok(`Dropped "${found.title}".`);
      }),
    ),
  ];
}
