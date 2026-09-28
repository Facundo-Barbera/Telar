import type { ProjectNote } from "@telar/engine-client";
import type { EngineStore } from "../../state";
import { createNote, deleteNote, findNote, readNotes, updateNote } from "./store";
import type { NotesCapability } from "./tools";

type Patch = Parameters<NotesCapability["update"]>[2];

/** The EngineClient verbs the notebook speaks. `EngineClient` satisfies it; the daemon passes a store adapter. */
export type NotesPort = {
  listProjects(): Promise<{ projects: Array<{ id: string; name: string }> }>;
  projectNotes(projectId: string): Promise<{ notes: ProjectNote[] }>;
  createProjectNote(projectId: string, input: Parameters<NotesCapability["create"]>[1] & { author: "session" }): Promise<{ note: ProjectNote }>;
  updateProjectNote(projectId: string, noteId: string, patch: Patch): Promise<{ note: ProjectNote | null }>;
  deleteProjectNote(projectId: string, noteId: string): Promise<{ deleted: boolean }>;
};

/** What each deployment does its own way, kept as it is pending an owner decision. */
export type NotesOptions = {
  /** The session's own project, which `notes_list` defaults to; absent outside a session. */
  projectId?: string;
  /** A session reads within its own project; the daemon's socket searches every notebook. */
  read: NotesCapability["read"];
  /** A session's failed update answers null; the daemon's throws. */
  updateFailureAsNull: boolean;
};

/** Every write checks the project exists, so an unknown id cannot mint a notebook. */
export function storeNotesPort(store: EngineStore): NotesPort {
  const { paths } = store;
  return {
    listProjects: async () => ({ projects: store.listProjects() }),
    projectNotes: async (projectId) => {
      store.getProject(projectId);
      return { notes: readNotes(paths, projectId) };
    },
    createProjectNote: async (projectId, input) => {
      store.getProject(projectId);
      return { note: createNote(paths, projectId, input) };
    },
    updateProjectNote: async (projectId, noteId, patch) => {
      store.getProject(projectId);
      return { note: updateNote(paths, projectId, noteId, patch) };
    },
    deleteProjectNote: async (projectId, noteId) => ({ deleted: deleteNote(paths, projectId, noteId) }),
  };
}

export const storeNoteRead = (store: EngineStore): NotesCapability["read"] => async (noteId) => findNote(store.paths, noteId);

export function notesCapability(port: NotesPort, { projectId, read, updateFailureAsNull }: NotesOptions): NotesCapability {
  const update = async (id: string, noteId: string, patch: Patch) => (await port.updateProjectNote(id, noteId, patch)).note;
  return {
    ...(projectId ? { self: { projectId } } : {}),
    projects: async () => (await port.listProjects()).projects.map((project) => ({ id: project.id, name: project.name })),
    list: async (id) => (await port.projectNotes(id)).notes,
    read,
    create: async (id, input) => (await port.createProjectNote(id, { ...input, author: "session" })).note,
    update: updateFailureAsNull ? (id, noteId, patch) => update(id, noteId, patch).catch(() => null) : update,
    remove: async (id, noteId) => (await port.deleteProjectNote(id, noteId)).deleted,
  };
}
