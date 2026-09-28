"use client";

import { useState } from "react";
import { ClipboardListIcon, NotebookPenIcon, PinIcon, PlusIcon } from "lucide-react";
import type { ProjectNote } from "@telar/engine-client";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { noteReference, startReferenceDrag } from "@/features/composer";
import { useProjectNotes, ProjectNoteEditor } from "@/features/notes";

const SECTION_ROW_CAP = 5;

function SectionHeading({ label }: { label: string }) {
  return (
    <div className="flex items-center px-2 pb-1.5 pt-2 text-xs font-medium text-muted-foreground">
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function CappedRows({ rows, noun }: { rows: React.ReactNode[]; noun: string }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = rows.length - SECTION_ROW_CAP;
  const shown = expanded ? rows : rows.slice(0, SECTION_ROW_CAP);
  return (
    <div className="space-y-0.5">
      {shown}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="w-full rounded-md px-2 py-1 text-left text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {expanded ? `Show fewer ${noun}` : `${hidden} more ${noun}`}
        </button>
      )}
    </div>
  );
}

function firstLine(note: ProjectNote): string {
  const line = note.body.split("\n").find((text) => text.trim()) ?? "";
  return line.replace(/^#+\s*/, "").trim();
}

export function InspectorNotes({ projectId, notes }: { projectId: string; notes: readonly ProjectNote[] }) {
  const [editing, setEditing] = useState<string>();

  const editor = (key: string, note?: ProjectNote) => (
    <div key={key} className="rounded-xl bg-muted/40 p-1.5">
      <ProjectNoteEditor projectId={projectId} {...(note ? { note } : {})} onClose={() => setEditing(undefined)} />
    </div>
  );

  const rows = notes.map((note) => {
    if (editing === note.id) return editor(note.id, note);
    const detail = firstLine(note);
    return (
      <button
        key={note.id}
        type="button"
        draggable
        title={note.title}
        onDragStart={(event) => startReferenceDrag(event.dataTransfer, noteReference(note))}
        onClick={() => setEditing(note.id)}
        className="flex min-h-9 w-full cursor-grab items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors hover:bg-muted/70 active:cursor-grabbing"
      >
        {note.pinned ? (
          <PinIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <NotebookPenIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{note.title}</span>
        {detail ? <span className="min-w-0 max-w-[52%] truncate text-xs text-muted-foreground">{detail}</span> : null}
      </button>
    );
  });

  return (
    <>
      <SectionHeading label="Notes" />
      <CappedRows noun="notes" rows={rows} />
      {editing === "new" ? (
        editor("new")
      ) : (
        <button
          type="button"
          aria-label="New note"
          title="Write a note about this project"
          onClick={() => setEditing("new")}
          className="flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
        >
          <PlusIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm">New note</span>
        </button>
      )}
    </>
  );
}

export function WorkspaceInspector({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const { notes } = useProjectNotes(projectId);

  return (
    <div className="relative shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Notes"
              aria-expanded={open}
              title="Notes"
              className="relative text-muted-foreground"
            />
          }
        >
          <ClipboardListIcon className="size-4" />
        </PopoverTrigger>

        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={8}
          aria-label="Notes"
          className="max-h-[min(44rem,calc(100vh-6rem))] w-80 gap-0 overflow-y-auto rounded-3xl border border-border bg-popover p-2.5 text-popover-foreground shadow-3"
        >
          <InspectorNotes projectId={projectId} notes={notes} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
