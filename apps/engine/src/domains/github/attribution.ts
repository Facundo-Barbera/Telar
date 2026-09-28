const SESSION_ID = /^[A-Za-z0-9_-]+$/;

const MARKER_PREFIX = "<!-- telar-session:";
const MARKER_SUFFIX = "-->";

const MAX_SESSION_ID_LENGTH = 128;

const MARKER_LINE = /^[ \t]*<!--[ \t]*telar-session:[ \t]*([A-Za-z0-9_-]+)[ \t]*-->[ \t]*$/;

export type GitHubCommentAttribution = { sessionId: string };

export function isPublishableSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.length <= MAX_SESSION_ID_LENGTH && SESSION_ID.test(sessionId);
}

export function sessionMarker(sessionId: string): string {
  if (!isPublishableSessionId(sessionId)) {
    throw new Error("a session marker carries a session id and nothing else — letters, numbers, underscores and hyphens only");
  }
  return `${MARKER_PREFIX} ${sessionId} ${MARKER_SUFFIX}`;
}

export function withSessionMarker(body: string, sessionId: string): string {
  const marker = sessionMarker(sessionId);
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${marker}` : marker;
}

export function parseSessionAttribution(body: string): GitHubCommentAttribution | undefined {
  let found: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const match = MARKER_LINE.exec(line);
    if (match?.[1]) found = match[1];
  }
  return found ? { sessionId: found } : undefined;
}

export function stripSessionMarker(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !MARKER_LINE.test(line))
    .join("\n")
    .replace(/\s+$/, "");
}
