"use client";

/**
 * THE PROJECT'S NOTEBOOK, behind the clipboard glyph in the masthead.
 *
 * THIS USED TO BE THE "PINNED SUMMARY": a present-tense readout of the
 * workspace (changes, branch, worktrees), the notebook, and then every
 * process, sub-agent and browser tab that happened to be running. The owner
 * retired all of it but the notebook on 2026-09-13: the git rows duplicated
 * the Diff surface and the checkout strip under the composer, the process and
 * agent rows duplicated the panel's own Processes and Agents surfaces, and the
 * browser rows duplicated the panel's tab strip — three glances at things
 * that already had a place built to be read. What has no other home is the
 * one thing a person WRITES rather than watches: what they noted about the
 * project. So the popover is that, and only that.
 *
 * Notes are the project's, so every session on it shows the same list; the
 * editor is the same quick editor the `@` menu's rows point at, and a row
 * drags into the composer as the same reference `@` inserts.
 *
 * THE TRIGGER IS UNCHANGED ON PURPOSE. Same glyph, same place, same size —
 * the owner's words: "we don't need to change the icon or nothing". What it
 * lost is the activity dot, which reported the sections that are gone.
 */

import { useState } from "react";
import { ClipboardListIcon, NotebookPenIcon, PinIcon, PlusIcon } from "lucide-react";
import type { ProjectNote } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { noteReference, startReferenceDrag } from "@/lib/drag-reference";
import { useProjectNotes } from "@/lib/project-notes";
import { ProjectNoteEditor } from "@/components/project-notes-editor";

/** How many rows the list shows before it offers to unfold. Cuts from the END
 *  and never re-sorts, so the row you were looking at does not move. */
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

/** The first line of a body, as the row's muted half — it is what tells two
 *  notes with similar titles apart, and it is free. Local rather than shared
 *  with the `@` menu's own preview: that one is the completion table's, and a
 *  row's detail is allowed to change without moving the menu with it. */
function firstLine(note: ProjectNote): string {
  const line = note.body.split("\n").find((text) => text.trim()) ?? "";
  return line.replace(/^#+\s*/, "").trim();
}

/**
 * THE NOTEBOOK SECTION.
 *
 * EXPORTED so a render test can hold it: the popover's content is portalled
 * and only exists while it is open. It takes the notes rather than reading
 * them, which also keeps one fetch for the whole popover.
 *
 * A ROW OPENS IN PLACE, AND HAS NO CHEVRON. A note is consulted, and often
 * edited, without leaving whatever the popover was opened to check, so the
 * editor replaces the row where it stands. A chevron would promise a
 * departure that does not happen.
 *
 * A ROW IS A DRAG HANDLE AS MUCH AS A BUTTON. Drag hands the note's BODY to
 * whatever the pointer lands on — the composer (as a reference), or any other
 * application (as plain text). Both payloads always, per `drag-reference.ts`.
 */
export function InspectorNotes({ projectId, notes }: { projectId: string; notes: readonly ProjectNote[] }) {
  /** Which note the editor is open on: a note id, or `new` for the add row.
   *  One at a time — the section is a list, not a stack of open drawers. */
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
      {/* THE ADD ROW SITS OUTSIDE THE CAP, always reachable: "write this down"
          is the gesture that must never be behind a "2 more notes". Keyed on
          `new` and unmounted on close, so reopening starts a blank note rather
          than the last one's abandoned text. */}
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
  /** Read on mount rather than on open: it is one small document, the composer
   *  two centimetres below is already reading it, and both share the window
   *  event — so they cannot disagree about what the notebook holds. */
  const { notes } = useProjectNotes(projectId);

  return (
    <div className="relative shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            // One family with Run and Open beside it — bordered, h-7, and the
            // shared <Button>, which is also what gives it a focus ring.
            // `outline` already paints the open state through aria-expanded.
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
