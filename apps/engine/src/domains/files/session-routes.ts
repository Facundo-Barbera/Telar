import { parseDiffBaseQuery, parseFilePatchQuery } from "@telar/engine-client";
import { body, HttpError } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

const requiredPath = (query: URLSearchParams): string => {
  const target = query.get("path");
  if (!target) throw new HttpError(400, "invalid_request", "a file path is required");
  return target;
};

/** A session's review and checkout; `?path=` narrows each read to one file. */
export function sessionFilesRoutes(store: EngineStore): Route[] {
  return [
    {
      method: "GET",
      path: sessionRoute("/diff"),
      auth: "engine",
      async handle({ params: [sessionId], query }) {
        const target = query.get("path");
        if (target) return ok({ file: await store.workspaceReads.sessionFilePatch(sessionId!, target, parseFilePatchQuery(query)) });
        return ok({ diff: await store.workspaceReads.sessionDiff(sessionId!, parseDiffBaseQuery(query)) });
      },
    },
    {
      method: "GET",
      path: sessionRoute("/files"),
      auth: "engine",
      async handle({ params: [sessionId], query }) {
        // Opening a released session's files brings its checkout back, as a message does.
        store.worktrees.restore(sessionId!);
        const target = query.get("path");
        if (target) return ok({ file: await store.sessionFileAsync(sessionId!, target) });
        return ok({ listing: await store.workspaceReads.sessionFiles(sessionId!) });
      },
    },
    {
      method: "GET",
      path: sessionRoute("/files/raw"),
      auth: "engine",
      async handle({ params: [sessionId], query }) {
        const raw = await store.sessionFileBytesAsync(sessionId!, requiredPath(query));
        return {
          status: 200,
          body: null,
          bytes: raw.data,
          headers: { "content-type": raw.mediaType, "content-length": String(raw.data.byteLength), "cache-control": "no-store" },
        };
      },
    },
    {
      method: "PUT",
      path: sessionRoute("/files"),
      auth: "engine",
      body: "raw",
      async handle({ params: [sessionId], query, request }) {
        const target = requiredPath(query);
        const input = await body(request);
        return ok(store.sessionFileWrite(sessionId!, target, stringValue(input.text, "file text")!, stringValue(input.expectedSha256, "expected hash")!));
      },
    },
    {
      method: "GET",
      path: sessionRoute("/data/table"),
      auth: "engine",
      async handle({ params: [sessionId], query }) {
        return ok(
          await store.pluginDoors.table(sessionId!, requiredPath(query), {
            offset: Number(query.get("offset") ?? 0),
            limit: Math.min(Number(query.get("limit") ?? 200), 1000),
            ...(query.get("sort") ? { sort: query.get("sort")! } : {}),
            ...(query.get("desc") === "1" ? { desc: true } : {}),
          }),
        );
      },
    },
  ];
}
