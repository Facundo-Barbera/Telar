import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { specDir } from "@telar/core";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".feature": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
};

// Read-only serve of a single Spec Bundle file (docs/loom-model.md §2 — "the
// god-view serves and renders the bundle, reusing the evidence-serving
// path"). Path-traversal guarded: the resolved target must stay inside
// specDir(id).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path: segments } = await params;

  let base: string;
  try {
    base = specDir(id);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  const target = path.resolve(base, ...segments);

  // Reject anything resolving outside the spec dir (.., absolute, symlink-ish).
  const rel = path.relative(base, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return new Response("Forbidden", { status: 403 });
  }

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response("Not Found", { status: 404 });
  }

  const contentType =
    CONTENT_TYPES[path.extname(target).toLowerCase()] ??
    "application/octet-stream";

  const stream = Readable.toWeb(
    createReadStream(target),
  ) as ReadableStream<Uint8Array>;

  return new Response(stream, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
