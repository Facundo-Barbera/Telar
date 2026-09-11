/**
 * The `notes` toolkit — what it does with the project nobody named.
 *
 * `notes-socket.test.ts` drives the wall end to end over HTTP, where `self` is
 * deliberately ABSENT. This file drives the other half: inside a session the
 * project is implied, and an agent asked "what does the deploy note say?" must
 * not have to guess an id first. That defaulting is the difference between the
 * two doors, so it is asserted rather than described.
 */
import { describe, expect, test } from "bun:test";
import type { ProjectNote } from "@telar/engine-client";
import { notesTools, type NotesCapability } from "../src/notes-tools/tools";

type Registered = {
  name: string;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

const stamp = { label: "Thu 10:00", at: 1 };
const note = (extra: Partial<ProjectNote> = {}): ProjectNote =>
  ({ id: "n-1", projectId: "p1", title: "Deploy", body: "bun run ship", created: stamp, updated: stamp, author: "you", schemaVersion: 1, ...extra }) as ProjectNote;

function build(capability: Partial<NotesCapability> = {}) {
  const registered: Registered[] = [];
  const factory = (name: string, _description: string, _shape: Record<string, unknown>, run: Registered["run"]) => {
    registered.push({ name, run });
    return { name };
  };
  const full: NotesCapability = {
    projects: capability.projects ?? (async () => [{ id: "p1", name: "aurora" }]),
    list: capability.list ?? (async () => [note()]),
    read: capability.read ?? (async () => ({ note: note(), projectId: "p1" })),
    create: capability.create ?? (async (projectId, input) => note({ projectId, ...input, author: "session" })),
    update: capability.update ?? (async (projectId, _id, patch) => note({ projectId, ...patch })),
    remove: capability.remove ?? (async () => true),
    ...(capability.self ? { self: capability.self } : {}),
  };
  notesTools(factory as never, full);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((entry) => entry.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    const result = await tool.run(args);
    return { isError: result.isError === true, text: (result.content[0] as { text: string }).text };
  };
  return { names: registered.map((entry) => entry.name), call };
}

describe("the wall", () => {
  test("is exactly five tools — no rename, no reorder, no sixth slipped in", () => {
    expect([...build().names].sort()).toEqual(["notes_delete", "notes_list", "notes_projects", "notes_read", "notes_write"]);
  });
});

describe("whose project is meant", () => {
  test("inside a session the project is implied and may be omitted", () => {
    const asked: string[] = [];
    const wall = build({ self: { projectId: "p1" }, list: async (projectId) => (asked.push(projectId), [note()]) });
    return wall.call("notes_list").then((answer) => {
      expect(answer.isError).toBe(false);
      expect(asked).toEqual(["p1"]);
    });
  });

  test("a named project wins over the session's own", async () => {
    const asked: string[] = [];
    const wall = build({ self: { projectId: "p1" }, list: async (projectId) => (asked.push(projectId), []) });
    await wall.call("notes_list", { projectId: "p2" });
    expect(asked).toEqual(["p2"]);
  });

  test("with no session and no argument it asks for one by name rather than guessing", async () => {
    // The outward socket's case. A wall that picked a project here would write
    // a note into whichever notebook happened to sort first.
    const answer = await build().call("notes_list");
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("notes_projects");
  });
});

describe("writing", () => {
  test("a new note needs a title; an edit does not", async () => {
    const wall = build({ self: { projectId: "p1" } });
    expect((await wall.call("notes_write", { body: "orphan" })).isError).toBe(true);
    expect((await wall.call("notes_write", { noteId: "n-1", body: "just the body" })).isError).toBe(false);
  });

  test("the wall declares the author — no shape on it carries one", async () => {
    const wall = build({ self: { projectId: "p1" } });
    const written = JSON.parse((await wall.call("notes_write", { title: "Deploy" })).text) as { author: string };
    expect(written.author).toBe("session");
  });

  test("an id nothing goes by is a sentence, not a silent create", async () => {
    const wall = build({ self: { projectId: "p1" }, update: async () => null });
    const answer = await wall.call("notes_write", { noteId: "n-nothing", body: "x" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("n-nothing");
  });
});

describe("the delete fence", () => {
  test("an agent's note goes; the user's is refused with the reason", async () => {
    const removed: string[] = [];
    const mine = build({ read: async () => ({ note: note({ author: "session" }), projectId: "p1" }), remove: async (_p, id) => (removed.push(id), true) });
    expect((await mine.call("notes_delete", { noteId: "n-1" })).isError).toBe(false);
    expect(removed).toEqual(["n-1"]);

    const theirs = build({ read: async () => ({ note: note({ author: "you" }), projectId: "p1" }), remove: async () => true });
    const refused = await theirs.call("notes_delete", { noteId: "n-1" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("written by the user");
  });

  test("the fence is checked BEFORE the remove, not after", async () => {
    // The whole point: a delete that happened and then apologised would be the
    // same delete. The capability must never be reached for a human's note.
    let called = false;
    const wall = build({
      read: async () => ({ note: note({ author: "you" }), projectId: "p1" }),
      remove: async () => ((called = true), true),
    });
    await wall.call("notes_delete", { noteId: "n-1" });
    expect(called).toBe(false);
  });
});
