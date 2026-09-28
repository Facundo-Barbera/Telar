import path from "node:path";
import { connectCard, collectTools, ensureSecretFile, handleSocketMessage as handleMessage, type SocketTool } from "../../mcp-socket";
import { notesTools, type NotesCapability } from "./tools";
import type { EngineStatePaths } from "../../state";

const NOTES_SERVER = { name: "telar-notes", version: "1.0.0" };

export function collectNotesWallTools(capability: NotesCapability): SocketTool[] {
  return collectTools(notesTools, capability);
}

// Its own secret, not the engine admin token: it grants the notebook and nothing else.
export function ensureNotesSocketSecret(paths: EngineStatePaths): string {
  return ensureSecretFile(path.join(paths.root, "notes-mcp-secret.json"));
}

export function notesSocketConnectCard(url: string, secret: string): { url: string; secret: string; addCommand: string } {
  return connectCard("telar-notes", url, secret);
}

export async function handleNotesSocketMessage(tools: readonly SocketTool[], message: unknown): Promise<unknown | undefined> {
  return handleMessage(tools, message, NOTES_SERVER);
}
