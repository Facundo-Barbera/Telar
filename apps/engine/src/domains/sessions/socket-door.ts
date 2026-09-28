import { mcpSocketRoute, type SocketTool } from "../agent-tools";
import type { EngineStore } from "../../state";
import { sessionsCapability, storeReads, storeSessionsPort } from "./capability";
import { collectSessionsWallTools, ensureSessionsSocketSecret, handleSessionsSocketMessage, sessionsSocketConnectCard } from "./tools/socket";

/** The outward sessions MCP socket: its own secret, minted lazily and separately from every other door's. */
export function sessionsSocketDoor(store: EngineStore, port: () => number) {
  let secret: string | undefined;
  let tools: SocketTool[] | undefined;
  const currentSecret = () => (secret ??= ensureSessionsSocketSecret(store.paths));
  // No identity: a chat client is not a session, so it has no `self`, no ceiling and no claim proof.
  const wall = () => (tools ??= collectSessionsWallTools(sessionsCapability(storeSessionsPort(store), undefined, storeReads(store))));
  return {
    secret: currentSecret,
    route: mcpSocketRoute("/v2/sessions/mcp", "sessions-socket", "sessions", (message) => handleSessionsSocketMessage(wall(), message)),
    card: () => sessionsSocketConnectCard(`http://127.0.0.1:${port()}/v2/sessions/mcp`, currentSecret()),
  };
}
