import { z } from "zod";
import { err, failure, fillWithin, json, type ToolFactory } from "../../agent-tools";
import { createTool, modelChoice, runIdFor } from "./create";
import { delegationAnswer, WAIT, waitForDelegation } from "./wait";
import { FIND_LIMIT_DEFAULT, findView } from "./query";
import { EFFORT, LIST, LIST_CHARS, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, MODEL, SEND, type SessionsCapability, summarise } from "./shared";

export function messagingTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    tool(
      "sessions_list",
      LIST,
      {
        q: z.string().min(1).optional().describe("Search text instead of listing; lexical, not semantic."),
        settled: z
          .boolean()
          .optional()
          .describe("Shelved sessions instead. With q, omit for both."),
        projectId: z.string().optional(),
        since: z.number().int().min(0).optional().describe("With q: epoch ms."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LIST_LIMIT_MAX)
          .optional()
          .describe(`Default ${LIST_LIMIT_DEFAULT}; with q ${FIND_LIMIT_DEFAULT}.`),
        after: z.number().int().min(0).optional().describe("The `next` of a previous page."),
      },
      async (args) => {
        if (typeof args.q === "string" && args.q.trim()) {
          if (args.after !== undefined) return err("after pages a list; a search is narrowed with projectId, settled or since instead.");
          return findView(capability.query, args);
        }
        if (args.since !== undefined) return err("since narrows a search: pass q with it.");
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
    createTool(tool, capability),
    tool(
      "sessions_send",
      SEND,
      {
        sessionId: z.string().min(1),
        intent: z.enum(["task", "report", "result", "blocker"]).optional().describe("report (default, passive), task (assigns work), result (your final answer, sent last), blocker (needs a decision)."),
        input: z.string().min(1).describe("The whole message; it cannot see this conversation."),
        corrects: z.string().min(1).optional().describe("runId of your earlier message this corrects; replaced if still unread."),
        model: z.string().min(1).optional().describe(`With intent task, this turn only. ${MODEL}`),
        effort: z.string().min(1).optional().describe(EFFORT),
        wait: WAIT,
      },
      async (args, context) => {
        const sessionId = String(args.sessionId ?? "");
        const text = String(args.input ?? "");
        const corrects = typeof args.corrects === "string" && args.corrects.length > 0 ? args.corrects : undefined;
        const intent = args.intent === "task" || args.intent === "result" || args.intent === "blocker" ? args.intent : "report";
        const runId = runIdFor("sessions_send", context?.toolCallId);
        const wait = typeof args.wait === "number" ? args.wait : undefined;
        if (wait !== undefined && intent !== "task") return err("wait applies only to intent: task — the one that asks for a result.");
        const chosen = modelChoice(args);
        if (chosen.model && intent !== "task") return err("model and effort apply only to intent: task — the message that runs something.");
        try {
          const { turn } = await capability.send(sessionId, { runId, input: text, intent, ...(corrects ? { corrects } : {}), ...chosen });
          if (wait !== undefined) {
            return json({ sessionId, runId: turn.runId, ...delegationAnswer(await waitForDelegation(capability, sessionId, wait)) });
          }
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

