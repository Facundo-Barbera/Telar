/**
 * THE SOCKET — the Spool as an OUTWARD MCP server (`docs/spool-loops.md` §10.3).
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
 * ── THE TRANSPORT IS STREAMABLE HTTP, IMPLEMENTED BY HAND ───────────────────
 * The JSON-RPC dispatch lives in `../mcp/socket.ts`, shared with the browser's
 * session socket, and is re-exported here so this module remains the spool
 * socket's whole story. See that file for what the transport is and is not.
 *
 * ── A DEDICATED SECRET, NOT THE MANAGEMENT TOKEN ────────────────────────────
 * The bearer token in `engine.json` is engine ADMIN: sessions, files, turns.
 * A chat client configured with the socket's secret holds the SPOOL WALL and
 * nothing else, so a leaked chat config cannot cost more than the wall could
 * ever do — which, by the wall's own contract, lands nothing. Minted once,
 * persisted at `spool/mcp-secret.json`, mode 0600.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";
import { type SocketTool } from "../mcp/socket";
import { spoolTools, type SpoolCapability } from "./tools";
import type { SpoolPaths } from "./store";

export { handleSocketMessage, toolInputSchema, MCP_PROTOCOL_VERSION, type SocketTool } from "../mcp/socket";

/**
 * THE WALL, COLLECTED. `spoolTools` takes its factory as an argument precisely
 * so a caller can decide what "register" means; here it means "remember", and
 * the result is the wall's own list with the wall's own handlers — the same
 * seam the bare-harness tests use, so parity with a session's toolkit is
 * structural rather than maintained.
 */
export function collectWallTools(capability: SpoolCapability): SocketTool[] {
  const collected: SocketTool[] = [];
  spoolTools((name, description, shape, handler) => {
    const tool: SocketTool = { name, description, shape, run: handler };
    collected.push(tool);
    return tool;
  }, capability);
  return collected;
}

const SECRET_FILE = "mcp-secret.json";

export function socketSecretPath(paths: SpoolPaths): string {
  return path.join(paths.root, SECRET_FILE);
}

/**
 * The socket's secret: read it, or mint it exactly once. 32 random bytes,
 * base64url — the same strength as the engine token it deliberately is not.
 * An unreadable file is re-minted rather than thrown on: the secret grants
 * nothing but the wall, and every connect card reads the current one.
 */
export function ensureSocketSecret(paths: SpoolPaths): string {
  try {
    const stored = JSON.parse(fs.readFileSync(socketSecretPath(paths), "utf8")) as { secret?: unknown };
    if (typeof stored.secret === "string" && stored.secret.length >= 32) return stored.secret;
  } catch {
    // absent or unreadable — mint below
  }
  const secret = crypto.randomBytes(32).toString("base64url");
  atomicWrite(socketSecretPath(paths), { secret, schemaVersion: 1 });
  return secret;
}

/** The connect card, composed in one place so the card and the socket cannot
 *  disagree about the header shape. */
export function socketConnectCard(url: string, secret: string): { url: string; secret: string; addCommand: string } {
  return {
    url,
    secret,
    addCommand: `claude mcp add --transport http spool ${url} --header "Authorization: Bearer ${secret}"`,
  };
}
