/**
 * THE SESSIONS SOCKET — the `sessions` toolkit as an OUTWARD MCP server.
 *
 * The same door `../mcp-socket.ts` opens, for this wall:
 * any LLM client the user owns — Claude Desktop, an agent in another repo,
 * anything that can `claude mcp add` — drives Telar sessions through EXACTLY
 * the tool wall a Telar session gets. That symmetry is the feature. "A session
 * can create and drive other sessions" and "the user's own chat client can" are
 * the same capability seen from two sides, and building them out of one wall is
 * what keeps them the same capability rather than two that drift.
 *
 * ── THE WALL RIDES ALONG WHOLE, AND NOTHING ELSE DOES ───────────────────────
 * The tool list is `sessionsTools` itself, collected through the same factory
 * seam the tests drive — not a second registry. So every absence the wall has
 * is an absence here BY CONSTRUCTION: no accept, no merge, no archive, no
 * delete. `test/sessions-socket.test.ts` asserts the two lists are EQUAL, which
 * is why parity is structural rather than something a person maintains.
 *
 * THE STORE'S RULES RIDE ALONG TOO: the env-mode rule, the driver check, the
 * backlog cap all live in `EngineStore`, so a chat client meets the same
 * refusal, in the same sentence, that a session inside the engine meets.
 *
 * ── A DEDICATED SECRET, NOT THE MANAGEMENT TOKEN ────────────────────────────
 * The bearer in `engine.json` is engine ADMIN. A client configured with THIS
 * secret holds the sessions wall and nothing else — it cannot archive, delete
 * or accept anything, because no such tool exists to hold. Minted once,
 * persisted at `<engine root>/sessions-mcp-secret.json`, mode 0600, and
 * distinct from the notes socket's: two doors, two keys, so revoking one chat
 * client's access to sessions does not revoke everything.
 */
import path from "node:path";
import { connectCard, collectTools, ensureSecretFile, handleSocketMessage as handleMessage, type SocketTool } from "../mcp-socket";
import { sessionsTools, type SessionsCapability } from "./tools";
import type { EngineStatePaths } from "../state";

/** How this socket introduces itself, in `initialize` and in the connect card's
 *  `claude mcp add` line. */
const SESSIONS_SERVER = { name: "telar-sessions", version: "1.0.0" };

/** THE WALL, COLLECTED — see `collectTools`. */
export function collectSessionsWallTools(capability: SessionsCapability): SocketTool[] {
  return collectTools(sessionsTools, capability);
}

const SECRET_FILE = "sessions-mcp-secret.json";

/**
 * AT THE ENGINE ROOT, not inside `sessions/`.
 *
 * `readSessions` walks that directory and takes every entry that is a DIRECTORY
 * with an id-shaped name, so a stray file there would in fact be ignored — but
 * "would be ignored" is not a reason to put a credential in the middle of the
 * user's session records. It sits beside `engine.json`, which is the other
 * secret this root holds.
 */
export function sessionsSocketSecretPath(paths: EngineStatePaths): string {
  return path.join(paths.root, SECRET_FILE);
}

/** The socket's secret: read it, or mint it exactly once. */
export function ensureSessionsSocketSecret(paths: EngineStatePaths): string {
  return ensureSecretFile(sessionsSocketSecretPath(paths));
}

/** The connect card, composed in one place so the card and the socket cannot
 *  disagree about the header shape. */
export function sessionsSocketConnectCard(url: string, secret: string): { url: string; secret: string; addCommand: string } {
  return connectCard("telar-sessions", url, secret);
}

/** One JSON-RPC message in, one answer out — or `undefined` for a
 *  notification, which the transport turns into 202 Accepted. */
export async function handleSessionsSocketMessage(tools: readonly SocketTool[], message: unknown): Promise<unknown | undefined> {
  return handleMessage(tools, message, SESSIONS_SERVER);
}
