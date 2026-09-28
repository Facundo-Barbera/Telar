import { stringValue } from "../../platform/http/params";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

/** A refusal is a 200 with a reason: it is an answer about the repository, not a failed request. */
export function sessionGitRoutes(store: EngineStore): Route[] {
  return [
    {
      method: "POST",
      path: sessionRoute("/git/commit"),
      auth: "engine",
      handle: async ({ params: [sessionId], body }) => ok(await store.commitSessionWork(sessionId!, stringValue(body.message, "commit message")!)),
    },
    // No body is read: the branch, checkout and remote come off the session record.
    { method: "POST", path: sessionRoute("/git/push"), auth: "engine", body: "raw", handle: async ({ params: [sessionId] }) => ok(await store.pushSessionBranch(sessionId!)) },
  ];
}
