import { RequestOpenInput, WorkerTurnFailure, WorkerTurnFailureCode } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import type { ExecutionPort } from "../../worker/execution-port";

const turnPath = (actions: string) => new RegExp(`^/v2/sessions/([A-Za-z0-9_-]+)/turns/([A-Za-z0-9_-]+)/(${actions})$`);

/** Worker registration, heartbeat and claim; the execution port owns leases and claim sequencing. */
export function workerRoutes(execution: ExecutionPort): Route[] {
  return [
    { method: "POST", path: "/v2/workers/register", auth: "engine", handle: async ({ body }) => ok(await execution.registerWorker(stringValue(body.workerId, "worker id")!)) },
    {
      method: "POST",
      path: /^\/v2\/workers\/([A-Za-z0-9_-]+)\/heartbeat$/,
      auth: "engine",
      async handle({ params, body }) {
        const ack = body.acknowledgedTaskStops;
        if (ack !== undefined && (!Array.isArray(ack) || ack.some((id) => typeof id !== "string"))) {
          throw new HttpError(400, "invalid_request", "task stop acknowledgments must be strings");
        }
        return ok(await execution.workerHeartbeat(params[0]!, undefined, ack as string[] | undefined));
      },
    },
    {
      method: "POST",
      path: /^\/v2\/workers\/([A-Za-z0-9_-]+)\/claim$/,
      auth: "engine",
      handle: async ({ params, body }) => ok(await execution.claimTurn(params[0]!, body.claimSeq as number)),
    },
  ];
}

/** A person's gestures on a turn carry no claim token; a worker's reports must carry the one its claim was given. */
export function turnRoutes(store: EngineStore, execution: ExecutionPort): Route[] {
  const gestures = {
    release: store.releaseHeldTurn.bind(store),
    resume: store.resumeRateLimitedTurn.bind(store),
    discard: store.discardAmbiguousTurn.bind(store),
    promote: store.promoteTurn.bind(store),
  };
  return [
    {
      method: "POST",
      path: turnPath("release|resume|discard|promote"),
      auth: "engine",
      handle: ({ params: [sessionId, runId, action] }) => ok({ turn: gestures[action as keyof typeof gestures](sessionId!, runId!) }),
    },
    {
      method: "POST",
      path: turnPath("running|steer-ack|request|observe|complete|fail"),
      auth: "engine",
      async handle({ params: [sessionId, runId, action], body }) {
        const claimToken = stringValue(body.claimToken, "claim token")!;
        if (action === "running") return ok(await execution.markTurnRunning(sessionId!, runId!, claimToken));
        // The run in the path is the promoted turn; the token proves the worker holds the turn it was steered into.
        if (action === "steer-ack") return ok(await execution.ackSteer(sessionId!, runId!, claimToken));
        if (action === "request") return ok(await openRequest(execution, sessionId!, runId!, body));
        if (action === "observe") {
          if (!Array.isArray(body.observations)) throw new HttpError(400, "invalid_request", "observations must be an array");
          return ok(await execution.reportObservations(sessionId!, runId!, claimToken, body.observations));
        }
        if (action === "complete") {
          return ok(
            await execution.completeTurn(sessionId!, runId!, claimToken, {
              text: stringValue(body.text, "text")!,
              providerSessionId: stringValue(body.providerSessionId, "provider session id", true),
              usage: body.usage as never,
            }),
          );
        }
        return ok(await execution.failTurn(sessionId!, runId!, claimToken, turnFailure(body)));
      },
    },
  ];
}

function openRequest(execution: ExecutionPort, sessionId: string, runId: string, body: Record<string, unknown>) {
  const parsed = RequestOpenInput.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "request payload is invalid");
  const { claimToken, requestId, kind, detail, itemId, providerRefs, deadlineMs } = parsed.data;
  return execution.openRequest(sessionId, runId, claimToken, {
    requestId,
    kind,
    detail,
    ...(itemId ? { itemId } : {}),
    ...(providerRefs ? { providerRefs } : {}),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(parsed.data.default !== undefined ? { default: parsed.data.default } : {}),
  });
}

function turnFailure(body: Record<string, unknown>) {
  const code = WorkerTurnFailureCode.safeParse(stringValue(body.code, "failure code"));
  if (!code.success) throw new HttpError(400, "invalid_request", "failure code is invalid");
  const failure = WorkerTurnFailure.safeParse({
    code: code.data,
    message: stringValue(body.message, "failure message")!,
    ...(body.resumeAt === undefined ? {} : { resumeAt: body.resumeAt }),
    ...(body.limitType === undefined ? {} : { limitType: body.limitType }),
  });
  if (!failure.success) throw new HttpError(400, "invalid_request", "turn failure is invalid");
  return failure.data;
}
