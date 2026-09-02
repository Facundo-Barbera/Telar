/**
 * A STORED BACKDROP PICTURE, streamed from the appearance home.
 *
 * The name is a content hash (apps/engine/src/appearance-home.ts), so the bytes
 * behind a URL can never change and the immutable cache is honest rather than
 * optimistic — a different picture is a different name.
 *
 * The engine does the refusing. This route hands the name straight through, and
 * the traversal check lives where the path is actually built, so there is one
 * boundary rather than two that can drift.
 */

import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const { name } = await params;
    const image = await (await engineClient()).appearanceImage(name);
    return new Response(image.data as BodyInit, {
      headers: {
        "content-type": image.contentType,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
