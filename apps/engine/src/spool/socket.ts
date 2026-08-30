/**
 * THE SPOOL'S SOCKET — the Spool as an OUTWARD MCP server
 * (`docs/spool-loops.md` §10.3).
 *
 * Any LLM client the user owns — Claude Desktop, a fleet agent in another
 * repo, anything that can `claude mcp add` — reaches THE SAME tool wall a
 * Telar session gets, at master scope. One store, every agent the user owns.
 *
 * ── THE WALL RIDES ALONG WHOLE, AND NOTHING ELSE DOES ───────────────────────
 * The tool list is `spoolTools` itself, collected through the same factory
 * seam the tests drive — not a second registry that could drift. Everything
 * the wall refuses stays refused here BY CONSTRUCTION: no close, no reopen, no
 * accept, no delete, no lane structure — none of those are on the wall, so
 * none of them can be on the socket, and a test asserts the two lists are
 * equal.
 *
 * ── THE TRANSPORT AND THE SECRET NOW LIVE IN `../mcp-socket` ────────────────
 * They were written here first and moved when the `sessions` toolkit wanted
 * the identical thing. This file keeps its own exported names and signatures
 * so nothing that already reads "the spool's socket" has to learn a second
 * spelling; each is a one-line binding to the shared implementation. The
 * SPOOL-SPECIFIC facts — where the secret file lives, what the server calls
 * itself, what the connect card names the server in the user's client — are
 * what remain.
 */
import path from "node:path";
import { connectCard, collectTools, ensureSecretFile, handleSocketMessage as handleMessage, type SocketTool } from "../mcp-socket";
import { spoolTools, type SpoolCapability } from "./tools";
import type { SpoolPaths } from "./store";

export { toolInputSchema, MCP_PROTOCOL_VERSION, type SocketTool } from "../mcp-socket";

/** How this socket introduces itself, in `initialize` and in the connect card's
 *  `claude mcp add` line. */
const SPOOL_SERVER = { name: "telar-spool", version: "1.0.0" };

/** THE WALL, COLLECTED — see `collectTools`. */
export function collectWallTools(capability: SpoolCapability): SocketTool[] {
  return collectTools(spoolTools, capability);
}

const SECRET_FILE = "mcp-secret.json";

export function socketSecretPath(paths: SpoolPaths): string {
  return path.join(paths.root, SECRET_FILE);
}

/** The socket's secret: read it, or mint it exactly once. Minted at
 *  `spool/mcp-secret.json`, mode 0600. */
export function ensureSocketSecret(paths: SpoolPaths): string {
  return ensureSecretFile(socketSecretPath(paths));
}

/** The connect card, composed in one place so the card and the socket cannot
 *  disagree about the header shape. */
export function socketConnectCard(url: string, secret: string): { url: string; secret: string; addCommand: string } {
  return connectCard("spool", url, secret);
}

/** One JSON-RPC message in, one answer out — or `undefined` for a
 *  notification, which the transport turns into 202 Accepted. */
export async function handleSocketMessage(tools: readonly SocketTool[], message: unknown): Promise<unknown | undefined> {
  return handleMessage(tools, message, SPOOL_SERVER);
}
