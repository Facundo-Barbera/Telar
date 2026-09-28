import type { EngineTransport } from "../platform/transport";
import type { NotesMcpInfo, ProjectNote, ProjectNoteAuthor } from "./schema";

const notesPath = (projectId: string) => `/v2/projects/${encodeURIComponent(projectId)}/notes`;
const notePath = (projectId: string, noteId: string) => `${notesPath(projectId)}/${encodeURIComponent(noteId)}`;

export const notesClient = {
  projectNotes(this: EngineTransport, projectId: string): Promise<{ notes: ProjectNote[] }> {
    return this.request("GET", notesPath(projectId));
  },

  projectNote(this: EngineTransport, projectId: string, noteId: string): Promise<{ note: ProjectNote }> {
    return this.request("GET", notePath(projectId, noteId));
  },

  /** `body` may be empty: a note is often a title written now and filled in later. */
  createProjectNote(
    this: EngineTransport,
    projectId: string,
    input: { title: string; body?: string; pinned?: boolean; author?: ProjectNoteAuthor },
  ): Promise<{ note: ProjectNote }> {
    return this.request("POST", notesPath(projectId), input);
  },

  updateProjectNote(
    this: EngineTransport,
    projectId: string,
    noteId: string,
    patch: { title?: string; body?: string; pinned?: boolean; order?: number },
  ): Promise<{ note: ProjectNote }> {
    return this.request("PATCH", notePath(projectId, noteId), patch);
  },

  deleteProjectNote(this: EngineTransport, projectId: string, noteId: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", notePath(projectId, noteId));
  },

  pinProjectNote(this: EngineTransport, projectId: string, noteId: string, pinned: boolean): Promise<{ note: ProjectNote }> {
    return this.request("POST", `${notePath(projectId, noteId)}/pin`, { pinned });
  },

  notesMcpInfo(this: EngineTransport): Promise<{ mcp: NotesMcpInfo }> {
    return this.request("GET", "/v2/notes/mcp-info");
  },
};
