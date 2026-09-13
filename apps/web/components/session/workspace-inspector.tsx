"use client";

/**
 * THE PINNED ENVIRONMENT, ported from the frozen app's
 * components/session/workspace-inspector.tsx.
 *
 * THE PINNED SUMMARY IS THE PRESENT TENSE, AND ONLY THE PRESENT TENSE. Live
 * entries only: nothing finished, no "Done" row, no historical count. History
 * belongs to the panel's own surfaces, which are built to be read; this is built
 * to be GLANCED at, and a glance that has to skip past what already happened is
 * not a glance. Selecting a row is a "go there" — it opens the panel on the
 * surface that owns the detail and closes this — never a drill-down stack.
 *
 * ONE STANDING SECTION, AND ONLY ONE: the project's NOTEBOOK. It is not present
 * tense and it does not pretend to be — it is the one thing here a person writes
 * rather than watches. It earns the exception because this popover is where a
 * person looks to answer "what am I working in", and what they wrote down about
 * the project is that answer as much as the branch is. Notes are the project's,
 * so every session on it shows the same list; the editor is the same quick
 * editor the `@` menu's rows point at, and a row drags into the composer as the
 * same reference `@` inserts.
 *
 * TWO DEPARTURES FROM THE DONOR, both forced by what the engine exposes:
 *
 *   1. NO GIT ACTIONS. The donor's rows opened panes that staged files, created
 *      branches, committed and compared. `GET /v2/projects/:id/git` is read-only
 *      by construction (see its comment in the protocol's entities.ts) and there
 *      is no write endpoint to point a button at, so these rows report and link
 *      rather than act.
 *   2. NO CONTEXT SECTION. Attachments are not modelled by the contract at all.
 *
 * The donor also RESERVES a column when the right panel is closed on a wide
 * screen, padding the conversation out of the way. That is a positioning loop
 * measured on rAF against the trigger; this uses the shared popover instead and
 * keeps the surface's own look.
 */

import { useCallback, useEffect, useState } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GlobeIcon,
  NotebookPenIcon,
  PinIcon,
  PlusIcon,
  TerminalIcon,
} from "lucide-react";
import { isBackgroundWork, type GitOverview, type ProjectNote, type Session, type Task } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { noteReference, startReferenceDrag } from "@/lib/drag-reference";
import { useProjectNotes } from "@/lib/project-notes";
import { cn } from "@/lib/utils";
import { ProjectNoteEditor } from "@/components/project-notes-editor";
import { browserPanelTab, type BrowserState, type PanelTab } from "@/components/right-panel";

const api = createEngineApi();

/** The working tree changes underneath this process constantly. Fifteen seconds
 *  is slow enough to be free and fast enough that the number is not a lie by the
 *  time it is read. */
const REFRESH_MS = 15_000;

/** How many rows a section shows before it offers to unfold. Cuts from the END
 *  and never re-sorts, so the row you were looking at does not move. */
const SECTION_ROW_CAP = 5;

type RowTone = "default" | "live" | "attention";

function SectionHeading({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center px-2 pb-1.5 pt-2 text-xs font-medium text-muted-foreground">
      <span className="min-w-0 truncate">{label}</span>
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

function SectionDivider() {
  return <div className="my-2 h-px bg-border/70" />;
}

/** The key/value row primitive: icon, label, a right-aligned detail, and a
 *  chevron only when pressing it goes somewhere. */
function InspectorRow({
  icon: Icon,
  label,
  detail,
  tone = "default",
  onSelect,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  detail?: string;
  tone?: RowTone;
  onSelect?: () => void;
  title?: string;
}) {
  const glyph = cn("size-4 shrink-0", tone === "attention" ? "text-destructive" : tone === "live" ? "text-primary" : "text-muted-foreground");
  const body = (
    <>
      <Icon className={glyph} />
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {detail ? <span className="min-w-0 max-w-[52%] truncate text-xs text-muted-foreground">{detail}</span> : null}
      {onSelect ? <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" /> : null}
    </>
  );
  if (!onSelect) {
    return (
      <div className="flex min-h-9 items-center gap-2.5 rounded-xl px-2.5" title={title}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      className="flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors hover:bg-muted/70"
    >
      {body}
    </button>
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
          className="w-full rounded-md px-2 py-1 text-left text-[0.6875rem] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
 * EXPORTED FOR THE SAME REASON `WhereThisLands` TAKES ITS GIT AS A PROP: the
 * popover's content is portalled and only exists while it is open, so the
 * section is the unit a render test can hold. It takes the notes rather than
 * reading them, which also keeps one fetch for the whole popover.
 *
 * A ROW OPENS IN PLACE, AND HAS NO CHEVRON. Every other row here is a "go
 * there" — it opens the panel and closes this. A note is the opposite: it is
 * consulted, and often edited, WITHOUT leaving whatever the popover was opened
 * to check, so the editor replaces the row where it stands. A chevron would
 * promise a departure that does not happen.
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
      <SectionDivider />
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

export function WorkspaceInspector({
  projectId,
  projectName,
  session,
  tasks,
  browser,
  onOpenPanel,
}: {
  projectId: string;
  projectName?: string;
  session?: Session;
  tasks: readonly Task[];
  browser?: BrowserState;
  /** Open the right panel on a named surface. The whole point of a row. */
  onOpenPanel: (tab: PanelTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const [git, setGit] = useState<GitOverview>();
  /** Read on mount rather than on open: it is one small document, the composer
   *  two centimetres below is already reading it, and both share the window
   *  event — so they cannot disagree about what the notebook holds. */
  const { notes } = useProjectNotes(projectId);

  const load = useCallback(async () => {
    try {
      setGit((await api.projectGit(projectId)).git);
    } catch {
      // Best-effort: a stale or absent git readout is worth less than a popover
      // that refuses to open.
    }
  }, [projectId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  // Split by what outlives the turn, not by kind: a detached agent belongs
  // with the work a human may need to stop after the turn has ended.
  const processes = tasks.filter((task) => isBackgroundWork(task) && (task.state === "running" || task.state === "pending"));
  const agents = tasks.filter((task) => !isBackgroundWork(task) && (task.state === "running" || task.state === "pending"));
  const browserTabs = browser?.tabs ?? [];
  const activityRunning = processes.length + agents.length > 0;
  const needsAttention = tasks.some((task) => task.state === "waiting" || task.state === "failed");

  /** The trees CUT from the project, never the checkout itself — `git worktree
   *  list` reports the main checkout as an entry and it is not a worktree. */
  const cutWorktrees = (git?.worktrees ?? []).filter((entry) => !entry.isMainCheckout);

  const worktreeBranch = session?.workspace.mode === "worktree" ? session.workspace.branch : undefined;
  const branch = worktreeBranch ?? git?.branch;
  const dirty = git?.dirtyFiles ?? 0;
  const divergence =
    git && (git.ahead !== undefined || git.behind !== undefined) ? `↑${git.ahead ?? 0} ↓${git.behind ?? 0}` : undefined;

  // "Go there", not a stack: select, open the panel on that surface, close this.
  const goTo = (tab: PanelTab) => {
    onOpenPanel(tab);
    setOpen(false);
  };

  return (
    <div className="relative shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            // One family with Run and Open beside it — bordered, h-7, and the
            // shared <Button>, which is also what gives it a focus ring it
            // never had as a hand-rolled <button>. `outline` already paints the
            // open state through aria-expanded, so this no longer carries its
            // own.
            // "Workspace", NOT "Pinned summary". An unlabelled glyph whose
            // tooltip names the FURNITURE ("pinned summary") tells a reader
            // where the thing sits rather than what is in it. The popover's
            // own first heading has always said Workspace; the trigger now
            // agrees with it, which is the whole of what a person needs to
            // decide whether to press it.
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Workspace"
              aria-expanded={open}
              title="Workspace"
              className="relative text-muted-foreground"
            />
          }
        >
          <ClipboardListIcon className="size-4" />
          {(needsAttention || activityRunning) && (
            <span
              aria-hidden
              className={cn(
                "absolute right-0.5 top-0.5 size-2 rounded-full ring-2 ring-background",
                needsAttention ? "bg-destructive" : "bg-primary",
              )}
            />
          )}
        </PopoverTrigger>

        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={8}
          aria-label="Workspace"
          className="max-h-[min(44rem,calc(100vh-6rem))] w-80 gap-0 overflow-y-auto rounded-3xl border border-border bg-popover p-2.5 text-popover-foreground shadow-2xl"
        >
          <SectionHeading label={`Workspace · ${projectName ?? projectId}`} />
          <div className="space-y-0.5">
            <InspectorRow
              icon={FolderGit2Icon}
              label={dirty > 0 ? "Changes" : "Clean"}
              {...(dirty > 0 ? { detail: `${dirty} changed` } : {})}
              tone={dirty > 0 ? "attention" : "default"}
              onSelect={() => goTo("diff")}
            />
            {branch ? (
              <InspectorRow
                icon={GitBranchIcon}
                label={branch}
                {...(divergence ? { detail: divergence } : {})}
                title={worktreeBranch ? "This session's own checkout" : "The project's checkout"}
              />
            ) : (
              <InspectorRow icon={GitBranchIcon} label="Not a git repository" />
            )}
            {/* THE PROJECT'S OWN CHECKOUT IS NOT A WORKTREE, and counting it
                as one is what made a session on the checkout announce
                "1 worktree — exoplanets" — the project's name, offered as
                evidence of a cut tree that does not exist. `git worktree list`
                reports the main checkout as its first entry (see
                `parseWorktreeList`); the row is about the trees CUT from it,
                so a repository with none has no row at all. */}
            {git?.repository && cutWorktrees.length > 0 && (
              <InspectorRow
                icon={FolderGit2Icon}
                label={`${cutWorktrees.length} worktree${cutWorktrees.length === 1 ? "" : "s"}`}
                {...(cutWorktrees.length === 1 ? { detail: cutWorktrees[0]!.branch ?? cutWorktrees[0]!.basename } : {})}
              />
            )}
          </div>

          {/* DIRECTLY UNDER THE WORKSPACE, above everything that comes and
              goes: the notebook is the one section whose position must not
              depend on how many sub-agents happen to be running. */}
          <InspectorNotes projectId={projectId} notes={notes} />

          {processes.length > 0 && (
            <>
              <SectionDivider />
              <SectionHeading label="Processes" />
              <CappedRows
                noun="processes"
                rows={processes.map((task) => (
                  <InspectorRow key={task.id} icon={TerminalIcon} label={task.title ?? "Background work"} detail="Running" tone="live" />
                ))}
              />
            </>
          )}

          {agents.length > 0 && (
            <>
              <SectionDivider />
              <SectionHeading label="Sub-agents" />
              <CappedRows
                noun="sub-agents"
                rows={agents.map((task) => (
                  <InspectorRow
                    key={task.id}
                    icon={BotIcon}
                    label={task.title ?? task.role ?? "Sub-agent"}
                    detail="Running"
                    tone="live"
                    onSelect={() => goTo("agents")}
                  />
                ))}
              />
            </>
          )}

          {browserTabs.length > 0 && (
            <>
              <SectionDivider />
              <SectionHeading label="Browser" />
              <CappedRows
                noun="tabs"
                rows={browserTabs.map((tab) => (
                  <InspectorRow
                    key={tab.id}
                    icon={GlobeIcon}
                    label={tab.title || "Untitled"}
                    detail={tab.url}
                    tone={tab.active ? "live" : "default"}
                    onSelect={() => goTo(browserPanelTab(tab.id))}
                  />
                ))}
              />
            </>
          )}

          {/* NOTHING SAYS NOTHING. This used to close with "Nothing else is
              running." — a sentence whose only job was to report the absence
              of the three sections above it, which are absent. The popover is
              the present tense; an empty present tense is an empty popover. */}
        </PopoverContent>
      </Popover>
    </div>
  );
}
