import path from "node:path";
import { collectTools, connectCard, ensureSecretFile, handleSocketMessage as handleMessage, type SocketTool } from "../../agent-tools";
import type { SessionsCapability } from "./shared";
import { sessionsTools } from "./tools";
import type { EngineStatePaths } from "../../../platform/fs/state-paths";

const SESSIONS_SERVER = { name: "telar-sessions", version: "1.0.0" };

export function collectSessionsWallTools(capability: SessionsCapability): SocketTool[] {
  return collectTools(sessionsTools, capability);
}

const SECRET_FILE = "sessions-mcp-secret.json";

function sessionsSocketSecretPath(paths: EngineStatePaths): string {
  return path.join(paths.root, SECRET_FILE);
}

export function ensureSessionsSocketSecret(paths: EngineStatePaths): string {
  return ensureSecretFile(sessionsSocketSecretPath(paths));
}

export function sessionsSocketConnectCard(url: string, secret: string): { url: string; secret: string; addCommand: string } {
  return connectCard("telar-sessions", url, secret);
}

export async function handleSessionsSocketMessage(tools: readonly SocketTool[], message: unknown): Promise<unknown | undefined> {
  return handleMessage(tools, message, SESSIONS_SERVER);
}
