/**
 * THE `prompt` TOOLKIT — an agent putting a prepared message in front of the
 * human INSTEAD of acting.
 *
 * Two cases, one verb. HANDOFF: a turn ends by drafting the turn that should
 * follow it — "here is the follow-up I'd send next; press it or edit it."
 * GENERATION: the prompt IS the product, because someone asked for one to be
 * written. Both put a named, unsent message on the project's shelf
 * (`../prompts.ts`), where the composer picks it up.
 *
 * ── WHY THIS IS NOT AN ANSWER ───────────────────────────────────────────────
 * An agent can always just SAY "you might want to ask me X next", and that
 * sentence dies in the transcript: to use it the human has to select it, copy
 * it, scroll back down and paste it. The tool exists to close that gap — the
 * text lands one keystroke from being sent, and the human's decision is reduced
 * to the only part that was ever theirs, which is whether to send it.
 *
 * ── AND WHY IT IS STILL NOT ACCEPT-SHAPED ───────────────────────────────────
 * INV-1: no MCP surface exposes an accept-shaped tool. Drafting lands nothing.
 * It queues no turn, starts no work and changes no branch — the prompt sits
 * there until a person presses it, which is exactly the boundary this tool is
 * built to respect rather than cross. An agent that could send its own next
 * prompt would be an agent with no human in the loop at all.
 *
 * ── THE FENCE ON DELETE, as on the notebook's ───────────────────────────────
 * `prompt_drop` removes only prompts whose `author` is `"session"`. An agent may
 * clean up after agents; a prompt the person set aside with ⌘S is theirs, and
 * the refusal says so in a sentence.
 *
 * Modelled on `../notes-tools/tools.ts` down to the seams: a capability PORT,
 * `tool` arriving as an argument so no test needs the provider SDK, and every
 * rule about a prompt implemented ONCE, in `../prompts.ts`, rather than here.
 */
import { z } from "zod";
import type { PreparedPrompt } from "@telar/engine-client";
import { err, failure, fillWithin, json, ok, type ToolFactory } from "../tool-kit";

/**
 * What the toolkit may do.
 *
 * EVERY MEMBER IS A THIN MIRROR of one store call — validation lives in
 * `../prompts.ts`, so the wall composes sentences and decides nothing. The port
 * exists because the worker reaches the shelf only through an `EngineClient`,
 * while a future in-daemon deployment would touch the files directly, and both
 * must land on one implementation of every rule.
 */
export type PromptsCapability = {
  /** The shelf this composer would offer: the project's own plus this session's.
   *  Filtered by `promptsForComposer`, never here. */
  list(): Promise<PreparedPrompt[]>;
  create(input: { title: string; text: string; reason?: string; sessionId?: string }): Promise<PreparedPrompt>;
  remove(promptId: string): Promise<boolean>;
  /**
   * WHERE THIS TURN IS. Both halves matter and they mean different things:
   * `projectId` is the shelf being written to, `sessionId` is the composer a
   * handoff belongs in. A toolkit with no session can still write a
   * project-wide prompt, which is the generation case.
   */
  self: { projectId: string; sessionId?: string };
};

/** One prompt as the wall hands it over. The stamps' epoch halves ride along —
 *  an agent comparing two prompts needs a number, not a weekday. */
const shape = (prompt: PreparedPrompt) => ({
  id: prompt.id,
  title: prompt.title,
  ...(prompt.reason ? { reason: prompt.reason } : {}),
  author: prompt.author,
  ...(prompt.sessionId ? { forThisSession: true } : {}),
  created: prompt.created,
  chars: prompt.text.length,
});

/**
 * HOW MUCH OF A PROMPT A LISTING SHOWS.
 *
 * The same 120 characters `notes_list` settled on, and the same judgement:
 * enough to tell two rows apart and recognise the one you meant, deliberately
 * not enough to work from. A shelf of thirty briefings handed over whole is
 * thirty briefings spent out of the caller's context to answer "what is here".
 */
const PREVIEW_CHARS = 120;
const LIST_LIMIT = 50;
const LIST_CHARS = 9_000;

const listShape = (prompt: PreparedPrompt) => ({
  ...shape(prompt),
  preview: prompt.text.length <= PREVIEW_CHARS ? prompt.text : `${prompt.text.slice(0, PREVIEW_CHARS)}…`,
});

const DRAFT = `Put a prepared prompt in front of the human instead of acting on it yourself — it lands in their composer's stash, one keystroke from being sent, and NOTHING runs until they press it. Two uses: ending a turn by drafting the follow-up you would send next, and writing a prompt as the product when that is what you were asked for. Title it in a few words, give the message verbatim as \`text\`, and say in one line why you are offering it. Saying "you could ask me X next" in your answer instead leaves them to select, copy and paste it; this does not.`;

const LIST = `The prepared prompts on this project's shelf — yours and the person's own set-aside ones. Titles and a 120-character preview; read one whole with prompt_read.`;

const READ = `One prepared prompt in full, by id — prompt_list carries only a preview.`;

const DROP = `Remove a prepared prompt an AGENT wrote; one the person set aside is theirs and this refuses it. Use it when a draft you offered is now wrong — a stale follow-up is worse than no follow-up, because it looks considered.`;

export function promptsTools(tool: ToolFactory, capability: PromptsCapability): unknown[] {
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
        // ABSENT MEANS THIS SESSION. The handoff case is the common one, and a
        // default that scattered every follow-up across the project's other
        // composers would make the tool worse than useless there.
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

    tool("prompt_list", LIST, {}, async () => {
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

    tool("prompt_read", READ, { promptId: z.string() }, async (args) => {
      const id = String(args.promptId);
      try {
        const found = (await capability.list()).find((prompt) => prompt.id === id);
        if (!found) return err(`No prepared prompt goes by "${id}" on this project's shelf.`);
        return json({ ...shape(found), text: found.text });
      } catch (error) {
        return err(failure(error));
      }
    }),

    tool("prompt_drop", DROP, { promptId: z.string() }, async (args) => {
      const id = String(args.promptId);
      try {
        const found = (await capability.list()).find((prompt) => prompt.id === id);
        if (!found) return err(`No prepared prompt goes by "${id}" on this project's shelf.`);
        if (found.author !== "session") {
          return err(
            `"${found.title}" was set aside by the person, and their own prompts are theirs to remove. ` +
              "Tell them it is there and let them drop it from the composer's stash.",
          );
        }
        await capability.remove(id);
        return ok(`Dropped "${found.title}".`);
      } catch (error) {
        return err(failure(error));
      }
    }),
  ];
}
