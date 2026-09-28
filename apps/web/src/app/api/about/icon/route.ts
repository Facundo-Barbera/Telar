import fs from "node:fs";
import { buildIdentity } from "@/lib/build-identity";

/**
 * This build's app icon, as bytes — the visual half of `/api/about`.
 *
 * A SIBLING ROUTE RATHER THAN A BASE64 FIELD: the icon is a megabyte of PNG
 * that never changes for the life of a build, and inlining it would put that
 * megabyte on every poll of a route whose whole point is being cheap enough to
 * ask when everything else is broken.
 *
 * Cached IMMUTABLY on the same terms as project icons: `/api/about` hands out
 * this path with a `?v=` key derived from the file itself, so a rebuilt or
 * re-skinned instance is a different URL. The query parameter is not read here
 * — it exists purely to make the browser cache honest.
 *
 * Reads a file and nothing else. No engine, no auth of its own: exactly what
 * `/api/about` does, so the two can never disagree about who may ask.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const { icon } = buildIdentity();
  try {
    if (!icon) throw new Error("no icon on this layout");
    return new Response(new Uint8Array(fs.readFileSync(icon.path)), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    // Nothing to serve, and nothing to cache about that: an embedding without
    // the shell's assets beside it is a layout problem, not a build identity.
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
}
