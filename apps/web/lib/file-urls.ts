/**
 * Where a workspace file's BYTES are served — the `src` every media viewer
 * points at (image, PDF, audio, video). Host-relative like `attachmentUrl`
 * (lib/ds.ts), and for the same reason: the route holds the engine token
 * server-side, so the browser never sees a credential.
 *
 * `version` is cache defeat, not decoration. The route already answers
 * `no-store`, but an <iframe>/<img> whose URL has not changed will not
 * re-fetch on its own — and workspace files change under their own names
 * (a recompiled PDF, a re-rendered plot). Callers pass the read's sha256 or
 * a local generation counter; either way, new bytes mean a new URL.
 */
export function rawFileUrl(
  path: string,
  options: { sessionId?: string; projectId?: string; version?: string | number },
): string | undefined {
  const query = new URLSearchParams({ path });
  if (options.version !== undefined) query.set("v", String(options.version));
  if (options.sessionId) return `/api/sessions/${encodeURIComponent(options.sessionId)}/files/raw?${query.toString()}`;
  if (options.projectId) return `/api/projects/${encodeURIComponent(options.projectId)}/files/raw?${query.toString()}`;
  return undefined;
}
