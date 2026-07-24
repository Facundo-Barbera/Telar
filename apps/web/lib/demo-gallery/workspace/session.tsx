// LANE: workspace (CONCEPT) — the workspace from inside a normal project
// session. The point: tasks are a Telar-wide substrate, not the Workspace
// surface's private data. Any session gets workspace tools (in-process MCP,
// same pattern as loom-mcp/ultra-mcp) to READ the project's slice of the
// queue, CREATE items, and MODIFY them — provenance records the session.
// "Telar feels like a whole": ask any project chat "what are the tasks here?"
import { BotIcon, PaperclipIcon } from "lucide-react";
import { DeadlineChip, ProjectChip, ToolPill, VerdictChip } from "./shared";
import type { WsDeadline } from "./fixtures";

function You({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-muted px-4 py-2.5 text-sm">
        {children}
      </div>
    </div>
  );
}

function Agent({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <BotIcon className="size-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1 space-y-3 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

// Compact task row inside the chat answer — same chips as the queue, so the
// session's view of a task is recognizably the SAME task.
function TaskLine({
  rank,
  title,
  deadline,
  verdict,
  files,
}: {
  rank: number;
  title: string;
  deadline?: WsDeadline;
  verdict?: "session" | "loom";
  files?: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
      <span className="w-3 shrink-0 text-right font-mono text-[10px] text-muted-foreground/50">
        {rank}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
      {files && (
        <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground/60">
          <PaperclipIcon className="size-3" />
          {files}
        </span>
      )}
      {deadline && <DeadlineChip deadline={deadline} />}
      {verdict && <VerdictChip verdict={verdict} />}
    </div>
  );
}

export function WorkspaceSessionDemo() {
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
        <ProjectChip name="aurora" />
        <span className="text-xs text-muted-foreground/60">/</span>
        <h1 className="text-sm font-semibold tracking-tight">
          session — fix exports flake
        </h1>
        <span className="ml-auto text-xs text-muted-foreground">
          a normal project session, workspace tools on board
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-4 px-6 py-8">
          <You>What are the tasks for this project?</You>

          <ToolPill call="workspace.tasks · list project:aurora" />

          <Agent>
            <p>
              Aurora holds 5 of your 11 queue items — it’s had its own lane since Monday:
            </p>
            <div className="space-y-1.5">
              <TaskLine rank={1} title="Accept payments-retry loom (evidence ready)" verdict="session" />
              <TaskLine
                rank={2}
                title="Rework onboarding flow"
                deadline={{ label: "Fri", kind: "self" }}
                verdict="loom"
                files={3}
              />
              <TaskLine
                rank={3}
                title="Remove CSV export button"
                deadline={{ label: "Fri", kind: "external" }}
                verdict="session"
              />
              <TaskLine rank={4} title="Review Diego’s PR on the exports module" verdict="session" />
              <TaskLine
                rank={5}
                title="Prep Thursday demo walkthrough notes"
                deadline={{ label: "Thu", kind: "self" }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The last two sit in a proposed batch (“weave as one series”) the master
              floated this morning. Relevant here: the flake we’re fixing touches the
              same exports module.
            </p>
          </Agent>

          <You>
            add one: migrate the export tests to the new fixtures — after Diego’s PR
            lands
          </You>

          <ToolPill call="workspace.tasks · create project:aurora" />

          <Agent>
            <p>
              Added — <span className="font-medium">“Migrate export tests to the new fixtures”</span>,
              rank 6 in your Aurora lane, noted as after Diego’s PR. Provenance:{" "}
              <span className="font-mono text-xs">this session</span>. It’s on your
              workspace desk too, and the master will carry it in tomorrow’s briefing.
            </p>
          </Agent>
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-6 py-3">
        <p className="mx-auto w-full max-w-2xl text-center text-[10px] text-muted-foreground/50">
          sessions, looms, the master, the queue — one substrate underneath: every
          surface reads and writes the same tasks
        </p>
      </div>
    </div>
  );
}
