import { mcpSocketRoute, type SocketTool } from "../agent-tools";
import type { EngineStore } from "../../state";
import { notesCapability, storeNoteRead, storeNotesPort } from "./capability";
import { collectNotesWallTools, ensureNotesSocketSecret, handleNotesSocketMessage } from "./socket";

/** The outward notes MCP socket: its own secret, minted lazily; it opens project notebooks and nothing else. */
export function notesSocketDoor(store: EngineStore) {
  let secret: string | undefined;
  let tools: SocketTool[] | undefined;
  const wall = () => (tools ??= collectNotesWallTools(notesCapability(storeNotesPort(store), { read: storeNoteRead(store), updateFailureAsNull: false })));
  return {
    secret: () => (secret ??= ensureNotesSocketSecret(store.paths)),
    route: mcpSocketRoute("/v2/notes/mcp", "notes-socket", "notes", (message) => handleNotesSocketMessage(wall(), message)),
  };
}
