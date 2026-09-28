import { z } from "zod";
import type { EngineRequest } from "@telar/engine-client";
import { err, failure, fillWithin, json, type ToolFactory } from "../../agent-tools";
import { NO_SELF, REQUESTS, REQUESTS_CHARS, REQUESTS_LIMIT, RESOLVE_REQUEST, type SessionsCapability, SUBSCRIBE, SUBSCRIPTIONS_CHARS, SUBSCRIPTIONS_LIMIT } from "./shared";

export function wakeTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [...subscriptionTools(tool, capability), ...requestTools(tool, capability)];
}

function subscriptionTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    tool(
      "sessions_subscribe",
      SUBSCRIBE,
      {
        sessionIds: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .optional()
          .describe("One wake when all are done; a turn that merely ends is not done."),
        timeoutMinutes: z.number().int().min(1).max(10_080).optional().describe("Default 240; then you get what arrived."),
        cancel: z.string().min(1).optional().describe("An id to stop."),
      },
      async (args) => {
        if (!capability.self) return err(NO_SELF);
        const subscribing = args.sessionIds !== undefined;
        const cancelling = args.cancel !== undefined;
        if (subscribing && cancelling) return err("Pass sessionIds to subscribe OR cancel to stop one, not both in one call.");
        if (cancelling && args.timeoutMinutes !== undefined) return err("timeoutMinutes belongs to a new subscription; cancel takes only the id.");
        if (subscribing) return subscribe(capability, capability.self.sessionId, args);
        if (cancelling) return cancel(capability, capability.self.sessionId, String(args.cancel));
        if (args.timeoutMinutes !== undefined) return err("timeoutMinutes needs sessionIds: name the sessions to be woken by.");
        return listSubscriptions(capability, capability.self.sessionId);
      },
    ),
  ];
}

async function subscribe(capability: SessionsCapability, self: string, args: Record<string, unknown>) {
  const sessionIds = Array.isArray(args.sessionIds) ? args.sessionIds.map(String) : [];
  if (sessionIds.length === 0) return err("Name the sessions to be woken by: sessionIds.");
  if (!capability.subscribeCohort) {
    try {
      const subscriptions = await Promise.all(sessionIds.map((targetSessionId) => capability.subscribe(self, { targetSessionId, once: true })));
      return json({ subscriptions, note: "You will be woken once per session when it ends a turn. End your turn now." });
    } catch (error) {
      return err(`Could not subscribe: ${failure(error)}`);
    }
  }
  try {
    const cohort = await capability.subscribeCohort(self, {
      sessionIds,
      ...(typeof args.timeoutMinutes === "number" ? { timeoutMinutes: args.timeoutMinutes } : {}),
    });
    const pending = cohort.members.filter((member) => !member.outcome).length;
    const already = cohort.alreadySubscribed
      ? `Already subscribed (${cohort.id}): nothing new was made, and it still expires at ${new Date(cohort.expiresAt).toISOString()}. `
      : cohort.movedFrom
        ? `Moved from ${cohort.movedFrom.join(", ")}, which no longer track${cohort.movedFrom.length === 1 ? "s" : ""} these sessions. `
        : "";
    return json({
      ...cohort,
      note: already + (pending === 0
        ? "Every session was already done, so the notification is on its way now."
        : cohort.members.length === 1
          ? `You will get ONE notification when ${sessionIds[0]} is done, quoting what it said, or at ${new Date(cohort.expiresAt).toISOString()} if it never is. A blocker or parked request still reaches you at once. End your turn now.`
          : `You will get ONE notification when all ${cohort.members.length} are done (${pending} still pending), or at ${new Date(cohort.expiresAt).toISOString()} with whatever arrived. Their results are held for it, not delivered one by one; a blocker or parked request still reaches you at once, and a member that sent a blocker stays pending until you answer it. End your turn now.`),
    });
  } catch (error) {
    return err(`Could not subscribe to the cohort: ${failure(error)}`);
  }
}

async function cancel(capability: SessionsCapability, self: string, subscriptionId: string) {
  try {
    const removed = await capability.unsubscribe(subscriptionId, self);
    return json({ subscriptionId, removed, ...(removed ? {} : { note: "No subscription of yours has that id — it was already removed, or it was never yours." }) });
  } catch (error) {
    return err(`Could not unsubscribe "${subscriptionId}": ${failure(error)}`);
  }
}

async function listSubscriptions(capability: SessionsCapability, self: string) {
  try {
    const subscriptions = await capability.subscriptions(self);
    const cohorts = capability.cohorts ? await capability.cohorts(self) : [];
    const { rows } = fillWithin(subscriptions, (subscription) => subscription, {
      limit: SUBSCRIPTIONS_LIMIT,
      chars: SUBSCRIPTIONS_CHARS,
    });
    return json({
      subscriptions: rows,
      ...(subscriptions.length > rows.length ? { total: subscriptions.length, notShown: subscriptions.length - rows.length } : {}),
      ...(cohorts.length > 0
        ? { cohorts: cohorts.map((cohort) => ({ id: cohort.id, expiresAt: cohort.expiresAt, pending: cohort.members.filter((member) => !member.outcome).map((member) => member.sessionId), members: cohort.members.length })) }
        : {}),
      ...(subscriptions.length === 0 && cohorts.length === 0
        ? { note: "This session is not subscribed to anything." }
        : subscriptions.length > rows.length
          ? { note: `${rows.length} of ${subscriptions.length}. That many at once is usually a sign that one-shot subscriptions were not being removed.` }
          : {}),
    });
  } catch (error) {
    return err(`Could not list subscriptions: ${failure(error)}`);
  }
}

function requestTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    tool(
      "sessions_requests",
      REQUESTS,
      { sessionId: z.string().min(1) },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        let requests: EngineRequest[];
        try {
          requests = (await capability.requests(sessionId)).filter((request) => request.state === "open");
        } catch (error) {
          return err(`Could not read requests of "${sessionId}": ${failure(error)}`);
        }
        const { rows } = fillWithin(requests, describeRequest, { limit: REQUESTS_LIMIT, chars: REQUESTS_CHARS });
        return json({
          sessionId,
          requests: rows,
          ...(requests.length > rows.length ? { total: requests.length, notShown: requests.length - rows.length } : {}),
          ...(requests.length === 0
            ? { note: "This session is not waiting on anything." }
            : requests.length > rows.length
              ? { note: `The first ${rows.length} of ${requests.length} open requests. Answering these makes room for the rest.` }
              : {}),
        });
      },
    ),
    tool(
      "sessions_resolve_request",
      RESOLVE_REQUEST,
      {
        sessionId: z.string().min(1),
        requestId: z.string().min(1).describe("From sessions_requests or a wake."),
        decision: z
          .enum(["accept", "acceptForSession", "decline"])
          .describe('acceptForSession also accepts later ones of that kind.'),
        answers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Keyed as sessions_requests listed them."),
        reason: z.string().optional().describe("One sentence."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const requestId = String(args.requestId ?? "");
        const decision = args.decision === "acceptForSession" ? "acceptForSession" : args.decision === "decline" ? "decline" : "accept";
        try {
          const open = (await capability.requests(sessionId)).find((request) => request.id === requestId);
          if (open && open.detail.kind === "secret_access") {
            return err(`Request "${requestId}" is a secret-access request. Choosing a vault item is the user's alone; leave it for them.`);
          }
        } catch (error) {
          return err(`Could not read requests of "${sessionId}": ${failure(error)}`);
        }
        const answers =
          args.answers && typeof args.answers === "object"
            ? Object.fromEntries(Object.entries(args.answers as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
            : undefined;
        try {
          const request = await capability.resolveRequest(sessionId, requestId, {
            decision,
            ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason } : {}),
            ...(answers ? { answers } : {}),
          });
          return json({
            ...describeRequest(request),
            decision: request.decision,
            resolvedBy: request.resolvedBy,
            note: "Recorded as answered by a session. The session that asked continues with this answer.",
          });
        } catch (error) {
          return err(`Could not resolve request "${requestId}" on "${sessionId}": ${failure(error)}`);
        }
      },
    ),
  ];
}

function describeRequest(request: EngineRequest): Record<string, unknown> {
  const base = { id: request.id, runId: request.runId, kind: request.detail.kind, state: request.state, openedAt: request.openedAt };
  const detail = request.detail;
  switch (detail.kind) {
    case "user_input":
      return {
        ...base,
        prompt: detail.prompt,
        fields: detail.fields.map((field) => ({
          key: field.key,
          label: field.label,
          kind: field.kind,
          ...(field.choices && field.choices.length > 0 ? { choices: field.choices } : {}),
          ...(field.required ? { required: true } : {}),
        })),
      };
    case "command_execution":
      return { ...base, command: detail.command.command };
    case "file_change":
      return { ...base, change: `${detail.change.kind} ${detail.change.path}` };
    case "file_read":
      return { ...base, path: detail.read.path };
    case "tool_call":
      return { ...base, tool: detail.call.name };
    case "secret_access":
      return { ...base, origin: detail.secret.origin, note: "A vault pick — the user's alone. sessions_resolve_request refuses it." };
  }
}
