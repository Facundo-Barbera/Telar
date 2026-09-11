"use client";

/**
 * THE COMPOSER'S FOOT — the project's notebook.
 *
 * It replaces the pinned environment (`workspace-environment.tsx`, whose
 * surviving half is the create-time popover mounted here). The argument for the
 * swap is in `docs/design/project-notes.md`: the old strip spent permanent width
 * restating a project name the cockpit header already carries and a branch
 * nobody could change once the session existed. What a person actually wants
 * within reach of the caret is what they wrote down about this project.
 *
 * FUSED, NOT STACKED — kept verbatim from the strip it replaces. `-mt-px` pulls
 * it up so its top border lands exactly on the composer's bottom border,
 * `border-t-0` removes the doubled hairline, and only the bottom corners are
 * rounded, so it reads as the same object's foot rather than a second card.
 *
 * A CHIP IS A DRAG HANDLE AS MUCH AS A BUTTON. Click opens the note; drag hands
 * its BODY to whatever the pointer lands on — the composer (as a reference), or
 * any other application (as plain text). Both payloads always, per
 * `drag-reference.ts`.
 *
 * REFRESHED ON A TIMER only for the git count, which changes underneath this
 * process constantly. The notes do not: they change when somebody changes them,
 * so they ride a window event and a re-read on focus — see `lib/project-notes.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import { NotebookPenIcon, PinIcon, PlusIcon } from "lucide-react";
import type { GitOverview, ProjectNote, Session } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { noteReference, startReferenceDrag } from "@/lib/drag-reference";
import { useProjectNotes } from "@/lib/project-notes";
import { cn } from "@/lib/utils";
import { ProjectNoteEditor } from "./project-notes-editor";
import { WhereThisLands } from "./workspace-environment";

const api = createEngineApi();

/** Fifteen seconds: slow enough to be free, fast enough that the uncommitted
 *  count is not a lie by the time it is read. */
const REFRESH_MS = 15_000;

/** One control in the strip: xs, ghost, its label hidden when the composer is
 *  narrow (a CONTAINER query — the foot must not consult the viewport). */
const CONTROL = "flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-muted/60 hover:text-foreground";

function StripRule() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border/60" />;
}

function NoteChip({ projectId, note }: { projectId: string; note: ProjectNote }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            draggable
            title={note.title}
            onDragStart={(event) => {
              startReferenceDrag(event.dataTransfer, noteReference(note));
              // A drag that began on the chip must not also open it when the
              // pointer comes back up somewhere else.
              setOpen(false);
            }}
            className={cn(CONTROL, "max-w-40 cursor-grab active:cursor-grabbing")}
          />
        }
      >
        {note.pinned ? (
          <PinIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <NotebookPenIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate">{note.title}</span>
      </PopoverTrigger>
      {/* A POPOVER, NOT THE RIGHT PANEL. A note is consulted WHILE a sentence is
          being written, and sending the reader to a panel means leaving the
          sentence — see the design doc §4. */}
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(26rem,calc(100vw-2rem))] gap-0 rounded-xl p-2">
        <ProjectNoteEditor projectId={projectId} note={note} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

export function ProjectNotesStrip({
  projectId,
  projectName,
  session,
  envMode,
  onEnvMode,
  pendingBase,
  onBase,
  onOpenChanges,
}: {
  projectId: string;
  projectName?: string;
  /** Absent on a fresh canvas, which is exactly when the create-time choices
   *  still mean something — see `WhereThisLands`. */
  session?: Session;
  envMode?: "local" | "worktree";
  onEnvMode?: (mode: "local" | "worktree") => void;
  pendingBase?: { baseRef?: string; branchName?: string };
  onBase?: (next: { baseRef?: string; branchName?: string }) => void;
  onOpenChanges?: () => void;
}) {
  const [git, setGit] = useState<GitOverview>();
  const [adding, setAdding] = useState(false);
  const { notes } = useProjectNotes(projectId);

  const load = useCallback(async () => {
    try {
      setGit((await api.projectGit(projectId)).git);
    } catch {
      // A count that could not be read is drawn as no count, which is the
      // honest answer — never a reassuring zero.
      setGit(undefined);
    }
  }, [projectId]);

  useEffect(() => {
    // Deferred to a task rather than called in the effect body: a synchronous
    // fetch-and-setState on mount is a cascading render. The interval that
    // follows is an ordinary subscription.
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  /** Only while the session does not exist. Afterwards the worktree is a fact on
   *  disk, not a setting, and the popover would be a control that lies. */
  const choosing = Boolean(onEnvMode) && !session;
  const dirty = git?.dirtyFiles ?? 0;

  return (
    <div className="mx-3 -mt-px">
      {/* --shadow-tint rather than raw black, and `bg-muted/25` lands at 25% of
          the theme's muted — see globals.css. */}
      <div className="flex min-h-8 w-full items-center gap-1 overflow-hidden rounded-b-xl border border-t-0 border-border/60 bg-muted/25 px-2 text-[0.6875rem] text-muted-foreground shadow-[0_8px_24px_-20px_var(--shadow-tint)]">
        {choosing && onEnvMode && (
          <>
            <WhereThisLands
              projectId={projectId}
              {...(projectName ? { projectName } : {})}
              {...(git ? { git } : {})}
              {...(envMode ? { envMode } : {})}
              onEnvMode={onEnvMode}
              {...(pendingBase ? { pendingBase } : {})}
              {...(onBase ? { onBase } : {})}
            />
            <StripRule />
          </>
        )}

        {/* THE NOTEBOOK. Scrolls rather than wraps: the foot is one line tall,
            and a strip that grew a second row would push the composer around
            every time somebody wrote a note. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {notes.map((note) => (
            <NoteChip key={note.id} projectId={projectId} note={note} />
          ))}
          <Popover open={adding} onOpenChange={setAdding}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="New note"
                  title="Write a note about this project"
                  className={cn(CONTROL, "shrink-0")}
                />
              }
            >
              <PlusIcon className="size-3.5 shrink-0" />
              {/* THE ONLY PLACE THE FEATURE NAMES ITSELF, and only while the
                  notebook is empty: once there are chips, the row is obviously
                  a row of notes and a permanent label is width spent on
                  something already understood. */}
              {notes.length === 0 && <span className="truncate">Note</span>}
            </PopoverTrigger>
            <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(26rem,calc(100vw-2rem))] gap-0 rounded-xl p-2">
              {/* Keyed on `adding` so closing and reopening starts a blank note
                  rather than the last one's abandoned text. */}
              {adding && <ProjectNoteEditor key="new" projectId={projectId} onClose={() => setAdding(false)} />}
            </PopoverContent>
          </Popover>
        </div>

        {/* --warning, the app's "a person has to move" colour: uncommitted work
            is not a failure, it is something you may want to deal with. The one
            thing the old strip carried that nothing else offers from here. */}
        {dirty > 0 && (
          <button
            type="button"
            onClick={onOpenChanges}
            disabled={!onOpenChanges}
            title="Files this session changed"
            className="ml-auto shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-warning transition-colors enabled:hover:bg-warning/20"
          >
            {dirty} changed
          </button>
        )}
      </div>
    </div>
  );
}
