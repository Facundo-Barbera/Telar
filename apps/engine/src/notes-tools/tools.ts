/**
 * THE `notes` TOOLKIT — the project notebook as a tool wall.
 *
 * Modelled on `../sessions-tools/tools.ts` down to the
 * seams: a capability PORT, a wall built over it, `tool` arriving as an argument
 * so no test needs the provider SDK, and every rule about a note implemented
 * ONCE, in `../notes.ts`, rather than here.
 *
 * ── ONE WALL, TWO DOORS ─────────────────────────────────────────────────────
 * A Telar session gets these tools so an agent can read the project's notes when
 * asked; the user's own chat client gets THE SAME LIST over `/v2/notes/mcp`.
 * That symmetry is the feature, and `collectTools` is what makes it structural:
 * `test/notes-socket.test.ts` asserts the two lists are equal.
 *
 * ── THE ONE DELETE ON ANY TELAR WALL, AND ITS FENCE ─────────────────────────
 * `sessions-tools/tools.ts` refuses a delete on principle: an
 * agent that could delete could erase another agent's work, or a person's. This
 * wall carries one anyway, because the notebook has no retire to fall back on —
 * a project note is a scratchpad, and a strip whose job is to stay short cannot
 * accumulate tombstones. The fence is that `notes_delete` deletes only notes
 * whose `author` is `"session"`. An agent may clean up after agents; the user's
 * own notes are the user's, and the refusal says so in a sentence.
 *
 * ── NOTHING ACCEPT-SHAPED ───────────────────────────────────────────────────
 * INV-1 holds that no MCP surface exposes an accept-shaped tool. Writing a note
 * lands nothing: it changes no branch, queues no turn and finishes no work.
 */
import { z } from "zod";
import type { ProjectNote } from "@telar/engine-client";
import { err, failure, fillWithin, json, ok, type ToolFactory } from "../tool-kit";

/**
 * What the toolkit may do.
 *
 * EVERY MEMBER IS A THIN MIRROR of one store call, the same design
 * `SessionsCapability` states: validation lives in `../notes.ts`, so the wall
 * composes sentences and decides nothing. The port exists because there are two
 * deployments — the daemon's socket, which reaches the files directly, and the
 * worker, which only has an `EngineClient` — and both must land on one
 * implementation of every rule.
 */
export type NotesCapability = {
  /** Every project that could hold a notebook, so a client with a note in mind
   *  can find the id `notes_write` takes. */
  projects(): Promise<Array<{ id: string; name: string }>>;
  list(projectId: string): Promise<ProjectNote[]>;
  /** Across every notebook — a caller holding a note id has no reason to also
   *  hold the project it came from. `null` when nothing goes by it. */
  read(noteId: string): Promise<{ note: ProjectNote; projectId: string } | null>;
  create(projectId: string, input: { title: string; body: string; pinned?: boolean }): Promise<ProjectNote>;
  update(projectId: string, noteId: string, patch: { title?: string; body?: string; pinned?: boolean }): Promise<ProjectNote | null>;
  remove(projectId: string, noteId: string): Promise<boolean>;
  /**
   * THE PROJECT THIS TURN IS IN — present inside a session, ABSENT on the
   * outward socket, exactly as `SessionsCapability.self` is. It is what lets an
   * agent call `notes_list()` with no argument and mean "this project"; a chat
   * client has no project to default to and is asked for one by name.
   */
  self?: { projectId: string };
};

/** One note as the wall hands it over. The stamps' epoch halves ride along —
 *  an agent comparing two notes needs a number, not a weekday. */
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

/**
 * HOW MUCH OF A BODY A LISTING SHOWS — issue #515.
 *
 * 120 characters is enough to tell two notes apart and to recognise the one you
 * were looking for; it is deliberately not enough to work from, because a
 * notebook of thirty runbooks handed over whole is thirty runbooks spent out of
 * the caller's context to answer "which notes are there".
 */
const PREVIEW_CHARS = 120;

/**
 * AND THE LISTING ITSELF IS BOUNDED, because a preview per note is still a
 * per-note cost. A project that has accumulated 200 notes is a project that
 * used its notebook, and 200 previews is past the backstop in `tool-kit.ts` —
 * which clips characters, so the caller would get JSON with its tail cut off
 * rather than a short list. Pinned notes sort first, so the notes a person
 * wanted kept where they could see them are the notes that survive the bound.
 */
const LIST_LIMIT = 60;
const LIST_CHARS = 9_000;

/**
 * One note in a LISTING: what it is, whose it is, and enough of it to choose.
 *
 * `notes_list` used to carry every body, and its own description said so —
 * "Bodies ride along, so this is usually the only call you need." That was
 * true of a notebook with three notes in it and false of every larger one,
 * and the failure mode was silent: the answer looked complete because it was.
 * `bodyChars` is what makes the abridgement legible, and `notes_read` is one
 * call away.
 */
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

/** The projectId a tool call means: the one it named, else the turn's own. The
 *  refusal names both halves so a caller on the socket learns what to pass. */
function resolveProject(capability: NotesCapability, named: unknown): string | undefined {
  if (typeof named === "string" && named.trim()) return named.trim();
  return capability.self?.projectId;
}

const NO_PROJECT =
  "Name the project this note belongs to — `notes_projects` lists the ids. (Inside a Telar session the project is implied " +
  "and may be omitted; over the outward socket there is no session, so it cannot be.)";

export function notesTools(tool: ToolFactory, capability: NotesCapability): unknown[] {
  return [
    tool(
      "notes_projects",
      "Every project whose notebook you can read or write, with the id the other notes tools take. Read-only.",
      {},
      async () => {
        try {
          return json(await capability.projects());
        } catch (error) {
          return err(failure(error));
        }
      },
    ),

    tool(
      "notes_list",
      "A project's notebook — the notes kept beside the code so nobody is asked twice. Pinned first; titles and a " +
        "120-character preview, notes_read gives one whole.",
      { projectId: z.string().optional().describe("Omit inside a session for this one's.") },
      async (args) => {
        const projectId = resolveProject(capability, args.projectId);
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
                  ? `${rows.length} of ${notes.length} notes, pinned first. Read one whole with notes_read(noteId).`
                  : abridged > 0
                    ? `${abridged} of these are longer than the preview — read one whole with notes_read(noteId).`
                    : "Every body is short enough to be here in full.",
          });
        } catch (error) {
          return err(failure(error));
        }
      },
    ),

    tool(
      "notes_read",
      "One note in full, by id, from whichever project holds it — notes_list carries only a preview.",
      { noteId: z.string() },
      async (args) => {
        try {
          const found = await capability.read(String(args.noteId));
          if (!found) return err(`No note goes by "${String(args.noteId)}" in any project's notebook.`);
          return json(shape(found.note));
        } catch (error) {
          return err(failure(error));
        }
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
