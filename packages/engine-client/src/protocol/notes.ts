import { z } from "zod";

export const PROJECT_NOTE_SCHEMA_VERSION = 1;

/** Label plus epoch: the label is what a surface quotes; the number is what an
 *  agent compares. */
export const ProjectNoteStamp = z.looseObject({ label: z.string(), at: z.number() });
export type ProjectNoteStamp = z.infer<typeof ProjectNoteStamp>;

export const ProjectNoteAuthor = z.enum(["you", "session"]);
export type ProjectNoteAuthor = z.infer<typeof ProjectNoteAuthor>;

export const ProjectNote = z.looseObject({
  id: z.string(),
  /** The project this notebook belongs to. Never absent — a note with no
   *  project has no notebook to live in. */
  projectId: z.string(),
  title: z.string(),
  /** Markdown, verbatim as written. The store never rewrites a body it did not
   *  receive — which is also what lets a reference carry it unchanged. */
  body: z.string(),
  /** Sorts to the top of the strip. The one piece of ordering a person sets
   *  without dragging, because "keep this one where I can see it" is the whole
   *  request and a drag order cannot express it durably. */
  pinned: z.boolean().optional(),
  /** The hand's own order within its band. Unranked sorts after every ranked
   *  one; never invented by the store. */
  order: z.number().optional(),
  created: ProjectNoteStamp,
  updated: ProjectNoteStamp,
  author: ProjectNoteAuthor,
  schemaVersion: z.number().default(PROJECT_NOTE_SCHEMA_VERSION),
});
export type ProjectNote = z.infer<typeof ProjectNote>;

export const NotesMcpInfo = z.object({ url: z.string(), secret: z.string(), addCommand: z.string() });
export type NotesMcpInfo = z.infer<typeof NotesMcpInfo>;
