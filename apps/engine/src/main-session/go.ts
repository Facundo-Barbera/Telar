/**
 * OPENCODE GO, AS A TRANSPORT — the base URL, the headers, and the one public
 * read (#526).
 *
 * WHY RAW `fetch` AND NOT A CLIENT LIBRARY. The surface Telar uses is two
 * OpenAI-compatible endpoints: `GET /models` and a streaming
 * `POST /chat/completions`. A dependency for that is a dependency for its
 * transitive tree, its release cadence and its idea of what an error is —
 * against a handful of lines that this file can state exactly. `opencode/`
 * beside it takes the OpenCode SDK because it drives a whole local server; this
 * drives an HTTP API.
 *
 * ── THE TWO HEADERS THAT ARE NOT OPTIONAL ───────────────────────────────────
 * opencode.ai/docs/go's "Where can I use it?" welcomes third-party coding
 * agents and asks two things of them: identify yourself in `User-Agent`, and
 * carry a stable `x-opencode-session` per conversation. Both are kept as
 * promises rather than as conveniences — the session header is the SESSION's
 * id, so one Telar conversation is one upstream conversation for as long as it
 * lives, and the agent string is this build's real version (see
 * `../version.ts`), never a placeholder.
 *
 * ── NOTHING HERE HOLDS A KEY ────────────────────────────────────────────────
 * `authHeaders` takes one and returns a header map; it never reads a setting, a
 * file or an environment variable, and it never logs. Where a key COMES FROM is
 * `./credentials.ts`, which is the only module that answers that question.
 */
import { TELAR_ENGINE_VERSION } from "../version";

/** The OpenAI-compatible base. Everything below joins onto it. */
export const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";

/**
 * What runs when nobody has picked a model.
 *
 * A REAL ID RATHER THAN "the provider's default", because this API has no
 * concept of one: `POST /chat/completions` requires a `model`, so something has
 * to be named and the honest place to name it is here, once, where the setting
 * that overrides it can point at it.
 */
export const DEFAULT_GO_MODEL = "kimi-k3";

/** How this build introduces itself. One spelling, so a log on the other side
 *  can tell two Telar versions apart. */
export const GO_USER_AGENT = `telar/${TELAR_ENGINE_VERSION}`;

/**
 * The headers every call carries, plus the credential when the caller has one.
 *
 * `sessionId` IS THE TELAR SESSION'S OWN ID, unchanged and unhashed: it is
 * opaque, it is already the stable name for this conversation everywhere else,
 * and inventing a second identifier would mean storing a mapping whose only job
 * is to be looked up.
 */
export function goHeaders(input: { apiKey?: string; sessionId?: string; json?: boolean }): Record<string, string> {
  return {
    "User-Agent": GO_USER_AGENT,
    Accept: "application/json",
    ...(input.json ? { "Content-Type": "application/json" } : {}),
    ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
    ...(input.sessionId ? { "x-opencode-session": input.sessionId } : {}),
  };
}

/** How long a model list may take before it is not worth waiting for. The
 *  picker repaints; a settings page must not hang on a network. */
const MODELS_TIMEOUT_MS = 8_000;

/** One model row, narrowed to what a picker needs. Exported for the test's
 *  sake rather than for a second caller. */
export type GoModel = { id: string };

/**
 * THE PUBLIC MODEL LIST — no key, deliberately.
 *
 * The docs publish this endpoint as open, and sending a credential to an
 * endpoint that does not need one is how a key ends up in a log nobody owns.
 * So this call carries the agent string and nothing else, which also means the
 * models pane works before anybody has pasted a key — which is the order people
 * actually do it in.
 *
 * FAILS SOFT WITH THE SERVER'S OWN WORDS, the rule `readOpenCodeModels` follows:
 * an empty picker carrying the reason beats a picker full of ids that 404.
 */
export async function readOpenCodeGoModels(
  fetchImpl: typeof fetch = fetch,
  base: string = OPENCODE_GO_BASE,
): Promise<{ models: GoModel[]; message?: string }> {
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: goHeaders({}),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { models: [], message: `OpenCode Go answered ${response.status} for its model list.` };
    }
    const payload: unknown = await response.json();
    return { models: goModelIds(payload).map((id) => ({ id })) };
  } catch (error) {
    return { models: [], message: error instanceof Error ? error.message : "OpenCode Go did not answer its model list." };
  }
}

/**
 * The ids out of whatever shape came back.
 *
 * TOLERANT OF TWO SHAPES because the endpoint is OpenAI-compatible and the
 * convention there is `{ data: [...] }`, while a plain array is what a smaller
 * server often returns. Neither is guessed at beyond the id: a picker needs the
 * string, and anything else this parsed would be a field we would then have to
 * keep true.
 */
export function goModelIds(payload: unknown): string[] {
  const rows = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : [];
  const ids: string[] = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return [...new Set(ids)];
}
