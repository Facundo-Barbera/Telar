import type { EngineTransport } from "../platform/transport";
import type { WorkspaceFile, WorkspaceListing, WorkspaceWriteResult } from "./schema";

type Owner = "projects" | "sessions";
type Bytes = { data: Uint8Array; contentType: string };

const files = (owner: Owner, id: string, path?: string, raw = false) =>
  `/v2/${owner}/${encodeURIComponent(id)}/files${raw ? "/raw" : ""}${path === undefined ? "" : `?${new URLSearchParams({ path }).toString()}`}`;

export const filesClient = {
  projectFiles(this: EngineTransport, projectId: string): Promise<{ listing: WorkspaceListing }> {
    return this.request("GET", files("projects", projectId));
  },

  sessionFiles(this: EngineTransport, sessionId: string): Promise<{ listing: WorkspaceListing }> {
    return this.request("GET", files("sessions", sessionId));
  },

  /** Fenced inside the checkout by the engine. */
  projectFile(this: EngineTransport, projectId: string, path: string): Promise<{ file: WorkspaceFile }> {
    return this.request("GET", files("projects", projectId, path));
  },

  sessionFile(this: EngineTransport, sessionId: string, path: string): Promise<{ file: WorkspaceFile }> {
    return this.request("GET", files("sessions", sessionId, path));
  },

  projectFileBytes(this: EngineTransport, projectId: string, path: string): Promise<Bytes> {
    return this.readBytes(files("projects", projectId, path, true));
  },

  sessionFileBytes(this: EngineTransport, sessionId: string, path: string): Promise<Bytes> {
    return this.readBytes(files("sessions", sessionId, path, true));
  },

  writeProjectFile(this: EngineTransport, projectId: string, path: string, text: string, expectedSha256: string): Promise<WorkspaceWriteResult> {
    return this.request("PUT", files("projects", projectId, path), { text, expectedSha256 });
  },

  writeSessionFile(this: EngineTransport, sessionId: string, path: string, text: string, expectedSha256: string): Promise<WorkspaceWriteResult> {
    return this.request("PUT", files("sessions", sessionId, path), { text, expectedSha256 });
  },
};
