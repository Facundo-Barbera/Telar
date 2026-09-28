import { z } from "zod";

export const PROJECT_NOTE_SCHEMA_VERSION = 1;

const ProjectNoteStamp = z.looseObject({ label: z.string(), at: z.number() });

export const ProjectNoteAuthor = z.enum(["you", "session"]);
export type ProjectNoteAuthor = z.infer<typeof ProjectNoteAuthor>;

export const ProjectNote = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  body: z.string(),
  pinned: z.boolean().optional(),
  /** Unranked notes sort after every ranked one. */
  order: z.number().optional(),
  created: ProjectNoteStamp,
  updated: ProjectNoteStamp,
  author: ProjectNoteAuthor,
  schemaVersion: z.number().default(PROJECT_NOTE_SCHEMA_VERSION),
});
export type ProjectNote = z.infer<typeof ProjectNote>;

export type NotesMcpInfo = { url: string; secret: string; addCommand: string };
