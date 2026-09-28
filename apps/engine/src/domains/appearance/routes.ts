import type http from "node:http";
import path from "node:path";
import { body as jsonBody, HttpError, matchesETag, rawBody } from "../../platform/http/http";
import { notModified, ok, type Route, type RouteAnswer } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { isAppearanceId, listImages, putImage, readImage, readLooks, readSettings, readThemes, removeEntry, writeLook, writeSettings, writeTheme } from "./home";

const MAX_APPEARANCE_IMAGE_BYTES = 32 * 1024 * 1024;
// A published look carries its backdrop's pixels, so this one route reads up to 8 MiB.
const MAX_APPEARANCE_UPLOAD_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// Refused before buffering: a declared length past the cap ends the connection without reading a byte.
async function appearanceBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const tooLarge = () => new HttpError(413, "invalid_request", `appearance must be under ${MAX_APPEARANCE_UPLOAD_BYTES} bytes`, true);
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_APPEARANCE_UPLOAD_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_APPEARANCE_UPLOAD_BYTES) throw tooLarge();
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new HttpError(400, "invalid_request", "request body must be an object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_request", "request body is invalid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new HttpError(400, "invalid_request", "request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

const appearanceEtag = (updatedAt: number): string => `"a${updatedAt.toString(36)}"`;

const notAllowed = (allow: string, message: string): RouteAnswer => ({ status: 405, body: { error: { code: "invalid_request", message } }, headers: { allow } });

/** A 405 naming `allow` for every other method on `path`. */
function refuseOthers(path: string | RegExp, allow: readonly string[], message: string, before?: (params: string[]) => void): Route[] {
  return METHODS.filter((method) => !allow.includes(method)).map((method) => ({
    method,
    path,
    auth: "engine",
    body: "raw",
    handle: ({ params }) => {
      before?.(params);
      return notAllowed(allow.join(", "), message);
    },
  }));
}

const ENTRY = /^\/v2\/appearance\/home\/(themes|looks)\/([^/]+)$/;

const entryId = (params: string[]): string => {
  const id = params[1]!;
  if (!isAppearanceId(id)) throw new HttpError(400, "invalid_request", "id must contain only letters, numbers, underscores or hyphens");
  return id;
};

/** The files a person or an agent edits under the appearance home: themes, looks, settings and pictures. */
function appearanceHomeRoutes(root: string): Route[] {
  return [
    {
      method: "GET",
      path: "/v2/appearance/home",
      auth: "engine",
      handle() {
        const themes = readThemes(root);
        const looks = readLooks(root);
        return ok({
          settings: readSettings(root) ?? null,
          themes: themes.entries,
          looks: looks.entries,
          images: listImages(root),
          skipped: [...themes.skipped, ...looks.skipped],
        });
      },
    },
    ...refuseOthers("/v2/appearance/home", ["GET"], "the appearance home accepts GET"),
    {
      method: "PUT",
      path: "/v2/appearance/home/settings",
      auth: "engine",
      handle({ body }) {
        writeSettings(root, body);
        return ok({ ok: true });
      },
    },
    {
      method: "PUT",
      path: ENTRY,
      auth: "engine",
      body: "raw",
      async handle({ params, request }) {
        const id = entryId(params);
        const value = await jsonBody(request);
        if (params[0] === "themes") writeTheme(root, id, value);
        else writeLook(root, id, value);
        return ok({ ok: true, id });
      },
    },
    {
      method: "DELETE",
      path: ENTRY,
      auth: "engine",
      body: "raw",
      handle({ params }) {
        removeEntry(root, params[0] as "themes" | "looks", entryId(params));
        return ok({ ok: true });
      },
    },
    ...refuseOthers(ENTRY, ["PUT", "DELETE"], "accepts PUT and DELETE", entryId),
    {
      method: "POST",
      path: "/v2/appearance/home/images",
      auth: "engine",
      body: "raw",
      async handle({ request }) {
        const name = putImage(root, await rawBody(request, MAX_APPEARANCE_IMAGE_BYTES));
        if (name === undefined) throw new HttpError(400, "invalid_request", "the body must be a PNG, JPEG, GIF or WebP image");
        return ok({ ok: true, name });
      },
    },
    {
      method: "GET",
      path: /^\/v2\/appearance\/home\/images\/([^/]+)$/,
      auth: "engine",
      handle({ params }) {
        const bytes = readImage(root, params[0]!);
        if (bytes === undefined) throw new HttpError(404, "not_found", "no such image");
        return {
          status: 200,
          body: null,
          bytes,
          headers: {
            "content-type": IMAGE_TYPES[path.extname(params[0]!).slice(1)] ?? "application/octet-stream",
            // The name is a content hash, so the bytes behind it never change.
            "cache-control": "public, max-age=31536000, immutable",
            "content-length": String(bytes.byteLength),
          },
        };
      },
    },
  ];
}

/** The look one browser published for every paired client to wear, cacheable by ETag. */
export function appearanceRoutes(store: EngineStore): Route[] {
  return [
    ...appearanceHomeRoutes(store.paths.root),
    {
      method: "GET",
      path: "/v2/appearance",
      auth: "engine",
      handle({ request }) {
        const stored = store.appearance.get();
        if (!stored) return ok({ appearance: null, updatedAt: null });
        const etag = appearanceEtag(stored.updatedAt);
        if (matchesETag(request.headers["if-none-match"], etag)) return notModified(etag);
        return { status: 200, body: { appearance: stored.blob, updatedAt: stored.updatedAt }, headers: { etag } };
      },
    },
    {
      method: "PUT",
      path: "/v2/appearance",
      auth: "engine",
      body: "raw",
      async handle({ request }) {
        const written = store.appearance.set(await appearanceBody(request));
        const etag = appearanceEtag(written.updatedAt);
        return { status: 200, body: { ok: true, updatedAt: written.updatedAt, etag }, headers: { etag } };
      },
    },
    {
      method: "DELETE",
      path: "/v2/appearance",
      auth: "engine",
      body: "raw",
      handle() {
        store.appearance.clear();
        return ok({ ok: true });
      },
    },
    ...refuseOthers("/v2/appearance", ["GET", "PUT", "DELETE"], "appearance accepts GET, PUT and DELETE"),
  ];
}
