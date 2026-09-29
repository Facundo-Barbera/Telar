import { AgentModelChoice, AgentTurnInput } from "@telar/engine-client";
import { HttpError, matchesETag } from "../../platform/http/http";
import { positiveParam, stringValue } from "../../platform/http/params";
import { notModified, ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { sessionsStreamRoute, type OpenStream } from "./stream";

function modelChoice(value: unknown): AgentModelChoice {
  const parsed = AgentModelChoice.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "model must be { model?, effort? }");
  return parsed.data;
}

function senderProof(value: unknown): AgentTurnInput["proof"] {
  if (value === undefined) return undefined;
  const parsed = AgentTurnInput.shape.proof.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "proof is invalid");
  return parsed.data;
}

const FIND_LIMIT_DEFAULT = 10;
const FIND_LIMIT_MAX = 50;
const DECISIONS = ["accept", "acceptForSession", "decline", "cancel"] as const;

// Weak: two answers at one revision carry the same rows, not the same bytes. The mode is in the tag.
const liveSessionsETag = (revision: number, all: boolean): string => `W/"live-${revision}-${all ? "all" : "lean"}"`;

type SessionsRouteDeps = { daemonId: string; openStreams: Set<OpenStream>; mcpInfo: () => unknown };

/** The literal `/v2/sessions/<name>` reads; the router puts them ahead of any `/v2/sessions/:id` pattern. */
export function sessionsRoutes(store: EngineStore, { daemonId, openStreams, mcpInfo }: SessionsRouteDeps): Route[] {
  return [
    {
      method: "GET",
      path: "/v2/sessions",
      auth: "engine",
      handle({ query }) {
        const projectId = query.get("projectId");
        if (!projectId) throw new HttpError(400, "invalid_request", "projectId is required");
        return ok({ sessions: store.live.list(projectId) });
      },
    },
    {
      method: "GET",
      path: "/v2/sessions/live",
      auth: "engine",
      // The rail's poll. `?full=1` is the old whole answer; `?all=1` adds the settled rows and is never `?since=`-conditional.
      handle({ query, request }) {
        if (query.get("full") === "1") return ok(store.live.all());
        const all = query.get("all") === "1";
        const etag = liveSessionsETag(store.live.revision({ all }), all);
        if (matchesETag(request.headers["if-none-match"], etag)) return notModified(etag);
        const since = Number(query.get("since"));
        if (!all && Number.isSafeInteger(since) && since === store.live.revision()) {
          return { status: 200, body: { revision: since, unchanged: true, daemonId }, headers: { etag } };
        }
        return { status: 200, body: { ...store.live.rows({ all }), projects: store.projectRegistry.list(), daemonId }, headers: { etag } };
      },
    },
    sessionsStreamRoute(store, openStreams),
    { method: "GET", path: "/v2/sessions/activity", auth: "engine", handle: () => ok({ projects: store.live.projectActivity() }) },
    {
      method: "GET",
      path: "/v2/sessions/find",
      auth: "engine",
      handle({ query }) {
        const q = query.get("q");
        if (!q || !q.trim()) throw new HttpError(400, "invalid_request", "q is required");
        const settled = query.get("settled");
        return ok(
          store.queries.findSessions({
            q,
            ...(query.get("projectId") ? { projectId: query.get("projectId")! } : {}),
            ...(settled === null ? {} : { settled: settled === "1" || settled === "true" }),
            ...(query.get("since") ? { since: positiveParam(query.get("since"), 0, Number.MAX_SAFE_INTEGER, "since") } : {}),
            limit: positiveParam(query.get("limit"), FIND_LIMIT_DEFAULT, FIND_LIMIT_MAX, "limit"),
          }),
        );
      },
    },
    // Behind the engine bearer: the card reveals the sessions socket's own secret.
    { method: "GET", path: "/v2/sessions/mcp-info", auth: "engine", handle: () => ok({ mcp: mcpInfo() }) },
    {
      method: "GET",
      path: "/v2/sessions/capabilities",
      auth: "engine",
      handle: ({ query }) => ok(store.sessionCapabilities(query.get("caller") ?? undefined)),
    },
    {
      method: "POST",
      path: "/v2/sessions",
      auth: "engine",
      // The store validates every field; `origin: "session"`, `ceilingFrom` and a verified `proof` are the only provenance.
      handle: async ({ body }) => ({
        status: 201,
        body: {
          session: await store.requestPath.createSession({
            ...(body.draft === true ? { draft: true } : {}),
            id: stringValue(body.id, "session id", true),
            projectId: stringValue(body.projectId, "project id")!,
            title: stringValue(body.title, "session title", true),
            ...(typeof body.detached === "boolean" ? { detached: body.detached } : {}),
            ...(body.envMode === "worktree" || body.envMode === "local" ? { envMode: body.envMode } : {}),
            ...(typeof body.branchSlug === "string" ? { branchSlug: body.branchSlug } : {}),
            ...(typeof body.baseRef === "string" ? { baseRef: body.baseRef } : {}),
            ...(typeof body.branchName === "string" ? { branchName: body.branchName } : {}),
            ...(typeof body.driver === "string" ? { driver: body.driver as "claude" | "codex" } : {}),
            ...(typeof body.providerInstanceId === "string" ? { providerInstanceId: body.providerInstanceId } : {}),
            ...(body.origin === "session" ? { origin: "session" as const } : {}),
            ...(typeof body.ceilingFrom === "string" ? { ceilingFrom: body.ceilingFrom } : {}),
            ...(body.model === undefined ? {} : { model: modelChoice(body.model) }),
          }, senderProof(body.proof)),
        },
      }),
    },
    {
      method: "POST",
      path: /^\/v2\/sessions\/([A-Za-z0-9_-]+)\/requests\/([A-Za-z0-9_-]+)$/,
      auth: "engine",
      handle({ params: [sessionId, requestId], body }) {
        const decision = stringValue(body.decision, "decision")!;
        if (!(DECISIONS as readonly string[]).includes(decision)) throw new HttpError(400, "invalid_request", "decision is invalid");
        return ok({
          request: store.requestGate.resolve(sessionId!, requestId!, {
            decision: decision as (typeof DECISIONS)[number],
            reason: stringValue(body.reason, "reason", true),
            ...(body.answers && typeof body.answers === "object" ? { answers: body.answers as Record<string, unknown> } : {}),
            ...(body.resolvedBy === "session" || body.resolvedBy === "cancelled" ? { resolvedBy: body.resolvedBy } : {}),
          }),
        });
      },
    },
    {
      method: "DELETE",
      path: /^\/v2\/subscriptions\/([A-Za-z0-9_-]+)$/,
      auth: "engine",
      handle: ({ params, body }) => ok({ removed: store.subscriptions.unsubscribe(params[0]!, stringValue(body.subscriberSessionId, "subscriber session id", true)) }),
    },
  ];
}
