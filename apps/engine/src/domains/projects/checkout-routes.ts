import path from "node:path";
import { parseFilePatchQuery, ProviderDriverKind } from "@telar/engine-client";
import { body, HttpError } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { readProjectIconBytes } from "../appearance";
import { readProviderSkillsCached, type ProviderSkillsOptions } from "../providers";
import { createIconPng } from "./icon-png";


/** A project's own checkout, for a canvas that has no session yet. */
export function projectCheckoutRoutes(store: EngineStore, providerSkills: ProviderSkillsOptions | undefined): Route[] {
  const iconPng = createIconPng(path.join(store.paths.root, "icon-png"));
  return [
    { method: "GET", path: /^\/v2\/projects\/([^/]+)\/git$/, auth: "engine", handle: async ({ params }) => ok({ git: await store.workspaceReads.projectOverview(params[0]!) }) },
    {
      method: "GET",
      path: /^\/v2\/sessions\/([^/]+)\/setup$/,
      auth: "engine",
      handle({ params, query }) {
        const sessionId = params[0]!;
        store.records.get(sessionId);
        const after = Number(query.get("after") ?? 0);
        return ok({ setup: store.setups.status(sessionId) ?? null, ...store.setups.output(sessionId, Number.isFinite(after) && after > 0 ? after : 0) });
      },
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/icon$/,
      auth: "engine",
      // `?v=` only busts caches; `?format=png` is for clients that cannot decode SVG.
      async handle({ params, query }) {
        const served = await readProjectIconBytes(await store.projectIconFileAsync(params[0]!));
        const png = served && query.get("format") === "png";
        const bytes = png ? await iconPng(served) : served?.bytes;
        if (!served || !bytes) throw new HttpError(404, "not_found", "this project has no icon");
        return {
          status: 200,
          body: null,
          bytes,
          headers: {
            "content-type": png ? "image/png" : served.contentType,
            "content-length": String(bytes.byteLength),
            "cache-control": "public, max-age=31536000, immutable",
            etag: `"${served.etag}${png ? "-png" : ""}"`,
          },
        };
      },
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/diff$/,
      auth: "engine",
      async handle({ params, query }) {
        const target = query.get("path");
        if (target) return ok({ file: await store.workspaceReads.projectFilePatch(params[0]!, target, parseFilePatchQuery(query)) });
        return ok({ diff: await store.workspaceReads.projectDiff(params[0]!) });
      },
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/files$/,
      auth: "engine",
      async handle({ params, query }) {
        const target = query.get("path");
        if (target) return ok({ file: await store.projectFileAsync(params[0]!, target) });
        return ok({ listing: await store.workspaceReads.projectFiles(params[0]!) });
      },
    },
    {
      method: "PUT",
      path: /^\/v2\/projects\/([^/]+)\/files$/,
      auth: "engine",
      body: "raw",
      async handle({ params, query, request }) {
        const target = query.get("path");
        if (!target) throw new HttpError(400, "invalid_request", "a file path is required");
        const input = await body(request);
        return ok(store.projectFileWrite(params[0]!, target, stringValue(input.text, "file text")!, stringValue(input.expectedSha256, "expected hash")!));
      },
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/skills$/,
      auth: "engine",
      // The canvas's pending driver choice, Claude when unsaid; read from the project's own checkout.
      async handle({ params, query }) {
        const project = store.projectRegistry.get(params[0]!);
        const asked = query.get("driver");
        const driver = ProviderDriverKind.safeParse(asked ?? "claude");
        if (!driver.success) throw new HttpError(400, "invalid_request", `unknown provider driver ${JSON.stringify(asked)}`);
        return ok(
          await readProviderSkillsCached({
            cacheKey: `project:${project.id}:${driver.data}`,
            driver: driver.data,
            checkout: project.root,
            ...(providerSkills?.env ? { env: providerSkills.env } : {}),
            ...(providerSkills?.loadProviderCommands ? { loadProviderCommands: providerSkills.loadProviderCommands } : {}),
          }),
        );
      },
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/files\/raw$/,
      auth: "engine",
      async handle({ params, query }) {
        const target = query.get("path");
        if (!target) throw new HttpError(400, "invalid_request", "a file path is required");
        const raw = await store.projectFileBytesAsync(params[0]!, target);
        // Unlike an attachment, a workspace file changes under its own name.
        return { status: 200, body: null, bytes: raw.data, headers: { "content-type": raw.mediaType, "content-length": String(raw.data.byteLength), "cache-control": "no-store" } };
      },
    },
  ];
}
