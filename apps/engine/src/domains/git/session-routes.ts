import { matchesETag } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { notModified, ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

/** A refusal is a 200 with a reason: it is an answer about the repository, not a failed request. */
export function sessionGitRoutes(store: EngineStore): Route[] {
  return [
    {
      method: "GET",
      path: sessionRoute("/git/status"),
      auth: "engine",
      handle: async ({ params: [sessionId], request }) => {
        const { etag, ...status } = await store.workspaceReads.sessionStatus(sessionId!);
        if (matchesETag(request.headers["if-none-match"], etag)) return notModified(etag);
        return { status: 200, body: status, headers: { etag, "cache-control": "no-store" } };
      },
    },
    {
      method: "POST",
      path: sessionRoute("/git/commit"),
      auth: "engine",
      handle: async ({ params: [sessionId], body }) => ok(await store.sessionGit.commit(sessionId!, stringValue(body.message, "commit message")!)),
    },
    // No body is read: the branch, checkout and remote come off the session record.
    { method: "POST", path: sessionRoute("/git/push"), auth: "engine", body: "raw", handle: async ({ params: [sessionId] }) => ok(await store.sessionGit.push(sessionId!)) },
  ];
}
