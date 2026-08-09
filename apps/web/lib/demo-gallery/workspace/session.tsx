"use client";
// LANE: workspace (CONCEPT) — the workspace from inside a normal project
// session. The point: tasks are a Telar-wide substrate, not the Workspace
// surface's private data. Any session gets workspace tools (in-process MCP,
// same pattern as loom-mcp/ultra-mcp) to READ the project's slice of the
// queue, CREATE items, and MODIFY them — provenance records the session.
// "Telar feels like a whole": ask any project chat "what are the tasks here?"
//
// ── RE-SKIN PASS (2026-08-08) ───────────────────────────────────────────────
// THE BUBBLES ARE THE APP'S BUBBLES NOW. This file hand-drew a `You`
// (`rounded-2xl rounded-br-sm bg-muted`) and an `Agent` (a bordered circle with
// a BotIcon), neither of which is what a session looks like: the app's message
// idiom is components/ai-elements/message.tsx — a 50rem reading lane, an
// assistant turn that owns the full width with NO avatar, and a user turn that
// shrinks to a `bg-secondary` bubble on the right. Both come through
// @/components/conversation, the one roof AD-12 gives every conversational
// surface, so this mockup and every real session draw the same thing.
//
// AND ONLY THE BUBBLES — deliberately NOT the whole `Conversation` shell, which
// the master chat mockup (./home.tsx) does use. Two reasons. The shell owns
// scrolling and lays out four slots; what §5 of ui-contract.md freezes is a
// SLICE of an ordinary session (a question, two tool pills, two answers) framed
// by a claim about the substrate, and mounting a whole shell to show a slice
// would put the footer line into a slot called `composer`. The master chat is
// the opposite case: §1 says it IS a session, so it is drawn as one.
//
// CONTENT UNTOUCHED: the same two exchanges, the same five task rows, the same
// creation confirmation (rank + lane, the ordering note, `Provenance: this
// session`, that it is on the desk, and that the master will carry it into the
// next briefing), the same substrate footer.
import { PaperclipIcon } from "lucide-react";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/conversation";
import { PageHeader } from "@/components/common/page-header";
import { DeadlineChip, ProjectChip, ToolPill, VerdictChip } from "./shared";
import type { WsDeadline, WsVerdict } from "./fixtures";

// The reading lane every Message draws itself in. The tool pills and the task
// rows sit in the same one, or the transcript would visibly step in and out.
const LANE = "mx-auto w-full max-w-[50rem]";

// Compact task row inside the chat answer — same chips as the queue, so the
// session's view of a task is recognizably the SAME task (cross-surface
// invariant 1, which is now true by construction: ./shared re-exports the one
// chip module rather than re-spelling it).
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
  verdict?: WsVerdict;
  files?: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
      <span className="w-4 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60">
        {rank}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
      {files && (
        <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">
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
      <PageHeader
        leading={<ProjectChip name="aurora" />}
        title="session — fix exports flake"
        description="a normal project session, workspace tools on board"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 px-4 py-6">
          <Message from="user">
            <MessageContent>What are the tasks for this project?</MessageContent>
          </Message>

          <div className={LANE}>
            <ToolPill call="workspace.tasks · list project:aurora" />
          </div>

          <Message from="assistant">
            <MessageContent>
              <MessageResponse>
                Aurora holds 5 of your 11 queue items — it’s had its own lane since Monday:
              </MessageResponse>
              <div className="space-y-1.5">
                <TaskLine
                  rank={1}
                  title="Accept payments-retry loom (evidence ready)"
                  verdict="session"
                />
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
                <TaskLine
                  rank={4}
                  title="Review Diego’s PR on the exports module"
                  verdict="session"
                />
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
            </MessageContent>
          </Message>

          <Message from="user">
            <MessageContent>
              add one: migrate the export tests to the new fixtures — after Diego’s PR lands
            </MessageContent>
          </Message>

          <div className={LANE}>
            <ToolPill call="workspace.tasks · create project:aurora" />
          </div>

          <Message from="assistant">
            <MessageContent>
              {/* Markdown, not hand-spelled spans: the emphasis and the code
                  span reach the bubble through the same streamdown renderer
                  every other assistant turn in the app uses. */}
              <MessageResponse>
                {'Added — **“Migrate export tests to the new fixtures”**, rank 6 in your ' +
                  "Aurora lane, noted as after Diego’s PR. Provenance: `this session`. " +
                  "It’s on your workspace desk too, and the master will carry it in " +
                  "tomorrow’s briefing."}
              </MessageResponse>
            </MessageContent>
          </Message>
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3">
        <p className={`${LANE} text-center text-[10px] leading-relaxed text-muted-foreground/60`}>
          sessions, looms, the master, the queue — one substrate underneath: every
          surface reads and writes the same tasks
        </p>
      </div>
    </div>
  );
}
