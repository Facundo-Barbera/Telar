/**
 * engine protocol v2 — PREPARED PROMPTS: unsent messages, kept by name.
 *
 * The thing #87 says both halves of prompt stashing need underneath: several
 * NAMED, UNSENT prompts, listed and recallable, that outlive the tab they were
 * written in. `apps/web/lib/composer-draft.ts` keeps ONE unsent string per
 * session in `localStorage` and stays exactly that — the safety net that stops a
 * reload eating what you typed. This is the shelf beside it.
 *
 * ── WHY THE ENGINE AND NOT THE BROWSER ──────────────────────────────────────
 * Because an AGENT writes to it. The handoff case — a worker ending its turn by
 * drafting the next one — happens in a process that has no `localStorage` and no
 * way into the cockpit's, and the composer has to see what it wrote. One store
 * either side can reach is the engine's, which is why this is a contract change
 * rather than a cockpit-only one.
 *
 * ── AND WHY `author` IS NOT DECORATION ──────────────────────────────────────
 * A prompt YOU set aside and a prompt an AGENT prepared carry different
 * authority: one is your own sentence handed back to you, the other is a
 * proposal you have not read yet. A single undifferentiated list quietly erases
 * that distinction, so the hand that wrote it is part of the record and the
 * cockpit draws the two bands apart. Same two words and the same reason as
 * `ProjectNoteAuthor`, stated here rather than imported so neither store owes
 * the other anything.
 *
 * `z.looseObject` throughout, for the reason the notebook gives: a strict nested
 * shape DESTROYS an unknown key on the next write, and a client one version
 * behind is the ordinary case in this app rather than an error.
 */
import { z } from "zod";

export const PREPARED_PROMPT_SCHEMA_VERSION = 1;

/** Label plus epoch: the label is what a surface quotes, the number is what a
 *  sort compares. */
export const PreparedPromptStamp = z.looseObject({ label: z.string(), at: z.number() });
export type PreparedPromptStamp = z.infer<typeof PreparedPromptStamp>;

/**
 * WHOSE HAND WROTE IT. "you" is the person; "session" is any agent.
 *
 * NEVER changes on edit — a prompt an agent drafted stays marked as an agent's
 * after you rewrite every word of it, because what the mark records is where the
 * sentence came from, not who touched it last. The moment it is SENT it stops
 * being a draft at all and becomes your message, which is the one transition
 * that does relabel it: sending is the act of adopting it.
 */
export const PreparedPromptAuthor = z.enum(["you", "session"]);
export type PreparedPromptAuthor = z.infer<typeof PreparedPromptAuthor>;

/**
 * A picture that travels with the prompt.
 *
 * NOTHING WRITES ONE YET, AND THE SHAPE IS HERE ANYWAY. The cockpit's own ⌘S
 * stash (`apps/web/lib/prompt-stash.ts`) already carries images as data URLs,
 * and whether that queue eventually moves onto this shelf is an open question.
 * A shelf that could only ever hold a bare string would DECIDE that question by
 * omission — the migration would need a schema change on top of everything else,
 * which is how "we'll do it later" becomes "we didn't". Declared optional, read
 * tolerantly, written by nobody today: the cost is four lines and the option
 * stays open.
 *
 * `dataUrl` rather than a path, for the reason the cockpit's queue uses one: the
 * image is pasted into a composer and has no file on disk to point at.
 */
export const PreparedPromptImage = z.looseObject({
  /** The name it was picked under. */
  name: z.string(),
  /** What it was encoded TO, never what came in. */
  type: z.string(),
  dataUrl: z.string(),
});
export type PreparedPromptImage = z.infer<typeof PreparedPromptImage>;

export const PreparedPrompt = z.looseObject({
  id: z.string(),
  /** The project whose shelf holds it. Never absent — a prompt with no project
   *  has no shelf to sit on. */
  projectId: z.string(),
  /**
   * The session it was prepared FOR, when it was prepared for one.
   *
   * PRESENT is the handoff case: an agent in this session drafting the turn it
   * would send next, which belongs in THAT composer and nowhere else. ABSENT is
   * the generation case — a prompt written as a product, for whichever
   * conversation you decide to spend it on — and those show on every composer in
   * the project.
   *
   * A session id that no longer resolves is not an error: the prompt simply
   * stops being offered anywhere, which is the right end for a follow-up to a
   * conversation that is over.
   */
  sessionId: z.string().optional(),
  /** The name it was put aside under. What a row shows; never the whole text. */
  title: z.string(),
  /** The message itself, verbatim — what lands in the composer when it is
   *  recalled. The store never rewrites a body it did not receive. */
  text: z.string(),
  /**
   * One line on why an agent is offering this, shown under the title.
   *
   * ONLY EVER AN AGENT'S. A prompt you stashed needs no explanation to you; a
   * prompt something else wrote does, and "here is the follow-up I'd send next"
   * is the difference between a row you trust and a row you delete unread.
   */
  reason: z.string().optional(),
  /** Pictures that belong with the text. Always absent today — see
   *  `PreparedPromptImage` for why the field exists before a writer does. */
  images: z.array(PreparedPromptImage).optional(),
  created: PreparedPromptStamp,
  updated: PreparedPromptStamp,
  author: PreparedPromptAuthor,
  schemaVersion: z.number().default(PREPARED_PROMPT_SCHEMA_VERSION),
});
export type PreparedPrompt = z.infer<typeof PreparedPrompt>;
