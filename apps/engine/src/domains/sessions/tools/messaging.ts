import crypto from "node:crypto";
import { z } from "zod";
import type { Session } from "@telar/engine-client";
import { err, failure, fillWithin, json, type ToolFactory } from "../../agent-tools";
import { CREATE, LIST, LIST_CHARS, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, SEND, type SessionsCapability, summarise, summariseOne } from "./shared";

export function messagingTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    tool(
      "sessions_list",
      LIST,
      {
        settled: z
          .boolean()
          .optional()
          .describe("Default false — the list a person has open."),
        projectId: z.string().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LIST_LIMIT_MAX)
          .optional()
          .describe(`Default ${LIST_LIMIT_DEFAULT}.`),
        after: z.number().int().min(0).optional().describe("The cursor a previous answer's `more` hands back."),
      },
      async (args) => {
        const settled = args.settled === true;
        const wantedProject = typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : undefined;
        const limit =
          typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1
            ? Math.min(args.limit, LIST_LIMIT_MAX)
            : LIST_LIMIT_DEFAULT;
        const after = typeof args.after === "number" && Number.isSafeInteger(args.after) && args.after >= 0 ? args.after : 0;
        const answer = await capability.list({ settled });
        const { sessions, projects } = answer;
        const names = new Map(projects.map((project) => [project.id, project.name]));
        const matching = wantedProject ? sessions.filter((session) => session.projectId === wantedProject) : sessions;
        const window = matching.slice(after, after + limit);
        const drivers = new Set(window.map((session) => session.driver));
        const perRowDriver = drivers.size > 1;
        const { rows } = fillWithin(window, (session) => summarise(session, names, { driver: perRowDriver }), {
          limit,
          chars: LIST_CHARS,
        });
        const page = window.slice(0, rows.length);
        const more = after + page.length < matching.length;
        return json({
          sessions: rows,
          ...(drivers.size === 1 ? { driver: [...drivers][0] } : {}),
          total: matching.length,
          ...(after > 0 ? { after } : {}),
          more,
          ...(more ? { next: after + page.length } : {}),
          ...(!settled && typeof answer.settledCount === "number" && answer.settledCount > 0 ? { settledNotShown: answer.settledCount } : {}),
          projects: projects.map((project) => ({ id: project.id, name: project.name })),
          ...(matching.length === 0
            ? {
                note: wantedProject
                  ? `No ${settled ? "" : "unsettled "}sessions on project "${wantedProject}".`
                  : settled
                    ? "No sessions are live on this engine."
                    : "No unsettled sessions. Settled ones are still live and resumable — ask with settled: true.",
              }
            : more
              ? { note: `Rows ${after}–${after + page.length} of ${matching.length}. Continue with sessions_list(after: ${after + page.length}).` }
              : {}),
          ...(projects.length === 0
            ? { note2: "No projects are registered, so nothing can be created — the user registers a project themselves." }
            : {}),
        });
      },
    ),
    tool(
      "sessions_create",
      CREATE,
      {
        projectId: z.string().min(1).describe("From sessions_list's `projects`."),
        title: z
          .string()
          .optional()
          .describe("A few words. Write one — an untitled session is unidentifiable an hour later."),
        envMode: z
          .enum(["local", "worktree"])
          .describe(
            '"worktree" for anything that edits files: a checkout of its own. "local" shares the project\'s checkout with every other local session and the user\'s editor. No safe default.',
          ),
        driver: z
          .enum(["claude", "codex"])
          .optional()
          .describe("Omit unless the user asked for one."),
      },
      async (args) => {
        const projectId = String(args.projectId ?? "");
        const envMode = args.envMode === "worktree" ? "worktree" : "local";
        let session: Session;
        try {
          session = await capability.create({
            projectId,
            ...(typeof args.title === "string" && args.title.trim() ? { title: args.title } : {}),
            envMode,
            ...(args.driver === "claude" || args.driver === "codex" ? { driver: args.driver } : {}),
          });
        } catch (error) {
          return err(`Could not create a session on "${projectId}": ${failure(error)}`);
        }
        const names = new Map<string, string>();
        return json({
          ...summariseOne(session, names),
          note:
            session.workspace.mode === "worktree"
              ? `Created with a checkout of its own on branch ${session.workspace.branch}. Nothing is queued and nothing has started — send it a message with intent: task to give it work.`
              : `Created against the project's own checkout, which it shares with anything else working there. Nothing is queued and nothing has started — send it a message with intent: task to give it work.`,
          note2: "This session is a peer, not yours: it does not report back, and nothing records that you created it.",
          access: `${session.runtimeMode} — never wider than your own, so if you have to ask about something, so does it.`,
        });
      },
    ),
    tool(
      "sessions_send",
      SEND,
      {
        sessionId: z.string().min(1),
        intent: z.enum(["task", "report", "result", "blocker"]).optional().describe("report (default) passive, for progress mid-task; task assigns work; result is your FINAL answer — send it last; blocker asks for intervention. After any of these reaches a subscriber, your run completing does not wake them again."),
        input: z.string().min(1).describe("The whole message; it cannot see this conversation."),
        corrects: z.string().min(1).optional().describe("The runId of your earlier message to them that this one corrects: unread, it is replaced; already read, this one arrives at once."),
      },
      async (args, context) => {
        const sessionId = String(args.sessionId ?? "");
        const text = String(args.input ?? "");
        const corrects = typeof args.corrects === "string" && args.corrects.length > 0 ? args.corrects : undefined;
        const intent = args.intent === "task" || args.intent === "result" || args.intent === "blocker" ? args.intent : "report";
        const runId = context?.toolCallId
          ? `run_${crypto.createHash("sha256").update(`sessions_send:${context.toolCallId}`).digest("hex").slice(0, 32)}`
          : `run_${crypto.randomUUID().replaceAll("-", "")}`;
        try {
          const { turn } = await capability.send(sessionId, { runId, input: text, intent, ...(corrects ? { corrects } : {}) });
          return json({
            sessionId,
            runId: turn.runId,
            state: turn.state,
            delivery: turn.agentDelivery,
            ...(turn.agentNotice ? { recipientSees: turn.agentNotice } : {}),
            note: turn.agentDelivery === "passive"
              ? "Recorded as passive activity. No model was started or steered; do not wait for an acknowledgement. Its model was handed the notice above; your text is stored whole and it can read it with sessions_read."
              : intent === "result"
                ? "Accepted for execution, not answered. Its model was handed the notice above — your text is stored whole and one sessions_read away. This result is your run's FINAL word to them: when this run ends they will NOT be woken again, so end the turn now, or send anything further as a report. This is an agent message, never human approval."
                : "Accepted for execution, not answered. Its model was handed the notice above — your text is stored whole and one sessions_read away. Check sessions_status or sessions_read. This is an agent message, never human approval.",
          });
        } catch (error) {
          return err(`Could not send to "${sessionId}": ${failure(error)}`);
        }
      },
    ),
  ];
}
