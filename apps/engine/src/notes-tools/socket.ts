/**
 * THE NOTES SOCKET — the project notebook as an OUTWARD MCP server.
 *
 * The second door through `../mcp-socket.ts`, after the sessions wall's
 * and for the same stated reason: the user asked for "an API facing outwards for
 * this, for an implementation on another app". Any LLM client they own — Claude
 * Desktop, an agent in another repo, the app they are about to write — reaches
 * EXACTLY the tool wall a Telar session gets.
 *
 * ── THE WALL RIDES ALONG WHOLE, AND NOTHING ELSE DOES ───────────────────────
 * The tool list is `notesTools` itself, collected through the same factory seam
 * the tests drive — not a second registry that could drift. So every absence the
 * wall has is an absence here BY CONSTRUCTION, including the fence on
 * `notes_delete`: a chat client cannot delete the user's own notes, because the
 * wall it holds has no such verb to hold. `test/notes-socket.test.ts` asserts the
 * two lists are EQUAL, which is why parity is structural rather than maintained.
 *
 * ── A DEDICATED SECRET, NOT THE MANAGEMENT TOKEN ────────────────────────────
 * The bearer in `engine.json` is engine ADMIN. A client configured with THIS
 * secret holds the notebook and nothing else — no sessions, no files, no turns.
 * Minted once at `<engine root>/notes-mcp-secret.json`, mode 0600, and distinct
 * from the other two sockets': three doors, three keys, so revoking one app's
 * access to the notebook revokes nothing else.
 */
import path from "node:path";
import { connectCard, collectTools, ensureSecretFile, handleSocketMessage as handleMessage, type SocketTool } from "../mcp-socket";
import { notesTools, type NotesCapability } from "./tools";
import type { EngineStatePaths } from "../state";

/** How this socket introduces itself, in `initialize` and in the connect card's
 *  `claude mcp add` line. */
const NOTES_SERVER = { name: "telar-notes", version: "1.0.0" };

/** THE WALL, COLLECTED — see `collectTools`. */
export function collectNotesWallTools(capability: NotesCapability): SocketTool[] {
  return collectTools(notesTools, capability);
}

const SECRET_FILE = "notes-mcp-secret.json";

/** At the engine root, beside `sessions-mcp-secret.json` and for the reason that
 *  one states: it sits with `engine.json`, the other secret this root holds, and
 *  not in the middle of the user's notebooks. */
export function notesSocketSecretPath(paths: EngineStatePaths): string {
  return path.join(paths.root, SECRET_FILE);
}

/** The socket's secret: read it, or mint it exactly once. */
export function ensureNotesSocketSecret(paths: EngineStatePaths): string {
  return ensureSecretFile(notesSocketSecretPath(paths));
}

/** The connect card, composed in one place so the card and the socket cannot
 *  disagree about the header shape. */
export function notesSocketConnectCard(url: string, secret: string): { url: string; secret: string; addCommand: string } {
  return connectCard("telar-notes", url, secret);
}

/** One JSON-RPC message in, one answer out — or `undefined` for a notification,
 *  which the transport turns into 202 Accepted. */
export async function handleNotesSocketMessage(tools: readonly SocketTool[], message: unknown): Promise<unknown | undefined> {
  return handleMessage(tools, message, NOTES_SERVER);
}
