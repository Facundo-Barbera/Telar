import crypto from "node:crypto";
import { z } from "zod";
import type { Session } from "@telar/engine-client";
import { err, failure, json, type ToolFactory } from "../../agent-tools";
import { delegationAnswer, WAIT, waitForDelegation } from "./wait";
import { CREATE, EFFORT, MODEL, type SessionsCapability, summariseOne } from "./shared";

const MAX_BATCH = 20;

export const modelChoice = (args: Record<string, unknown>): { model?: { model?: string; effort?: string } } => {
  const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
  const effort = typeof args.effort === "string" && args.effort.trim() ? args.effort.trim() : undefined;
  return model || effort ? { model: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } } : {};
};

const runsOn = (session: Session): Record<string, string> =>
  session.model?.model ? { model: `${session.model.model}${session.model.effort ? ` at ${session.model.effort}` : ""}` } : {};

export const runIdFor = (tool: string, toolCallId: string | undefined): string =>
  toolCallId
    ? `run_${crypto.createHash("sha256").update(`${tool}:${toolCallId}`).digest("hex").slice(0, 32)}`
    : `run_${crypto.randomUUID().replaceAll("-", "")}`;

type Shared = { projectId: string; envMode: "local" | "worktree"; driver?: "claude" | "codex" };

const sharedOf = (args: Record<string, unknown>): Shared => ({
  projectId: String(args.projectId ?? ""),
  envMode: args.envMode === "worktree" ? "worktree" : "local",
  ...(args.driver === "claude" || args.driver === "codex" ? { driver: args.driver } : {}),
});

const SINGLE_ONLY = ["title", "task", "model", "effort", "wait"] as const;

export function createTool(tool: ToolFactory, capability: SessionsCapability): unknown {
  return tool(
    "sessions_create",
    CREATE,
    {
      projectId: z.string().min(1).describe("From sessions_list."),
      title: z
        .string()
        .optional()
        .describe("A few words; always set one."),
      envMode: z
        .enum(["local", "worktree"])
        .describe(
          "worktree: its own checkout, for anything that edits files. local: shares the project's checkout.",
        ),
      driver: z
        .enum(["claude", "codex"])
        .optional()
        .describe("Omit unless the user asked."),
      model: z.string().min(1).optional().describe(MODEL),
      effort: z.string().min(1).optional().describe(EFFORT),
      task: z.string().min(1).optional().describe("A self-contained brief; it cannot see this conversation."),
      wait: WAIT,
      tasks: z
        .array(
          z.strictObject({
            title: z.string().min(1),
            task: z.string().min(1).describe("Its own self-contained brief."),
            model: z.string().min(1).optional(),
            effort: z.string().min(1).optional(),
          }),
        )
        .min(1)
        .max(MAX_BATCH)
        .optional()
        .describe("Several workers in one call, sharing projectId, envMode and driver; replaces title, task, model, effort and wait."),
    },
    async (args, context) => {
      if (Array.isArray(args.tasks)) {
        const mixed = SINGLE_ONLY.filter((key) => args[key] !== undefined);
        if (mixed.length > 0) return err(`tasks carries each worker's title, task, model and effort; drop ${mixed.join(", ")} from the call.`);
        return createMany(capability, sharedOf(args), args.tasks as Record<string, unknown>[], context?.toolCallId);
      }
      return createOne(capability, args, context?.toolCallId);
    },
  );
}

async function createOne(capability: SessionsCapability, args: Record<string, unknown>, toolCallId: string | undefined) {
  const shared = sharedOf(args);
  if (typeof args.wait === "number" && (typeof args.task !== "string" || !args.task)) return err("wait needs a task: there is nothing to wait for.");
  let session: Session;
  try {
    session = await capability.create({
      ...shared,
      ...(typeof args.title === "string" && args.title.trim() ? { title: args.title } : {}),
      ...modelChoice(args),
    });
  } catch (error) {
    return err(`Could not create a session on "${shared.projectId}": ${failure(error)}`);
  }
  const where = session.workspace.mode === "worktree"
    ? `Created with a checkout of its own on branch ${session.workspace.branch}.`
    : "Created against the project's own checkout, which it shares with anything else working there.";
  const answer = {
    ...summariseOne(session, new Map<string, string>()),
    ...runsOn(session),
    note: `${where} Nothing is queued and nothing has started — send it a message with intent: task to give it work.`,
    note2: "It is filed under you, but it reports back only when you task it.",
    access: `${session.runtimeMode} — never wider than your own, so if you have to ask about something, so does it.`,
  };
  if (typeof args.task !== "string" || !args.task) return json(answer);
  try {
    const { turn } = await capability.send(session.id, { runId: runIdFor("sessions_create", toolCallId), input: args.task, intent: "task" });
    if (typeof args.wait === "number") {
      return json({ ...answer, runId: turn.runId, ...delegationAnswer(await waitForDelegation(capability, session.id, args.wait)) });
    }
    return json({
      ...answer,
      runId: turn.runId,
      taskState: turn.state,
      ...(turn.agentNotice ? { recipientSees: turn.agentNotice } : {}),
      note: `${where} Your task is queued as ${turn.runId}; its model was handed the notice above. Subscribe and end your turn.`,
    });
  } catch (error) {
    return err(`Created ${session.id}, but the task was not delivered: ${failure(error)}. Send it with sessions_send intent task.`);
  }
}

type Worker = { title: string; id?: string; branch?: string; model?: string; runId?: string; error?: string };

async function createMany(capability: SessionsCapability, shared: Shared, tasks: Record<string, unknown>[], toolCallId: string | undefined) {
  const workers: Worker[] = [];
  for (const [index, entry] of tasks.entries()) {
    const title = String(entry.title ?? "");
    let session: Session;
    try {
      session = await capability.create({ ...shared, title, ...modelChoice(entry) });
    } catch (error) {
      workers.push({ title, error: `not created: ${failure(error)}` });
      continue;
    }
    const made: Worker = {
      title,
      id: session.id,
      ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
      ...runsOn(session),
    };
    try {
      const { turn } = await capability.send(session.id, { runId: runIdFor(`sessions_create#${index}`, toolCallId), input: String(entry.task ?? ""), intent: "task" });
      workers.push({ ...made, runId: turn.runId });
    } catch (error) {
      workers.push({ ...made, error: `created, but the task was not delivered: ${failure(error)}` });
    }
  }
  const tasked = workers.filter((worker) => worker.runId).map((worker) => worker.id!);
  const failed = workers.length - tasked.length;
  const failedNote = failed > 0 ? ` ${failed} of ${workers.length} did not start; each says why.` : "";
  if (tasked.length === 0) return json({ workers, note: `Nothing started.${failedNote}` });
  const subscribed = await subscribeAll(capability, tasked);
  return json({
    workers,
    ...("cohort" in subscribed ? { cohort: subscribed.cohort } : {}),
    note: "cohort" in subscribed
      ? `${tasked.length} tasked and subscribed as one cohort: ONE notification when all are done, quoting each result; a blocker reaches you at once.${failedNote} End your turn now.`
      : `${tasked.length} tasked, but not subscribed: ${subscribed.unsubscribed}.${failedNote}`,
  });
}

async function subscribeAll(capability: SessionsCapability, sessionIds: string[]): Promise<{ cohort: { id: string; expiresAt: number } } | { unsubscribed: string }> {
  if (!capability.self || !capability.subscribeCohort) return { unsubscribed: "this client is not a session that can be woken, so poll sessions_status" };
  try {
    const cohort = await capability.subscribeCohort(capability.self.sessionId, { sessionIds });
    return { cohort: { id: cohort.id, expiresAt: cohort.expiresAt } };
  } catch (error) {
    return { unsubscribed: `${failure(error)} — call sessions_subscribe with their ids` };
  }
}
