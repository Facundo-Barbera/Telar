// Serves one attachment's bytes back to the UI — the thumbnail in a persisted
// user message, and the preview behind the pinned summary's Context section.
//
// A 404 here is a NORMAL, EXPECTED state, not an error: archiving a chat
// destroys its attachments while the transcript keeps their metadata (see
// lib/attachments.ts), so every consumer must be able to draw a tombstone.

import fs from "node:fs";
import { attachmentPath, readAttachmentMeta } from "@/lib/attachments";

export const dynamic = "force-dynamic";

/**
 * The only media types served with their own Content-Type and rendered inline.
 * Everything else — including SVG, which is a script-execution vector dressed
 * as an image, and any HTML a user drags in — is served as an opaque download,
 * because this route answers from the APP'S OWN ORIGIN and a stored file that
 * executes here reads every logged-in surface in it. Thumbnails need exactly
 * these four; nothing else is a regression.
 */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const meta = readAttachmentMeta(id);
  const file = attachmentPath(id);
  if (!meta || !file || !fs.existsSync(file)) {
    return new Response("not found", { status: 404 });
  }

  const inline = INLINE_TYPES.has(meta.mediaType);

  return new Response(fs.readFileSync(file) as unknown as BodyInit, {
    headers: {
      "Content-Type": inline ? meta.mediaType : "application/octet-stream",
      "Content-Length": String(meta.size),
      // The bytes at an id never change — the id is minted per upload — so this
      // is safe to cache hard. `private` because they are one user's files.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(meta.name)}"`,
      "X-Content-Type-Options": "nosniff",
      // Belt-and-braces for the inline case: even a PNG mislabelled by the
      // browser has no privileges under this policy.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
