import { GitHubLineCommentInput } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

/** The session branch's pull request: open it, find where a Diff line lands, and comment on that line. */
export function sessionGitHubRoutes(store: EngineStore): Route[] {
  return [
    {
      method: "POST",
      path: sessionRoute("/github/pull"),
      auth: "engine",
      async handle({ params: [sessionId], body }) {
        return ok(
          await store.openSessionPullRequest(sessionId!, {
            title: stringValue(body.title, "pull request title")!,
            ...(typeof body.body === "string" ? { body: body.body } : {}),
            ...(typeof body.base === "string" && body.base.trim() ? { base: body.base } : {}),
          }),
        );
      },
    },
    { method: "GET", path: sessionRoute("/github/pull/anchor"), auth: "engine", handle: async ({ params: [sessionId] }) => ok(await store.sessionPullAnchor(sessionId!)) },
    {
      method: "POST",
      path: sessionRoute("/github/pull/comments"),
      auth: "engine",
      async handle({ params: [sessionId], body }) {
        const input = GitHubLineCommentInput.safeParse(body);
        if (!input.success) throw new HttpError(400, "invalid_request", "a comment needs a 40-character commit, a path, a line, a side and a body");
        return ok(await store.sessionPullLineComment(sessionId!, input.data));
      },
    },
  ];
}
