import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ProjectNote, PROJECT_NOTE_SCHEMA_VERSION, type ProjectNoteAuthor } from "@telar/engine-client";
import { atomicWrite } from "../../platform/fs/atomic";
import type { EngineStatePaths } from "../../platform/fs/state-paths";

export class ProjectNotesError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ProjectNotesError";
  }
}

function notesDirectory(paths: EngineStatePaths): string {
  return path.join(paths.root, "notes");
}

// The id check is what keeps a caller-supplied string inside the notebook directory.
export function notesPath(paths: EngineStatePaths, projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new ProjectNotesError("invalid_request", `"${projectId}" is not a project id this notebook can address.`);
  }
  return path.join(notesDirectory(paths), `${projectId}.json`);
}

const newNoteId = (): string => `n-${crypto.randomBytes(6).toString("hex")}`;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const two = (value: number): string => String(value).padStart(2, "0");

function noteLabel(at: Date): string {
  return `${WEEKDAYS[at.getDay()]} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

export function sortNotes(notes: readonly ProjectNote[]): ProjectNote[] {
  return [...notes].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return right.created.at - left.created.at;
  });
}

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

function writeNotes(paths: EngineStatePaths, projectId: string, notes: readonly ProjectNote[]): ProjectNote[] {
  const parsed = sortNotes(notes.map((note) => ProjectNote.parse(note)));
  atomicWrite(notesPath(paths, projectId), parsed);
  return parsed;
}

export function getNote(paths: EngineStatePaths, projectId: string, id: string): ProjectNote | null {
  return readNotes(paths, projectId).find((note) => note.id === id) ?? null;
}

export function findNote(paths: EngineStatePaths, id: string): { note: ProjectNote; projectId: string } | null {
  for (const projectId of notebookProjects(paths)) {
    const note = getNote(paths, projectId, id);
    if (note) return { note, projectId };
  }
  return null;
}

function notebookProjects(paths: EngineStatePaths): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(notesDirectory(paths));
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;

type NewProjectNote = {
  title: string;
  body: string;
  pinned?: boolean;
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
    order: Math.min(0, ...existing.map((row) => row.order ?? 0)) - 1,
    created: stamp,
    updated: stamp,
    author: input.author,
    schemaVersion: PROJECT_NOTE_SCHEMA_VERSION,
  });
  writeNotes(paths, projectId, [...existing, note]);
  return note;
}

const PATCHABLE = ["title", "body", "pinned", "order"] as const;

type ProjectNotePatch = Partial<{ title: string; body: string; pinned: boolean; order: number }>;

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

