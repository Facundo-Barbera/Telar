"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2Icon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react";
import type { ProjectNote } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { announceProjectNotesChanged } from "../project-notes";
import { cn } from "@/lib/utils";

const api = createEngineApi();

export function ProjectNoteEditor({
  projectId,
  note,
  onClose,
}: {
  projectId: string;
  note?: ProjectNote;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [pinned, setPinned] = useState(Boolean(note?.pinned));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const id = useRef(note?.id);
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
      {error && <p className="px-1.5 text-2xs text-destructive">{error}</p>}
      <div className="flex items-center gap-1 border-t border-border/60 pt-1.5">
        <button
          type="button"
          onClick={() => void togglePin()}
          aria-label={pinned ? "Unpin" : "Pin to the front"}
          title={pinned ? "Unpin" : "Pin to the front"}
          className={cn(
            "flex size-6 items-center justify-center rounded-md transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
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
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2Icon className="size-3.5" />
        </button>
        <span className="ml-auto flex items-center gap-1.5 text-3xs text-muted-foreground">
          {saving && <Loader2Icon className="size-3 animate-spin" />}
          {note?.author === "session" ? "written by an agent · " : ""}
          {saving ? "Saving…" : "Saves when you click away · ⌘S"}
        </span>
      </div>
    </div>
  );
}
