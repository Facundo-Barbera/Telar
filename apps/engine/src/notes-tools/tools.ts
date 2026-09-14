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
import { err, failure, json, ok, type ToolFactory } from "../tool-kit";

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
      "Every project whose notebook you can read or write, with the id the other notes tools take. Read-only; it changes " +
        "nothing. Use it first when you hold a project by NAME and need its id.",
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
      "The project's notebook — the quick notes kept beside the code: what the deploy incantation is, what the reviewer " +
        "keeps asking for, the decisions somebody wrote down so they would not be asked twice. Pinned first, then the " +
        "user's own order. Bodies ride along, so this is usually the only call you need. Inside a Telar session the " +
        "project is implied; omit it.",
      { projectId: z.string().optional().describe("Which project's notebook. Omit inside a session to read this one's.") },
      async (args) => {
        const projectId = resolveProject(capability, args.projectId);
        if (!projectId) return err(NO_PROJECT);
        try {
          return json((await capability.list(projectId)).map(shape));
        } catch (error) {
          return err(failure(error));
        }
      },
    ),

    tool(
      "notes_read",
      "One note in full, by id, from whichever project holds it. `notes_list` already carries bodies — reach for this when " +
        "you were handed a bare note id (a chat reference, an earlier tool result) and do not know its project.",
      { noteId: z.string().describe("The note id, as `notes_list` reports it.") },
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
      "Write a note into a project's notebook, or edit one you can already see. Use it when the user ASKS you to keep " +
        "something about this project — a command that works, a constraint, a decision — not for your own scratch notes " +
        "and not to log what you just did. The note is stamped as an agent's, permanently: that provenance never changes, " +
        "so a note you wrote stays marked as yours after the user rewrites every word of it. This is the project's own " +
        "notebook — the quick notes kept beside the code.",
      {
        projectId: z.string().optional().describe("Which project's notebook. Omit inside a session to write to this one's."),
        title: z.string().optional().describe("What the note is about, in a few words. Required for a new note."),
        body: z.string().optional().describe("The note itself, as markdown. The user's own words wherever possible."),
        pinned: z.boolean().optional().describe("Keep it at the top of the strip."),
        noteId: z.string().optional().describe("Edit this existing note instead of writing a new one."),
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
      "Delete a note an AGENT wrote. A note the user wrote is theirs and this refuses it — say so and let them delete it " +
        "from the strip, rather than asking another session to do it for you. Deleting is real here, not a retire: the " +
        "project notebook is a scratchpad, so tidying it up is ordinary. Nothing else on this wall removes anything.",
      { noteId: z.string().describe("The note id, as `notes_list` reports it.") },
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
