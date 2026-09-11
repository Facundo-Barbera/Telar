/**
 * engine protocol v2 — THE PROJECT NOTEBOOK.
 *
 * A place to draw quick notes about a project: what the deploy incantation is,
 * what the reviewer keeps asking for, the three URLs you look up every time.
 * They hang off the PROJECT, so every session on it sees the same notebook, and
 * they are reachable from the composer's foot, from the `@` menu, and from the
 * user's other app over `/v2/notes/mcp`.
 *
 * ── MIRRORS `SpoolNote`, AND IS NOT IT ──────────────────────────────────────
 * Field for field where the two mean the same thing — `{label, at}` stamps, an
 * `author` stamped once and never patched — so a reader written against one
 * decodes the other. It is a DIFFERENT STORE for a different thing, and
 * `docs/design/project-notes.md` §6 states the boundary: the Spool's shelf is
 * knowledge ACROSS projects, kept forever with its provenance; this is one
 * repository's scratchpad, short-lived and deletable.
 *
 * `z.looseObject` on the note for the reason `spool.ts` states at length: a
 * strict nested shape silently DESTROYS an unknown key on the next update, and
 * a client one version behind is the ordinary case in this app, not an error.
 */
import { z } from "zod";

export const PROJECT_NOTE_SCHEMA_VERSION = 1;

/** Label plus epoch, the split `SpoolNoteStamp` already carries: the label is
 *  what a surface quotes; the number is what an agent compares. */
export const ProjectNoteStamp = z.looseObject({ label: z.string(), at: z.number() });
export type ProjectNoteStamp = z.infer<typeof ProjectNoteStamp>;

/**
 * WHOSE HAND WROTE IT. "you" is the person; "session" is any agent, which may
 * write only what it was asked to keep. NEVER changes on edit — a note an agent
 * wrote stays marked as an agent's after the user rewrites every word of it.
 *
 * NOT `{ sessionId }`, deliberately: the Spool already decided what provenance
 * on a note is spelled like, a second spelling is worse than a missing id, and a
 * session id would be a cross-reference this notebook cannot keep valid once the
 * session is archived.
 */
export const ProjectNoteAuthor = z.enum(["you", "session"]);
export type ProjectNoteAuthor = z.infer<typeof ProjectNoteAuthor>;

export const ProjectNote = z.looseObject({
  id: z.string(),
  /** The project this notebook belongs to. Never absent — unlike a spool note,
   *  which may float, a note with no project has no notebook to live in. */
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

/** The outward socket's connect card — where it listens, its dedicated secret
 *  (NOT the engine token) and the composed `claude mcp add` line. Same shape as
 *  the spool's and the sessions', because it is the same `connectCard`. */
export const NotesMcpInfo = z.object({ url: z.string(), secret: z.string(), addCommand: z.string() });
export type NotesMcpInfo = z.infer<typeof NotesMcpInfo>;
