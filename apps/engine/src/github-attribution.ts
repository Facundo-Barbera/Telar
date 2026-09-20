/**
 * WHICH SESSION WROTE THIS COMMENT — issue #791, split out of #49 §1c.
 *
 * Every agent comment in this repository arrives on github.com as the owner's
 * account, and the conversation that produced it is one `sessions_read` away
 * and completely unreachable from the comment. github.com can never close that
 * gap: it knows the GitHub identity and nothing about a session. Telar is the
 * only participant that knows both.
 *
 * ── THE MARKER IS THE ONLY CHANNEL THERE IS ─────────────────────────────────
 * A comment is a body of text and nothing else. There is no header, no field
 * and no sidecar GitHub will carry for us, so the attribution has to live IN
 * the body — as an HTML comment, which GitHub's markdown renderer drops, so a
 * reader on github.com sees the comment they were always going to see.
 *
 * ── WHAT IT MAY CONTAIN, AND WHY THAT IS A FUNCTION AND NOT A CONVENTION ────
 * This string lands on github.com and STAYS THERE. A marker is worth having
 * only if it is safe to publish forever, so the rule is enforced rather than
 * remembered: a session id and nothing else.
 *
 * The check is the engine's OWN id shape — `[A-Za-z0-9_-]+`, the charset
 * `assertId` has always enforced — and it is load-bearing rather than
 * decorative. That charset has no `/`, no `.`, no `@` and no space, so a value
 * that passes it structurally CANNOT be a filesystem path, a hostname, an email
 * address, a worktree location or a token with punctuation. `sessionMarker`
 * refuses anything else outright rather than escaping it, because a marker that
 * had to be escaped is a marker somebody already got wrong.
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
 * The id in a marker the ENGINE wrote is engine-derived: `projectGitHubComment`
 * stamps it from a verified claim token, never from a tool argument, so a model
 * driving that path cannot name a session it is not. That is the same proof
 * `Session.startedFrom` and `Turn.sender` are stamped from.
 *
 * IT IS NOT A SIGNATURE. A comment body is typed by whoever posts it, and an
 * agent with a shell can run `gh issue comment` and type any marker it likes —
 * including one naming another session, since every marker is public the moment
 * it is posted. So `parseSessionAttribution` answers "this body claims session
 * X", not "session X wrote this". The claim is worth reading because the
 * ordinary way to produce one is the engine's, and worth doubting for exactly
 * the reason stated here. Nothing downstream may treat it as authorisation.
 */

/** The engine's own id charset — see `assertId` in `state.ts`. A session id
 *  passes it; a path, a hostname or an email cannot. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The marker's fixed head, kept as a constant because THREE things have to
 * agree on it: the writer, the reader, and the test that proves a body without
 * one parses to nothing.
 */
const MARKER_PREFIX = "<!-- telar-session:";
const MARKER_SUFFIX = "-->";

/**
 * How long an id may be before this refuses to publish it.
 *
 * Not a security bound — the charset is that. This is the bound that keeps a
 * mistake from becoming a permanent one: an engine id is ~40 characters, and a
 * four-kilobyte "id" is a bug upstream that should fail here rather than land
 * on github.com.
 */
const MAX_SESSION_ID_LENGTH = 128;

/** Anchored to the start of a line so prose that happens to quote the marker —
 *  this file's own documentation, a comment explaining the feature — is not
 *  mistaken for one. */
const MARKER_LINE = /^[ \t]*<!--[ \t]*telar-session:[ \t]*([A-Za-z0-9_-]+)[ \t]*-->[ \t]*$/;

export type GitHubCommentAttribution = { sessionId: string };

/**
 * Is this id publishable?
 *
 * Exported because the refusal is worth testing directly: the guard is the
 * whole of what keeps a machine's identity off github.com, and a guard nothing
 * exercises is a comment.
 */
export function isPublishableSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.length <= MAX_SESSION_ID_LENGTH && SESSION_ID.test(sessionId);
}

/**
 * The marker for one session, or a throw.
 *
 * A THROW RATHER THAN AN OMITTED MARKER, which is the opposite of how the rest
 * of this engine's GitHub code degrades. Everything in `github.ts` answers a
 * typed nothing instead of failing, because a panel that cannot read a label
 * should still render the issue. This is the other kind of thing: the caller
 * asked to publish an identifier, and quietly publishing a DIFFERENT one — or
 * quietly publishing none while reporting success — is the failure that cannot
 * be taken back once GitHub has the comment.
 */
export function sessionMarker(sessionId: string): string {
  if (!isPublishableSessionId(sessionId)) {
    throw new Error("a session marker carries a session id and nothing else — letters, numbers, underscores and hyphens only");
  }
  return `${MARKER_PREFIX} ${sessionId} ${MARKER_SUFFIX}`;
}

/**
 * One body with its marker, ready to post.
 *
 * THE MARKER GOES LAST, AFTER A BLANK LINE. Last because a body that opens with
 * machinery reads as machinery even when the machinery is invisible — a client
 * that renders raw markdown (an email notification, `gh issue view`, a terminal)
 * shows the first line. Blank line because markdown will otherwise absorb the
 * comment into a trailing paragraph.
 */
export function withSessionMarker(body: string, sessionId: string): string {
  const marker = sessionMarker(sessionId);
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${marker}` : marker;
}

/**
 * The session a body CLAIMS, or nothing.
 *
 * THE LAST MARKER WINS. A body that quotes an earlier comment — which is how a
 * reply is written — carries that comment's marker inside the quote, and the
 * one the engine appended is at the end. Taking the first would attribute every
 * reply to whoever it was replying to.
 */
export function parseSessionAttribution(body: string): GitHubCommentAttribution | undefined {
  let found: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const match = MARKER_LINE.exec(line);
    if (match?.[1]) found = match[1];
  }
  return found ? { sessionId: found } : undefined;
}

/**
 * The body without its marker — what a surface should render.
 *
 * GitHub drops an HTML comment and so does every markdown renderer in this
 * repository, so this changes nothing a reader sees THERE. It matters for the
 * places that do not render markdown at all: `github_status` hands the head of
 * the last comment to a model as plain text, and thirty characters of marker
 * inside a three-hundred-character budget is thirty characters of the actual
 * comment that a model does not get to read.
 */
export function stripSessionMarker(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !MARKER_LINE.test(line))
    .join("\n")
    .replace(/\s+$/, "");
}
