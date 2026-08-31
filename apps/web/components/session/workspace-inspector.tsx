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
  TerminalIcon,
} from "lucide-react";
import type { GitOverview, Session, Task } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
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
          className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {expanded ? `Show fewer ${noun}` : `${hidden} more ${noun}`}
        </button>
      )}
    </div>
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

  const processes = tasks.filter((task) => task.kind === "background" && (task.state === "running" || task.state === "pending"));
  const agents = tasks.filter((task) => task.kind !== "background" && (task.state === "running" || task.state === "pending"));
  const browserTabs = browser?.tabs ?? [];
  const activityRunning = processes.length + agents.length > 0;
  const needsAttention = tasks.some((task) => task.state === "waiting" || task.state === "failed");

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
            <button
              type="button"
              aria-label={open ? "Close pinned summary" : "Open pinned summary"}
              aria-expanded={open}
              title="Pinned summary"
              className={cn(
                "relative flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                open && "bg-muted text-foreground",
              )}
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
          aria-label="Pinned summary"
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
            {git?.repository && git.worktrees.length > 0 && (
              <InspectorRow
                icon={FolderGit2Icon}
                label={`${git.worktrees.length} worktree${git.worktrees.length === 1 ? "" : "s"}`}
                detail={git.worktrees.find((entry) => entry.isMainCheckout)?.basename}
              />
            )}
          </div>

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

          {!activityRunning && browserTabs.length === 0 && (
            <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">Nothing else is running.</p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
