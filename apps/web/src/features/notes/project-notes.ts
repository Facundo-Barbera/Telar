"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProjectNote } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { noteReference } from "@/lib/drag-reference";
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from "@/lib/search-ranking";

const api = createEngineApi();

const PROJECT_NOTES_CHANGED_EVENT = "telar:project-notes";
const CHANGED = PROJECT_NOTES_CHANGED_EVENT;

export function announceProjectNotesChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

export type ProjectNotesHandle = {
  notes: ProjectNote[];
  loading: boolean;
  reload: () => void;
};

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

export type NoteCompletion = {
  id: string;
  label: string;
  detail: string;
  glyph: "note";
  action: { type: "insert"; text: string };
};

function preview(note: ProjectNote): string {
  const first = note.body.split("\n").find((line) => line.trim()) ?? "";
  const trimmed = first.replace(/^#+\s*/, "").trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

function completionForNote(note: ProjectNote): NoteCompletion {
  return {
    id: `note:${note.id}`,
    label: note.title,
    detail: preview(note) || "project note",
    glyph: "note",
    action: { type: "insert", text: noteReference(note).text },
  };
}

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
    insertRankedSearchResult(ranked, { item: note, score: Math.min(...scores), tieBreaker: `${note.pinned ? 0 : 1} ${note.title}` }, limit);
  }
  return ranked.map((entry) => completionForNote(entry.item));
}
