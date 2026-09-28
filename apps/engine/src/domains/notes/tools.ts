import { z } from "zod";
import type { ProjectNote } from "@telar/engine-client";
import { err, failure, fillWithin, json, ok, type ToolFactory } from "../agent-tools";

export type NotesCapability = {
  projects(): Promise<Array<{ id: string; name: string }>>;
  list(projectId: string): Promise<ProjectNote[]>;
  read(noteId: string): Promise<{ note: ProjectNote; projectId: string } | null>;
  create(projectId: string, input: { title: string; body: string; pinned?: boolean }): Promise<ProjectNote>;
  update(projectId: string, noteId: string, patch: { title?: string; body?: string; pinned?: boolean }): Promise<ProjectNote | null>;
  remove(projectId: string, noteId: string): Promise<boolean>;
  self?: { projectId: string };
};

const shape = (note: ProjectNote) => ({
  id: note.id,
  projectId: note.projectId,
  title: note.title,
  body: note.body,
  ...(note.pinned ? { pinned: true } : {}),
  created: note.created,
  updated: note.updated,
  author: note.author,
});

const PREVIEW_CHARS = 120;

const LIST_LIMIT = 60;
const LIST_CHARS = 9_000;

const listShape = (note: ProjectNote) => ({
  id: note.id,
  title: note.title,
  ...(note.pinned ? { pinned: true } : {}),
  author: note.author,
  updated: note.updated.at,
  bodyChars: note.body.length,
  ...(note.body.length > 0
    ? { preview: note.body.length <= PREVIEW_CHARS ? note.body : `${note.body.slice(0, PREVIEW_CHARS)}…` }
    : {}),
});

function resolveProject(capability: NotesCapability, named: unknown): string | undefined {
  if (typeof named === "string" && named.trim()) return named.trim();
  return capability.self?.projectId;
}

const NO_PROJECT =
  "Name the project this note belongs to — `notes_list({ projects: true })` lists the ids. (Inside a Telar session the project is implied " +
  "and may be omitted; over the outward socket there is no session, so it cannot be.)";

async function listProjects(capability: NotesCapability) {
  try {
    return json(await capability.projects());
  } catch (error) {
    return err(failure(error));
  }
}

async function readNote(capability: NotesCapability, noteId: string) {
  try {
    const found = await capability.read(noteId);
    if (!found) return err(`No note goes by "${noteId}" in any project's notebook.`);
    return json(shape(found.note));
  } catch (error) {
    return err(failure(error));
  }
}

async function listNotes(capability: NotesCapability, named: unknown) {
  const projectId = resolveProject(capability, named);
  if (!projectId) return err(NO_PROJECT);
  try {
    const notes = await capability.list(projectId);
    const { rows } = fillWithin(notes, listShape, { limit: LIST_LIMIT, chars: LIST_CHARS });
    const abridged = notes.slice(0, rows.length).filter((note) => note.body.length > PREVIEW_CHARS).length;
    return json({
      notes: rows,
      count: notes.length,
      ...(notes.length > rows.length ? { notShown: notes.length - rows.length } : {}),
      note:
        notes.length === 0
          ? "This project's notebook is empty."
          : notes.length > rows.length
            ? `${rows.length} of ${notes.length} notes, pinned first. Read one whole with notes_list({ noteId }).`
            : abridged > 0
              ? `${abridged} of these are longer than the preview — read one whole with notes_list({ noteId }).`
              : "Every body is short enough to be here in full.",
    });
  } catch (error) {
    return err(failure(error));
  }
}

export function notesTools(tool: ToolFactory, capability: NotesCapability): unknown[] {
  return [
    tool(
      "notes_list",
      "A project's notebook — the notes kept beside the code so nobody is asked twice. Pinned first; titles and a " +
        "120-character preview. noteId reads one whole; projects lists the notebooks you can use.",
      {
        projectId: z.string().optional().describe("Omit inside a session for this one's."),
        noteId: z.string().optional().describe("One note in full, from whichever project holds it."),
        projects: z.boolean().optional().describe("List every project's id and name instead."),
      },
      async (args) => {
        if (typeof args.noteId === "string") return await readNote(capability, args.noteId);
        if (args.projects === true) return await listProjects(capability);
        return await listNotes(capability, args.projectId);
      },
    ),

    tool(
      "notes_write",
      "Write or edit a note in a project's notebook. Use it when the user ASKS you to keep something — not for scratch " +
        "notes and not to log what you just did. Stamped as an agent's, permanently.",
      {
        projectId: z.string().optional().describe("Omit inside a session for this one's."),
        title: z.string().optional().describe("A few words. Required for a new note."),
        body: z.string().optional().describe("Markdown; the user's own words."),
        pinned: z.boolean().optional().describe("Keep it at the top of the strip."),
        noteId: z.string().optional().describe("Edit this note instead of writing a new one."),
      },
      async (args) => {
        const projectId = resolveProject(capability, args.projectId);
        if (!projectId) return err(NO_PROJECT);
        const noteId = typeof args.noteId === "string" && args.noteId.trim() ? args.noteId.trim() : undefined;
        try {
          if (noteId) {
            const updated = await capability.update(projectId, noteId, {
              ...(args.title !== undefined ? { title: String(args.title) } : {}),
              ...(args.body !== undefined ? { body: String(args.body) } : {}),
              ...(args.pinned !== undefined ? { pinned: Boolean(args.pinned) } : {}),
            });
            if (!updated) return err(`No note goes by "${noteId}" in that project's notebook.`);
            return json(shape(updated));
          }
          if (typeof args.title !== "string" || !args.title.trim()) {
            return err("A new note needs a title — a few words naming what it is about.");
          }
          const created = await capability.create(projectId, {
            title: String(args.title),
            body: typeof args.body === "string" ? args.body : "",
            ...(args.pinned !== undefined ? { pinned: Boolean(args.pinned) } : {}),
          });
          return json(shape(created));
        } catch (error) {
          return err(failure(error));
        }
      },
    ),

    tool(
      "notes_delete",
      "Delete a note an AGENT wrote; one the user wrote is theirs and this refuses it. Deleting is real, not a retire. " +
        "Nothing else on this wall removes anything.",
      { noteId: z.string() },
      async (args) => {
        const id = String(args.noteId);
        try {
          const found = await capability.read(id);
          if (!found) return err(`No note goes by "${id}" in any project's notebook.`);
          if (found.note.author !== "session") {
            return err(
              `"${found.note.title}" was written by the user, and their own notes are theirs to remove. ` +
                "Tell them it is there and let them delete it from the notebook strip.",
            );
          }
          await capability.remove(found.projectId, id);
          return ok(`Deleted "${found.note.title}".`);
        } catch (error) {
          return err(failure(error));
        }
      },
    ),
  ];
}
