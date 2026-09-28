import { workspacePath } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import type { RunMount } from "./mount";
import { RunError } from "./types";
import type { EngineStore } from "../../state";
import { holdEventStream, type OpenStream } from "../sessions";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** `/run/stream` feeds this session's terminals only; every other `/run…` tail is `runMount`'s, or the engine's 404. */
export function runRoutes(store: EngineStore, runMount: RunMount, openStreams: Set<OpenStream>): Route[] {
  const context = (sessionId: string) => () => {
    const record = store.records.get(sessionId);
    if (!record.projectId) throw new RunError("invalid_request", "runs need a project");
    const worktreePath = workspacePath(record.workspace);
    if (worktreePath === undefined) throw new RunError("invalid_request", "runs need a working directory");
    return {
      sessionId: record.id,
      projectId: record.projectId,
      worktreePath,
      ...(record.workspace.mode === "worktree" ? { worktreeBranch: record.workspace.branch } : {}),
    };
  };
  const stream: Route = {
    method: "GET",
    path: sessionRoute("/run/stream"),
    auth: "engine",
    handle({ params: [sessionId], request, response }) {
      const record = store.records.get(sessionId!);
      if (!record.projectId) throw new HttpError(400, "invalid_request", "runs need a project");
      holdEventStream(request, response, openStreams, (send) => runMount.watch(record.id, send));
      return undefined;
    },
  };
  const door = (method: (typeof METHODS)[number]): Route => ({
    method,
    path: sessionRoute("/run(?:/.*)?"),
    auth: "engine",
    async handle({ params: [sessionId], body, query, request }) {
      // The tail is passed undecoded, as the run table expects.
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const tail = pathname.slice(`/v2/sessions/${sessionId}`.length);
      const answer = runMount.handle(method, tail, method === "GET" ? Object.fromEntries(query) : body, context(sessionId!));
      if (answer === undefined) throw new HttpError(404, "not_found", "engine endpoint does not exist");
      try {
        return ok((await answer) ?? {});
      } catch (error) {
        if (error instanceof RunError) throw new HttpError(error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400, error.code, error.message);
        throw error;
      }
    },
  });
  return [stream, ...METHODS.map(door)];
}
