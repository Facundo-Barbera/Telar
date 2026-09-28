import { z } from "zod";

export const PREPARED_PROMPT_SCHEMA_VERSION = 1;

/** Label plus epoch: the label is what a surface quotes, the number is what a
 *  sort compares. */
export const PreparedPromptStamp = z.looseObject({ label: z.string(), at: z.number() });
export type PreparedPromptStamp = z.infer<typeof PreparedPromptStamp>;

export const PreparedPromptAuthor = z.enum(["you", "session"]);
export type PreparedPromptAuthor = z.infer<typeof PreparedPromptAuthor>;

export const PreparedPromptImage = z.looseObject({
  name: z.string(),
  type: z.string(),
  dataUrl: z.string(),
});
export type PreparedPromptImage = z.infer<typeof PreparedPromptImage>;

export const PreparedPrompt = z.looseObject({
  id: z.string(),
  /** The project whose shelf holds it. Never absent — a prompt with no project
   *  has no shelf to sit on. */
  projectId: z.string(),
  sessionId: z.string().optional(),
  title: z.string(),
  /** The message itself, verbatim — what lands in the composer when it is
   *  recalled. The store never rewrites a body it did not receive. */
  text: z.string(),
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
