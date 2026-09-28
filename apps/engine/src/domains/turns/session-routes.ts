import { AgentTurnInput, ProviderTurnOpenInput, SessionTaskReport, TurnModelSelection, type TurnSubmissionResult } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import type { ExecutionPort } from "../../worker/execution-port";

const submitted = (result: TurnSubmissionResult) => ({ status: result.replayed ? 200 : 202, body: result });

type TurnRouteDeps = {
  execution: ExecutionPort;
  /** Throws 503 when no worker is registered to take the turn. */
  requireWorker(): void;
  /** Throws unless this worker holds a live registration. */
  activeWorker(workerId: string): unknown;
  retitle(sessionId: string, input: string): void;
};

export function sessionTurnRoutes(store: EngineStore, { execution, requireWorker, activeWorker, retitle }: TurnRouteDeps): Route[] {
  return [
    {
      method: "POST",
      path: sessionRoute("/turns/agent"),
      auth: "engine",
      // Its own route because who is speaking must not be a body field; `proof` is the sender's live claim.
      async handle({ params: [sessionId], body }) {
        requireWorker();
        const parsed = AgentTurnInput.safeParse(body);
        if (!parsed.success) throw new HttpError(400, "invalid_request", "agent turn payload is invalid");
        const { proof, ...message } = parsed.data;
        return submitted(await store.requestPath.submitAgentTurn(sessionId!, message, proof));
      },
    },
    {
      method: "POST",
      path: sessionRoute("/turns"),
      auth: "engine",
      // `origin`, `wakeReason` and `sender` are never read from the body: a cockpit that could set them could impersonate a peer.
      async handle({ params: [sessionId], body }) {
        requireWorker();
        const model = TurnModelSelection.safeParse(body.model);
        if (body.model !== undefined && !model.success) throw new HttpError(400, "invalid_request", "turn model selection is invalid");
        // Refreshed off the critical path: the claim reads the remembered default and must not wait on a CLI.
        if (store.claims.claudeAdmissionNeedsCatalogue(sessionId!, model.success ? model.data : undefined)) void store.catalogues.prepareClaude();
        const accepted = await store.requestPath.submitTurn(sessionId!, {
          runId: stringValue(body.runId, "run id")!,
          input: stringValue(body.input, "turn input")!,
          ...(body.kind === "compact" ? { kind: "compact" as const } : {}),
          ...(model.success ? { model: model.data } : {}),
          ...(Array.isArray(body.attachments) ? { attachments: body.attachments.map((id) => stringValue(id, "attachment id")!) } : {}),
        });
        if (!accepted.replayed && accepted.turn.sequence === 1) retitle(sessionId!, accepted.turn.input);
        return submitted(accepted);
      },
    },
    {
      method: "POST",
      path: sessionRoute("/stop"),
      auth: "engine",
      // `scope: "session"` is the Stop button; absent stops one turn. Unknown values are refused, never defaulted.
      handle({ params: [sessionId], body }) {
        const scope = body.scope === undefined ? undefined : stringValue(body.scope, "scope");
        if (scope !== undefined && scope !== "session") throw new HttpError(400, "invalid_request", 'scope must be "session" when given');
        const runId = stringValue(body.runId, "run id", true);
        if (scope === "session" && runId) throw new HttpError(400, "invalid_request", "a session-scope stop names no run id");
        const by = body.by === undefined ? "user" : stringValue(body.by, "by");
        if (by !== "user" && by !== "agent") throw new HttpError(400, "invalid_request", 'by must be "user" or "agent" when given');
        const commandId = stringValue(body.commandId, "command id", true);
        if (scope !== "session") return ok(store.turnLifecycle.stopTurn(sessionId!, runId));
        return ok(store.kernel.command(JSON.stringify({ operation: "stopSession", sessionId, by }), () => store.turnLifecycle.stopSession(sessionId!, by), commandId));
      },
    },
    {
      method: "POST",
      path: sessionRoute("/turns/provider"),
      auth: "engine",
      // A turn the provider started between turns; only a registered worker may open one.
      async handle({ params: [sessionId], body }) {
        const parsed = ProviderTurnOpenInput.safeParse(body);
        if (!parsed.success) throw new HttpError(400, "invalid_request", "provider turn payload is invalid");
        activeWorker(parsed.data.workerId);
        return ok(await execution.openProviderTurn(sessionId!, parsed.data));
      },
    },
    {
      method: "POST",
      path: sessionRoute("/tasks"),
      auth: "engine",
      async handle({ params: [sessionId], body }) {
        const parsed = SessionTaskReport.safeParse(body);
        if (!parsed.success) throw new HttpError(400, "invalid_request", "task report payload is invalid");
        activeWorker(parsed.data.workerId);
        return ok(await execution.reportSessionTasks(sessionId!, parsed.data.workerId, parsed.data.observations));
      },
    },
  ];
}
