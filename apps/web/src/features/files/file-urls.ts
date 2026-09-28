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
