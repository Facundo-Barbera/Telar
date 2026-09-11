"use client";

/**
 * THE PROJECT'S NOTEBOOK, on the web side.
 *
 * `docs/design/project-notes.md` is the model. A note belongs to the project, so
 * every session on it draws the same strip, and this module is the one place
 * that reads them — the composer's foot, the `@` menu and the editor all go
 * through the hook below.
 *
 * ── ENGINE STATE, NOT LOCAL STORAGE — the argument `projects.ts` makes ───────
 * A per-browser copy would show two clients two different notebooks off one
 * engine, and the user's OTHER APP writes to the same file over
 * `/v2/notes/mcp`. So the engine is the source and the window event below is
 * only same-window propagation, exactly as `PROJECTS_CHANGED_EVENT` is.
 *
 * ── AND A RE-READ ON FOCUS, WHICH IS THE HONEST BOUND ───────────────────────
 * Nothing pushes a note written by the other app. A journal event would mean a
 * per-project subscription the composer does not have, so instead the strip
 * re-reads when the window is focused: a note written elsewhere appears when
 * you come back to this window, not within the second. That is a real bound and
 * it is stated rather than hidden behind a poll.
 */

import { useCallback, useEffect, useState } from "react";
import type { ProjectNote } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { noteReference } from "./drag-reference";
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from "./search-ranking";

const api = createEngineApi();

/** Same-window propagation. Carries no payload on purpose: the notebook is the
 *  engine's, so every listener re-reads the engine's own answer rather than
 *  trusting whatever a writer happened to hold. */
export const PROJECT_NOTES_CHANGED_EVENT = "telar:project-notes";
const CHANGED = PROJECT_NOTES_CHANGED_EVENT;

/** Say the notebook changed. Callers call this AFTER the engine accepted the
 *  write — the same discipline `announceProjectsChanged` keeps. */
export function announceProjectNotesChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

export type ProjectNotesHandle = {
  notes: ProjectNote[];
  /** True until the engine has answered once. Distinct from "no notes", which
   *  is the ordinary resting state of a project nobody has written about. */
  loading: boolean;
  reload: () => void;
};

/**
 * The project's notes, already ordered by the engine (pinned first, then the
 * hand's order) so nothing here re-sorts. `projectId` absent — a project-less
 * chat — is an empty notebook rather than a fetch of nothing.
 */
export function useProjectNotes(projectId?: string): ProjectNotesHandle {
  const [notes, setNotes] = useState<ProjectNote[]>([]);
  const [loading, setLoading] = useState(Boolean(projectId));

  const reload = useCallback(() => {
    if (!projectId) {
      setNotes([]);
      setLoading(false);
      return;
    }
    void api
      .projectNotes(projectId)
      .then((result) => setNotes(result.notes))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    // Deferred a tick: setting state from an effect BODY is the cascade the lint
    // rule forbids, and an async callback is not the effect body.
    const task = window.setTimeout(reload, 0);
    window.addEventListener(CHANGED, reload);
    window.addEventListener("focus", reload);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, reload);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);

  return { notes, loading, reload };
}

/* ------------------------------------------------------------------ *
 * `@` — notes beside paths.
 * ------------------------------------------------------------------ */

/** The shape `composer-completions.ts` speaks, restated structurally rather than
 *  imported as a type so this module owes that one nothing. */
export type NoteCompletion = {
  id: string;
  label: string;
  detail: string;
  glyph: "note";
  action: { type: "insert"; text: string };
};

/** The first line of a body, as the menu's muted half — it is what tells two
 *  notes with similar titles apart, and it is free. */
function preview(note: ProjectNote): string {
  const first = note.body.split("\n").find((line) => line.trim()) ?? "";
  const trimmed = first.replace(/^#+\s*/, "").trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

function completionForNote(note: ProjectNote): NoteCompletion {
  // The SAME constructor a drag from the strip uses, so a note typed and a note
  // dragged produce byte-identical text — the rule `completionForPath` keeps.
  return {
    id: `note:${note.id}`,
    label: note.title,
    detail: preview(note) || "project note",
    glyph: "note",
    action: { type: "insert", text: noteReference(note).text },
  };
}

/**
 * Rank the notebook against what has been typed after the `@`.
 *
 * SCORED AGAINST TITLE AND BODY, the better score winning, on the same reasoning
 * `rankPaths` gives for basename-and-path: people type the title, and they fall
 * back on a phrase they remember being IN the note. The body's bases start above
 * every title tier, so a body match can never outrank a real title match — the
 * tiering doing its job rather than a second sort.
 *
 * FUZZY ONLY ON THE TITLE. A subsequence match against a whole markdown document
 * matches essentially everything.
 *
 * AN EMPTY QUERY IS THE NOTEBOOK'S OWN ORDER — pinned first, which is the user
 * saying "keep this one where I can see it" and is exactly what a bare `@`
 * should surface.
 */
export function rankNotes(notes: readonly ProjectNote[], query: string, limit = 4): NoteCompletion[] {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return notes.slice(0, limit).map(completionForNote);

  const ranked: RankedSearchResult<ProjectNote>[] = [];
  for (const note of notes) {
    const scores = [
      scoreQueryMatch({
        value: note.title.toLowerCase(),
        query: normalized,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 8,
        includesBase: 16,
        fuzzyBase: 100,
        boundaryMarkers: [" ", "-", "_", "."],
      }),
      scoreQueryMatch({ value: note.body.toLowerCase(), query: normalized, exactBase: 40, includesBase: 44 }),
    ].filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    // A pinned note wins a tie: the pin is the only ordering signal the user
    // sets by hand, and ignoring it in the menu would make it mean less here
    // than it does two centimetres below in the strip.
    insertRankedSearchResult(ranked, { item: note, score: Math.min(...scores), tieBreaker: `${note.pinned ? 0 : 1} ${note.title}` }, limit);
  }
  return ranked.map((entry) => completionForNote(entry.item));
}
