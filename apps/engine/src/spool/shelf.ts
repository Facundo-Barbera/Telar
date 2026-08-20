/**
 * THE SHELF — documents beside the items (`docs/spool-loops.md` §10.1).
 *
 * A subject holds NOTES: markdown documents with tags, written by the hand or
 * by an agent when asked. Knowledge that is not work stops wearing task
 * clothing — the "NO TOCAR #302/#304" guard note that squatted in unfiled as a
 * fake task since day one is exactly what this file exists for.
 *
 * ── ONE FILE, `spool/shelf.json`, AND WHY NOT PER-SUBJECT ───────────────────
 * Threads and looks live under `experts/<key>/` because they REQUIRE a subject
 * — a thread is a subject's open question by construction. A note does not: a
 * cross-subject note is an ordinary resting state, the same absence
 * `SpoolItem.project` blesses, so a per-subject layout would need a root
 * residual file anyway and membership would have two spellings. The registry
 * files that admit subjectless rows (`subjects.json`, `areas.json`) live whole
 * at the store root, and the shelf follows them.
 *
 * ── THE STORE'S TWO-VOCABULARY CONTRACT, AS EVERYWHERE ──────────────────────
 * Reads are tolerant per row (a hand-edit that breaks one note must not lose
 * the shelf); writes are loud, with sentences a human can act on.
 *
 * ── AUTHOR NEVER CHANGES; RETIREMENT DRAINS ─────────────────────────────────
 * `author` is provenance, stamped at creation and refused by name on the patch
 * path — an agent's note stays marked as an agent's after every edit. Retiring
 * marks the note with its reason and keeps it; nothing here deletes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SpoolNote, SPOOL_NOTE_SCHEMA_VERSION, type SpoolNoteAuthor } from "@telar/engine-client";
import { atomicWrite } from "../atomic";
import { assertTags, capturedLabel, type SpoolPaths } from "./store";
import { isAddressableKey } from "./subjects";

const SHELF_FILE = "shelf.json";

export function shelfPath(paths: SpoolPaths): string {
  return path.join(paths.root, SHELF_FILE);
}

const newNoteId = () => `n-${crypto.randomBytes(6).toString("hex")}`;

/**
 * TOLERANT PER ROW, exactly like `readSubjects` and for the same stated
 * reason: a human who hand-edits this file and breaks ONE note must not lose
 * the shelf. A row that cannot be made sense of is skipped; the rest survive.
 */
export function readShelf(paths: SpoolPaths): SpoolNote[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(shelfPath(paths), "utf8"));
  } catch {
    // Never written is the ordinary first-run state, not an error.
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const notes: SpoolNote[] = [];
  for (const row of raw) {
    const parsed = SpoolNote.safeParse(row);
    if (!parsed.success) continue;
    if (notes.some((n) => n.id === parsed.data.id)) continue;
    notes.push(parsed.data);
  }
  return notes;
}

export function writeShelf(paths: SpoolPaths, notes: SpoolNote[]): SpoolNote[] {
  const parsed = notes.map((n) => SpoolNote.parse(n));
  fs.mkdirSync(path.dirname(shelfPath(paths)), { recursive: true });
  atomicWrite(shelfPath(paths), parsed);
  return parsed;
}

export function getNote(paths: SpoolPaths, id: string): SpoolNote | null {
  return readShelf(paths).find((n) => n.id === id) ?? null;
}

/** The subject slice, retired notes included — dismissing drains, and a list
 *  that hid them would make retirement indistinguishable from deletion. */
export function listNotes(paths: SpoolPaths, subject?: string): SpoolNote[] {
  const notes = readShelf(paths);
  return subject === undefined ? notes : notes.filter((n) => n.subjectKey === subject);
}

export type NewSpoolNote = {
  title: string;
  body: string;
  tags?: string[];
  subjectKey?: string;
  /** Whose hand — stamped once, never patched. The human API defaults it to
   *  "you"; the tool wall's own code declares "session", exactly as items do. */
  author: SpoolNoteAuthor;
};

export function createNote(paths: SpoolPaths, input: NewSpoolNote, at: Date = new Date()): SpoolNote {
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new Error("A note needs a title — a few words naming what the knowledge is about.");
  }
  if (typeof input.body !== "string" || !input.body.trim()) {
    throw new Error("A note needs a body — the knowledge itself, as markdown. An empty note is not knowledge.");
  }
  if (input.subjectKey !== undefined && !isAddressableKey(input.subjectKey)) {
    throw new Error(
      `"${String(input.subjectKey)}" is not a subject name this store can address. A note files to a subject's own ` +
        "key — a plain slug — or to no subject at all, which is an ordinary resting state.",
    );
  }
  const stamp = { label: capturedLabel(at), at: at.getTime() };
  const tags = input.tags === undefined ? [] : assertTags(input.tags);
  const note = SpoolNote.parse({
    id: newNoteId(),
    ...(input.subjectKey ? { subjectKey: input.subjectKey } : {}),
    title: input.title.trim(),
    body: input.body,
    tags,
    created: stamp,
    updated: stamp,
    author: input.author,
    schemaVersion: SPOOL_NOTE_SCHEMA_VERSION,
  });
  writeShelf(paths, [...readShelf(paths), note]);
  return note;
}

/** What an edit may change. The EXCLUSIONS are the contract: `author` is
 *  provenance and never changes; `subjectKey`, `created` and `retired` have no
 *  patch path — re-filing knowledge is writing a new note beside the record. */
const NOTE_PATCHABLE = ["title", "body", "tags"] as const;

export type SpoolNotePatch = Partial<{ title: string; body: string; tags: string[] }>;

/**
 * Edit a note. `null` when nothing goes by the id; a forbidden key THROWS
 * rather than being silently dropped — the same runtime half `updateItem`
 * keeps, because a cast can get past what the type alone forbids.
 *
 * A RETIRED NOTE REFUSES EDITS. It is a record of what was known and why it
 * stopped mattering; rewriting it would be editing history. New knowledge is a
 * new note.
 */
export function updateNote(paths: SpoolPaths, id: string, patch: SpoolNotePatch, at: Date = new Date()): SpoolNote | null {
  const forbidden = Object.keys(patch).filter((k) => !(NOTE_PATCHABLE as readonly string[]).includes(k));
  if (forbidden.length > 0) {
    throw new Error(
      `updateNote cannot write ${forbidden.map((f) => `\`${f}\``).join(", ")}. ` +
        "`author` is provenance stamped at creation and never changes, and `subjectKey`, `created` and `retired` " +
        `have no patch path. Patch only: ${NOTE_PATCHABLE.join(", ")}.`,
    );
  }
  const notes = readShelf(paths);
  const found = notes.find((n) => n.id === id);
  if (!found) return null;
  if (found.retired) {
    throw new Error(
      `"${found.title}" is retired (${found.retired.reason}) and a retired note is a record, not a draft — ` +
        "write a new note instead of rewriting what was withdrawn.",
    );
  }
  if (patch.title !== undefined && !patch.title.trim()) {
    throw new Error("A note keeps a title — pass a few words, not a blank.");
  }
  if (patch.body !== undefined && !patch.body.trim()) {
    throw new Error("A note keeps a body — blanking it would be a delete path wearing an edit's name.");
  }
  const next = SpoolNote.parse({
    ...found,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.tags !== undefined ? { tags: assertTags(patch.tags) } : {}),
    updated: { label: capturedLabel(at), at: at.getTime() },
  });
  writeShelf(
    paths,
    notes.map((n) => (n.id === id ? next : n)),
  );
  return next;
}

/**
 * REWRITE A NOTE'S TAGS DIRECTLY — the one deliberate way around `updateNote`
 * (2026-08-18, `spool/tags.ts`'s tag rename). `updateNote`'s retired-note
 * refusal protects the note's WORDS: a retired note is a record of what was
 * known and why it stopped mattering, and rewriting `title`/`body` would be
 * editing history. A tag is not the note's words — it is index metadata that
 * happens to live in the same row — so renaming it is not the edit that law
 * exists to block. Skipping retired carriers instead would leave the tags
 * listing (which counts retired notes on purpose, same as `listNotes`) still
 * showing the OLD name forever, and a "rename" that cannot touch its only
 * carrier is not a rename at all. This writes `tags` and nothing else:
 * `title`, `body`, `retired`, `updated` all pass through byte-identical.
 */
export function rewriteNoteTags(paths: SpoolPaths, id: string, tags: string[]): SpoolNote | null {
  const notes = readShelf(paths);
  const found = notes.find((n) => n.id === id);
  if (!found) return null;
  const next = SpoolNote.parse({ ...found, tags });
  writeShelf(
    paths,
    notes.map((n) => (n.id === id ? next : n)),
  );
  return next;
}

/**
 * RETIRE — the drain verb. Marks the note with the reason and keeps it;
 * nothing deletes. The reason is REQUIRED: knowledge withdrawn silently is how
 * a shelf stops being trustworthy. Idempotent — re-retiring returns the first
 * retirement untouched, the same state stated twice.
 */
export function retireNote(paths: SpoolPaths, id: string, reason: string, at: Date = new Date()): SpoolNote | null {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) {
    throw new Error("Retiring a note records WHY it stopped mattering — say the reason, or leave the note standing.");
  }
  const notes = readShelf(paths);
  const found = notes.find((n) => n.id === id);
  if (!found) return null;
  if (found.retired) return found;
  const next = SpoolNote.parse({
    ...found,
    retired: { label: capturedLabel(at), at: at.getTime(), reason: trimmed },
  });
  writeShelf(
    paths,
    notes.map((n) => (n.id === id ? next : n)),
  );
  return next;
}
