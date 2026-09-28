import { GitHubReactionContent, GitHubSubjectId, parseForgeQuery } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

/**
 * A project's issues and pull requests. `?refresh=1` is the only way past the cache.
 * Numbers and node ids are matched in the patterns because they go into a `gh` argv.
 */
export function githubRoutes(store: EngineStore): Route[] {
  return [
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/github$/,
      auth: "engine",
      async handle({ params, query }) {
        let filters;
        try {
          filters = parseForgeQuery(query);
        } catch (cause) {
          throw new HttpError(400, "invalid_request", cause instanceof Error ? cause.message : "invalid filter");
        }
        return ok({ github: await store.projectGitHub(params[0]!, { force: filters.refresh, issues: filters.issues, pulls: filters.pulls }) });
      },
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/github\/checks\/(\d+)\/log$/,
      auth: "engine",
      handle: async ({ params }) => ok({ log: await store.projectCheckLog(params[0]!, params[1]!) }),
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/github\/facets$/,
      auth: "engine",
      handle: async ({ params, query }) => ok({ facets: await store.projectForgeFacets(params[0]!, { force: query.get("refresh") === "1" }) }),
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/github\/(issues|pulls)\/(\d+)$/,
      auth: "engine",
      // "Not signed in" and "no such number" are 200 answers, so the cockpit keeps the sentence that says what to do.
      async handle({ params: [projectId, kind, number], query }) {
        const force = query.get("refresh") === "1";
        return ok(kind === "issues" ? await store.projectIssue(projectId!, Number(number), { force }) : await store.projectPull(projectId!, Number(number), { force }));
      },
    },
    {
      method: "POST",
      path: /^\/v2\/projects\/([^/]+)\/github\/(issues|pulls)\/(\d+)\/reactions$/,
      auth: "engine",
      async handle({ body, params: [projectId, kind, number] }) {
        const content = GitHubReactionContent.safeParse(body.content);
        if (!content.success) throw new HttpError(400, "invalid_request", "content must be one of GitHub's eight reactions");
        const subject = GitHubSubjectId.safeParse(body.subjectId);
        if (!subject.success) throw new HttpError(400, "invalid_request", "subjectId must be a GitHub node id");
        if (typeof body.react !== "boolean") throw new HttpError(400, "invalid_request", "react must be true or false");
        return ok(
          await store.projectGitHubReaction(projectId!, {
            kind: kind === "issues" ? "issue" : "pull",
            number: Number(number),
            subjectId: subject.data,
            content: content.data,
            react: body.react,
          }),
        );
      },
    },
    {
      method: "POST",
      path: /^\/v2\/projects\/([^/]+)\/github\/pulls\/(\d+)\/threads\/([A-Za-z0-9_=-]{1,200})\/(replies|resolve)$/,
      auth: "engine",
      async handle({ body, params: [projectId, number, threadId, verb] }) {
        if (verb === "replies") {
          if (typeof body.body !== "string") throw new HttpError(400, "invalid_request", "body must be a string");
          return ok(await store.projectThreadReply(projectId!, Number(number), { threadId: threadId!, body: body.body }));
        }
        if (typeof body.resolved !== "boolean") throw new HttpError(400, "invalid_request", "resolved must be true or false");
        return ok(await store.projectThreadResolve(projectId!, Number(number), { threadId: threadId!, resolved: body.resolved }));
      },
    },
    {
      method: "POST",
      path: /^\/v2\/projects\/([^/]+)\/github\/pulls\/(\d+)\/merge$/,
      auth: "engine",
      // `expectedHeadOid` is the head the person who pressed the button had reviewed; see `mergePull`.
      async handle({ body, params: [projectId, number] }) {
        const method = stringValue(body.method, "merge method")!;
        if (method !== "merge" && method !== "squash" && method !== "rebase") throw new HttpError(400, "invalid_request", "merge method must be merge, squash or rebase");
        return ok(await store.projectPullMerge(projectId!, Number(number), { method, expectedHeadOid: stringValue(body.expectedHeadOid, "expected head commit")! }));
      },
    },
  ];
}
