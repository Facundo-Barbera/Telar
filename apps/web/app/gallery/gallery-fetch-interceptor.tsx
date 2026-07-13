"use client";

import { useEffect } from "react";
import { resolveGalleryFetch } from "@/lib/gallery-fixtures";

// The ENTIRE seam glue. While a gallery page is mounted this wraps window.fetch
// so the leaf self-fetchers inside the real components (SpecDrawer/WorkstreamsPreview
// → /spec, ChatTab → /chat, EvidenceImage → /evidence, plus the loom/threads GETs)
// resolve from fixtures instead of hitting the backend. resolveGalleryFetch matches
// ONLY GALLERY_ID_PREFIX ids (+ /api/chat); every other URL is delegated to the real
// fetch untouched. Restored on unmount → zero production leak, zero component edits.

function dataUriToResponse(dataUri: string): Response {
  const match = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(dataUri);
  if (!match) return new Response(null, { status: 404 });
  const mime = match[1] || "application/octet-stream";
  const isBase64 = !!match[2];
  const raw = match[3];
  let body: BlobPart;
  if (isBase64) {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    body = bytes;
  } else {
    body = decodeURIComponent(raw);
  }
  return new Response(new Blob([body], { type: mime }), {
    status: 200,
    headers: { "content-type": mime },
  });
}

export function GalleryFetchInterceptor() {
  useEffect(() => {
    const orig = window.fetch;
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method =
        init?.method ??
        (typeof input === "object" && input !== null && "method" in input
          ? (input as Request).method
          : "GET");
      const body = init?.body?.toString();
      const r = resolveGalleryFetch({ url, method, body });
      if (r.kind === "passthrough") return orig(input, init);
      if (r.kind === "image") return dataUriToResponse(r.dataUri);
      return Response.json(r.body, { status: r.status ?? 200 });
    };
    return () => {
      window.fetch = orig;
    };
  }, []);
  return null;
}
