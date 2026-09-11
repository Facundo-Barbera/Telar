"use client";

/**
 * THE QUICK EDITOR — a title, a markdown body, and nothing else.
 *
 * The user asked for "a place to draw quick notes of the project", and the word
 * that decides this component is QUICK: no toolbar, no tag field, no preview
 * pane, no save button as the primary gesture. Type and walk away.
 *
 * ── AUTOSAVE ON BLUR, AND ⌘S FOR THE IMPATIENT ──────────────────────────────
 * Blur is what actually happens: a person types the note, then clicks back into
 * the composer to use it. So blur commits. ⌘S commits and closes, because that
 * is the key everybody's hands already press and because the browser's Save
 * dialog must never open — `preventDefault` is the first statement in the
 * branch, the same rule the composer's own handler keeps.
 *
 * A DEBOUNCED TIMER IS DELIBERATELY NOT HERE. It would write a note four times
 * while a sentence was being typed, each write bumping `updated` and each one
 * reordering nothing but costing a request; and it would still need the blur
 * commit for the last keystroke. One commit per visit is the honest shape.
 *
 * ── A NEW NOTE IS NOT CREATED UNTIL IT HAS A TITLE ──────────────────────────
 * Opening "+" and pressing Escape must leave no trace. So the first commit is a
 * POST and every later one a PATCH, and a commit with a blank title is simply
 * not made — which is also why the engine allows an empty BODY: "type a title,
 * come back to it later" is the gesture, and a store that refused the half-
 * written note would lose the title the user just typed.
 */

import { useCallback, useRef, useState } from "react";
import { Loader2Icon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react";
import type { ProjectNote } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { announceProjectNotesChanged } from "@/lib/project-notes";
import { cn } from "@/lib/utils";

const api = createEngineApi();

export function ProjectNoteEditor({
  projectId,
  note,
  onClose,
}: {
  projectId: string;
  /** Absent for "+": the note is created on the first commit that has a title. */
  note?: ProjectNote;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [pinned, setPinned] = useState(Boolean(note?.pinned));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** The id this editor is writing to — the prop's, or the one the first POST
   *  minted. A ref rather than state: the next commit reads it, and a render is
   *  not what has to happen when it changes. */
  const id = useRef(note?.id);
  /** What the engine currently holds, so a blur that changed nothing is not a
   *  request. One string because the two fields commit together, and JSON
   *  because it is the one cheap encoding with no separator a note could
   *  contain. */
  const committed = (next: { title: string; body: string }) => JSON.stringify([next.title, next.body]);
  const saved = useRef(committed({ title: note?.title ?? "", body: note?.body ?? "" }));

  const commit = useCallback(
    async (next: { title: string; body: string }): Promise<boolean> => {
      const trimmed = next.title.trim();
      if (!trimmed) return false;
      if (committed({ title: trimmed, body: next.body }) === saved.current) return true;
      setSaving(true);
      setError(undefined);
      try {
        if (id.current) {
          await api.updateProjectNote(projectId, id.current, { title: trimmed, body: next.body });
        } else {
          const created = await api.createProjectNote(projectId, { title: trimmed, body: next.body, ...(pinned ? { pinned } : {}) });
          id.current = created.note.id;
        }
        saved.current = committed({ title: trimmed, body: next.body });
        announceProjectNotesChanged();
        return true;
      } catch (cause) {
        // THE ENGINE'S OWN SENTENCE, shown where it happened. A note that failed
        // to save must say so beside the text, not in a toast the user has
        // already walked away from.
        setError(cause instanceof Error ? cause.message : "The engine did not accept that.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [projectId, pinned],
  );

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);
    // An unsaved new note carries the pin into its POST rather than needing a
    // second request; an existing one flips now.
    if (!id.current) return;
    try {
      await api.pinProjectNote(projectId, id.current, next);
      announceProjectNotesChanged();
    } catch {
      setPinned(!next);
    }
  };

  const remove = async () => {
    if (!id.current) {
      onClose();
      return;
    }
    try {
      await api.deleteProjectNote(projectId, id.current);
      announceProjectNotesChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine did not accept that.");
    }
  };

  return (
    <div
      className="flex flex-col gap-1.5"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void commit({ title, body }).then((ok) => ok && onClose());
          return;
        }
        // Escape closes without committing what is on screen — but whatever was
        // already committed stays, because it was already saved.
        if (event.key === "Escape") onClose();
      }}
    >
      <input
        value={title}
        autoFocus={!note}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => void commit({ title, body })}
        placeholder="What is this about?"
        className="w-full rounded-md bg-transparent px-1.5 py-1 text-sm font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground"
      />
      <textarea
        value={body}
        autoFocus={Boolean(note)}
        onChange={(event) => setBody(event.target.value)}
        onBlur={() => void commit({ title, body })}
        placeholder="Markdown. Drag this note into the composer to hand it to an agent."
        rows={8}
        className="w-full resize-none rounded-md border border-border/60 bg-transparent px-2 py-1.5 font-mono text-xs leading-relaxed outline-none placeholder:font-sans placeholder:text-muted-foreground focus:border-ring"
      />
      {error && <p className="px-1.5 text-[0.6875rem] text-destructive">{error}</p>}
      <div className="flex items-center gap-1 border-t border-border/60 pt-1.5">
        <button
          type="button"
          onClick={() => void togglePin()}
          aria-label={pinned ? "Unpin" : "Pin to the front"}
          title={pinned ? "Unpin" : "Pin to the front"}
          className={cn(
            "flex size-6 items-center justify-center rounded-md transition-colors hover:bg-muted",
            pinned ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          aria-label="Delete this note"
          title="Delete this note"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2Icon className="size-3.5" />
        </button>
        <span className="ml-auto flex items-center gap-1.5 text-[0.625rem] text-muted-foreground">
          {saving && <Loader2Icon className="size-3 animate-spin" />}
          {/* WHO WROTE IT, when it was not the reader. Provenance is stamped
              once and never changes, so a note an agent kept stays marked as
              one — and that is worth a word in the only place it is edited. */}
          {note?.author === "session" ? "written by an agent · " : ""}
          {saving ? "Saving…" : "Saves when you click away · ⌘S"}
        </span>
      </div>
    </div>
  );
}
