import { z } from "zod";

export const PREPARED_PROMPT_SCHEMA_VERSION = 1;

const PreparedPromptStamp = z.looseObject({ label: z.string(), at: z.number() });

export const PreparedPromptAuthor = z.enum(["you", "session"]);
export type PreparedPromptAuthor = z.infer<typeof PreparedPromptAuthor>;

const PreparedPromptImage = z.looseObject({
  name: z.string(),
  type: z.string(),
  dataUrl: z.string(),
});

export const PreparedPrompt = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  sessionId: z.string().optional(),
  title: z.string(),
  text: z.string(),
  reason: z.string().optional(),
  images: z.array(PreparedPromptImage).optional(),
  created: PreparedPromptStamp,
  updated: PreparedPromptStamp,
  author: PreparedPromptAuthor,
  schemaVersion: z.number().default(PREPARED_PROMPT_SCHEMA_VERSION),
});
export type PreparedPrompt = z.infer<typeof PreparedPrompt>;
