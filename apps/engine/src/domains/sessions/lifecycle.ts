import { WakeKind as WakeKindSchema, type ModelSelection, type RuntimeMode, type WakeKind } from "@telar/engine-client";
import { stringValue } from "../../platform/http/params";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { sessionRoute } from "./reads";

const completionWake = (value: unknown): { completionWake?: "always" | "settled_only" } => (value === "always" || value === "settled_only" ? { completionWake: value } : {});

/** `dismiss` clears the session's desktop notification once a read receipt lands. */
export function sessionLifecycleRoutes(store: EngineStore, dismiss: (sessionId: string) => void): Route[] {
  return [
    {
      method: "PATCH",
      path: sessionRoute(""),
      auth: "engine",
      // Every field is validated in the store; `null` is forwarded because it is how JSON says "clear it".
      async handle({ params: [sessionId], body }) {
        const updated = store.updateSession(sessionId!, {
          ...(body.title === undefined ? {} : { title: stringValue(body.title, "session title")! }),
          ...(body.runtimeMode === undefined ? {} : { runtimeMode: body.runtimeMode as RuntimeMode }),
          ...(typeof body.detached === "boolean" ? { detached: body.detached } : {}),
          ...(body.model === undefined ? {} : { model: body.model as ModelSelection | null }),
          ...(body.settledOverride === undefined ? {} : { settledOverride: body.settledOverride as "settled" | "active" | null }),
          ...(body.snoozedUntil === undefined ? {} : { snoozedUntil: body.snoozedUntil as number | null }),
          ...(body.resumeAfterRateLimit === undefined ? {} : { resumeAfterRateLimit: body.resumeAfterRateLimit as boolean | null }),
        });
        if (body.settledOverride !== "settled") return ok({ session: updated });
        // An explicit settle ends what the session left running, and says what it ended.
        const ended = await store.endSessionLeftovers(sessionId!);
        return ok({ session: store.getSession(sessionId!), ended });
      },
    },
    {
      method: "POST",
      path: sessionRoute("/read"),
      auth: "engine",
      handle({ params: [sessionId], body }) {
        const answer = ok({ session: store.markSessionRead(sessionId!, stringValue(body.runId, "run id")!) });
        dismiss(sessionId!);
        return answer;
      },
    },
    { method: "POST", path: sessionRoute("/archive"), auth: "engine", handle: ({ params }) => ok({ session: store.archiveSession(params[0]!) }) },
    { method: "DELETE", path: sessionRoute(""), auth: "engine", handle: ({ params }) => ok({ deleted: store.deleteSession(params[0]!) }) },
    {
      method: "POST",
      path: sessionRoute("/subscriptions"),
      auth: "engine",
      handle({ params: [sessionId], body }) {
        const events = Array.isArray(body.events) ? body.events.filter((each): each is WakeKind => WakeKindSchema.safeParse(each).success) : undefined;
        return {
          status: 201,
          body: {
            subscription: store.subscribe(sessionId!, {
              targetSessionId: stringValue(body.targetSessionId, "target session id")!,
              ...(events && events.length > 0 ? { events } : {}),
              ...(body.once === true ? { once: true } : {}),
              ...completionWake(body.completionWake),
            }),
          },
        };
      },
    },
    { method: "GET", path: sessionRoute("/subscriptions"), auth: "engine", handle: ({ params }) => ok({ subscriptions: store.subscriptionsFor(params[0]!) }) },
    {
      method: "POST",
      path: sessionRoute("/cohorts"),
      auth: "engine",
      handle({ params: [sessionId], body }) {
        const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds.filter((each): each is string => typeof each === "string") : [];
        const cohort = store.subscribeCohort(sessionId!, {
          sessionIds,
          ...(typeof body.timeoutMinutes === "number" ? { timeoutMinutes: body.timeoutMinutes } : {}),
          ...completionWake(body.completionWake),
        });
        return { status: 201, body: { cohort } };
      },
    },
    { method: "GET", path: sessionRoute("/cohorts"), auth: "engine", handle: ({ params }) => ok({ cohorts: store.cohortsFor(params[0]!) }) },
    { method: "GET", path: sessionRoute("/held-reports"), auth: "engine", handle: ({ params }) => ok({ held: store.pendingNotifications(params[0]!).length }) },
    // A background task outlives its turn, so this names no run.
    { method: "POST", path: sessionRoute("/stop-background"), auth: "engine", handle: ({ params }) => ok({ stopped: store.stopBackgroundTasks(params[0]!) }) },
    { method: "GET", path: sessionRoute("/terminals"), auth: "engine", handle: async ({ params }) => ok({ open: await store.sessionTerminalCount(params[0]!) }) },
    { method: "POST", path: sessionRoute("/terminals/close"), auth: "engine", handle: async ({ params }) => ok({ closed: await store.closeSessionTerminals(params[0]!) }) },
    // Pause stops the run and holds the session until resume; only the worker's `by: "session"` is not a person.
    { method: "POST", path: sessionRoute("/pause"), auth: "engine", handle: ({ params, body }) => ok(store.pauseSession(params[0]!, body.by === "session" ? "session" : "human")) },
    { method: "POST", path: sessionRoute("/resume"), auth: "engine", handle: ({ params }) => ok(store.resumeSession(params[0]!)) },
  ];
}
