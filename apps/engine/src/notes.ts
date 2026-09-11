/**
 * THE PROJECT NOTEBOOK — one JSON file per project, at the engine root.
 *
 * `docs/design/project-notes.md` is the model. A note belongs to a PROJECT, not
 * a session, so every session on it opens the same notebook and the user's other
 * app reads the same file over `/v2/notes/mcp`.
 *
 * ── A FREE-STANDING MODULE, AND THAT IS THE POINT ───────────────────────────
 * Nothing here imports `state.ts` except its PATH TYPE, and nothing in `state.ts`
 * imports this. The notebook's directory is derived from `paths.root` exactly as
 * `spool/shelf.ts` derives `shelf.json` from `SpoolPaths.root`, so adding this
 * feature adds ZERO lines to a 457 KB file two other branches are editing. The
 * daemon's routes call these functions directly with `store.paths`, having
 * already resolved the project through `store.getProject`.
 *
 * ── ONE FILE PER PROJECT, NOT ONE FOR ALL OF THEM ───────────────────────────
 * The shelf is a single `shelf.json` because a spool note may belong to no
 * subject at all, so a per-subject layout would need a root residual file
 * anyway. A project note ALWAYS has a project — `projectId` is required — so the
 * residual case does not exist, and per-project files mean unregistering one
 * project cannot rewrite another's notes.
 *
 * ── THE TWO-VOCABULARY CONTRACT, AS EVERYWHERE IN THIS TREE ─────────────────
 * Reads are tolerant per row: a hand-edit that breaks ONE note must not lose the
 * notebook. Writes are loud, with sentences a human can act on.
 *
 * ── DELETE IS A REAL DELETE, unlike the shelf's retire ──────────────────────
 * A shelf note is the record of what was known and why it stopped mattering. A
 * project note is a scratchpad, drawn quickly and thrown away, and a strip whose
 * whole job is to stay short cannot accumulate tombstones. The provenance that
 * survives here is `author`, which no patch may touch.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ProjectNote, PROJECT_NOTE_SCHEMA_VERSION, type ProjectNoteAuthor } from "@telar/engine-client";
import { atomicWrite } from "./atomic";
import type { EngineStatePaths } from "./state";

/** Thrown for every refusal. The daemon maps this to a 400/404 the same way it
 *  maps the spool's `Error`s — one shape of complaint, not two. */
export class ProjectNotesError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ProjectNotesError";
  }
}

export function notesDirectory(paths: EngineStatePaths): string {
  return path.join(paths.root, "notes");
}

/**
 * A project's file. The id is URL-SAFE-CHECKED rather than escaped: an id with a
 * separator in it would otherwise write outside the notebook directory, and this
 * is the one place a caller-supplied string becomes a path.
 */
export function notesPath(paths: EngineStatePaths, projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new ProjectNotesError("invalid_request", `"${projectId}" is not a project id this notebook can address.`);
  }
  return path.join(notesDirectory(paths), `${projectId}.json`);
}

const newNoteId = (): string => `n-${crypto.randomBytes(6).toString("hex")}`;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const two = (value: number): string => String(value).padStart(2, "0");

/** The display half of a stamp — the spelling `capturedLabel` uses in the spool,
 *  restated here rather than imported so this module owes the spool nothing. */
export function noteLabel(at: Date): string {
  return `${WEEKDAYS[at.getDay()]} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** Pinned first, then the hand's order, then newest — the order the strip draws
 *  and the order every list route answers in, so a client never re-sorts. */
export function sortNotes(notes: readonly ProjectNote[]): ProjectNote[] {
  return [...notes].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return right.created.at - left.created.at;
  });
}

/**
 * TOLERANT PER ROW, and an absent file is the ordinary first-run state rather
 * than an error: a project nobody has written a note about has an empty
 * notebook, which is a fact and not a failure.
 */
export function readNotes(paths: EngineStatePaths, projectId: string): ProjectNote[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(notesPath(paths, projectId), "utf8"));
  } catch (error) {
    if (error instanceof ProjectNotesError) throw error;
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const notes: ProjectNote[] = [];
  for (const row of raw) {
    const parsed = ProjectNote.safeParse(row);
    if (!parsed.success) continue;
    if (parsed.data.projectId !== projectId) continue;
    if (notes.some((note) => note.id === parsed.data.id)) continue;
    notes.push(parsed.data);
  }
  return sortNotes(notes);
}

export function writeNotes(paths: EngineStatePaths, projectId: string, notes: readonly ProjectNote[]): ProjectNote[] {
  const parsed = sortNotes(notes.map((note) => ProjectNote.parse(note)));
  atomicWrite(notesPath(paths, projectId), parsed);
  return parsed;
}

export function getNote(paths: EngineStatePaths, projectId: string, id: string): ProjectNote | null {
  return readNotes(paths, projectId).find((note) => note.id === id) ?? null;
}

/**
 * FIND A NOTE WITHOUT BEING TOLD ITS PROJECT — what the outward socket needs,
 * because a chat client holding a note id has no reason to also hold the project
 * it came from. Walks the notebook directory; every other read is keyed.
 */
export function findNote(paths: EngineStatePaths, id: string): { note: ProjectNote; projectId: string } | null {
  for (const projectId of notebookProjects(paths)) {
    const note = getNote(paths, projectId, id);
    if (note) return { note, projectId };
  }
  return null;
}

/** Which projects have a notebook on disk. Not the project registry — that is
 *  `store.listProjects`, and a project with no notes has no file here. */
export function notebookProjects(paths: EngineStatePaths): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(notesDirectory(paths));
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

/** The one size bound. Generous — a runbook is a legitimate note — and stated so
 *  the refusal is a sentence rather than a filesystem error four layers down. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;

export type NewProjectNote = {
  title: string;
  body: string;
  pinned?: boolean;
  /** Whose hand. The HTTP route defaults it to "you"; the tool wall's own code
   *  declares "session", exactly as the spool's notes do. */
  author: ProjectNoteAuthor;
};

function assertTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim()) {
    throw new ProjectNotesError("invalid_request", "A note needs a title — a few words naming what it is about.");
  }
  if (title.trim().length > MAX_TITLE_LENGTH) {
    throw new ProjectNotesError("invalid_request", `A note's title is a few words, not ${title.trim().length} characters.`);
  }
  return title.trim();
}

/**
 * AN EMPTY BODY IS ALLOWED, and that is the one place this deviates from the
 * shelf on purpose. `createNote` there refuses a blank because an empty note is
 * not knowledge; here the gesture is "+ , type a title, come back to it", and a
 * store that refused the half-written note would lose the title the user typed.
 */
function assertBody(body: unknown): string {
  if (typeof body !== "string") {
    throw new ProjectNotesError("invalid_request", "A note's body is markdown text — pass a string, even an empty one.");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new ProjectNotesError("invalid_request", `A note holds up to ${MAX_BODY_BYTES / 1024} KB of markdown; this one is larger.`);
  }
  return body;
}

export function createNote(paths: EngineStatePaths, projectId: string, input: NewProjectNote, at: Date = new Date()): ProjectNote {
  const stamp = { label: noteLabel(at), at: at.getTime() };
  const existing = readNotes(paths, projectId);
  const note = ProjectNote.parse({
    id: newNoteId(),
    projectId,
    title: assertTitle(input.title),
    body: assertBody(input.body),
    ...(input.pinned ? { pinned: true } : {}),
    // Newest lands at the FRONT of its band: a note just written is the one
    // about to be used, and making the user drag it there would be a chore the
    // gesture invented for itself.
    order: Math.min(0, ...existing.map((row) => row.order ?? 0)) - 1,
    created: stamp,
    updated: stamp,
    author: input.author,
    schemaVersion: PROJECT_NOTE_SCHEMA_VERSION,
  });
  writeNotes(paths, projectId, [...existing, note]);
  return note;
}

/** What an edit may change. The EXCLUSIONS are the contract: `author` is
 *  provenance stamped at creation, and `id`, `projectId` and `created` are
 *  identity — moving a note between projects is writing a new one. */
const PATCHABLE = ["title", "body", "pinned", "order"] as const;

export type ProjectNotePatch = Partial<{ title: string; body: string; pinned: boolean; order: number }>;

/**
 * Edit a note. `null` when nothing goes by the id; a forbidden key THROWS rather
 * than being silently dropped — the same runtime half `updateNote` keeps in the
 * shelf, because a cast gets past what the type alone forbids.
 */
export function updateNote(
  paths: EngineStatePaths,
  projectId: string,
  id: string,
  patch: ProjectNotePatch,
  at: Date = new Date(),
): ProjectNote | null {
  const forbidden = Object.keys(patch).filter((key) => !(PATCHABLE as readonly string[]).includes(key));
  if (forbidden.length > 0) {
    throw new ProjectNotesError(
      "invalid_request",
      `A note's ${forbidden.map((key) => `\`${key}\``).join(", ")} cannot be patched. ` +
        "`author` is provenance stamped at creation, and `id`, `projectId` and `created` are identity — " +
        `moving a note between projects is writing a new one. Patch only: ${PATCHABLE.join(", ")}.`,
    );
  }
  const notes = readNotes(paths, projectId);
  const found = notes.find((note) => note.id === id);
  if (!found) return null;
  if (patch.pinned !== undefined && typeof patch.pinned !== "boolean") {
    throw new ProjectNotesError("invalid_request", "pinned is true or false.");
  }
  if (patch.order !== undefined && !Number.isFinite(patch.order)) {
    throw new ProjectNotesError("invalid_request", "order is a number — it is the hand's own position, not a label.");
  }
  const next = ProjectNote.parse({
    ...found,
    ...(patch.title !== undefined ? { title: assertTitle(patch.title) } : {}),
    ...(patch.body !== undefined ? { body: assertBody(patch.body) } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(patch.order !== undefined ? { order: patch.order } : {}),
    updated: { label: noteLabel(at), at: at.getTime() },
  });
  writeNotes(
    paths,
    projectId,
    notes.map((note) => (note.id === id ? next : note)),
  );
  return next;
}

/** `false` when nothing goes by the id — deleting what is already gone is the
 *  same state stated twice, not an error worth a 404 on a retry. */
export function deleteNote(paths: EngineStatePaths, projectId: string, id: string): boolean {
  const notes = readNotes(paths, projectId);
  if (!notes.some((note) => note.id === id)) return false;
  writeNotes(
    paths,
    projectId,
    notes.filter((note) => note.id !== id),
  );
  return true;
}

/**
 * THERE IS NO `deleteNotebook`, and the absence is deliberate. Unregistering a
 * project KEEPS its record and is restorable — "same id, same settings, same
 * sessions" (`daemon.ts`'s DELETE) — so a notebook swept away on remove would be
 * the one thing restore could not give back.
 */
