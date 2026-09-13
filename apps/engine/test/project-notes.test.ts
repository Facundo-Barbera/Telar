/**
 * THE PROJECT NOTEBOOK — the store's rules and the routes that expose them.
 *
 * What is under test is the set of decisions `docs/design/project-notes.md`
 * makes, rather than the getters:
 *   · a note belongs to a PROJECT and every session on it sees the same one;
 *   · `author` is provenance — stamped once, never patchable, and absent on the
 *     HTTP route means the HUMAN's;
 *   · reads are tolerant per row, so a hand-edit that breaks one note costs one
 *     note and not the notebook;
 *   · delete is real (the shelf's retire is deliberately not mirrored) and
 *     deleting what is already gone is not an error;
 *   · `state.ts` is untouched, so the notebook's directory is derived and one
 *     project's file cannot be reached through another's id.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { createNote, deleteNote, findNote, notesPath, readNotes, sortNotes, updateNote, ProjectNotesError } from "../src/notes";
import { statePaths } from "../src/state";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

/** A throwaway repository with one commit — the house idiom, so a project can
 *  actually be registered rather than stubbed. */
function repo(): string {
  const root = tmp("telar-notes-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

async function withProject(): Promise<{ client: EngineClient; projectId: string; engineRoot: string }> {
  const engineRoot = tmp("telar-notes-");
  const daemon = await startEngine({ models: stubModels, engineRoot });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const { project } = await client.registerProject({ name: "aurora", root: repo() });
  return { client, projectId: project.id, engineRoot };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("the store", () => {
  test("a note is stamped with its author at creation, and no patch can move it", () => {
    const paths = statePaths(tmp("telar-notes-store-"));
    const note = createNote(paths, "p1", { title: "Deploy", body: "bun run ship", author: "session" });

    expect(note.author).toBe("session");
    expect(note.projectId).toBe("p1");
    expect(note.created.at).toBe(note.updated.at);

    // The runtime half, which a cast gets past where the type alone does not.
    expect(() => updateNote(paths, "p1", note.id, { author: "you" } as never)).toThrow(/author/);
    expect(() => updateNote(paths, "p1", note.id, { projectId: "p2" } as never)).toThrow(/identity/);
    expect(readNotes(paths, "p1")[0]!.author).toBe("session");
  });

  test("an edit moves `updated` and leaves `created` alone", () => {
    const paths = statePaths(tmp("telar-notes-store-"));
    const note = createNote(paths, "p1", { title: "Deploy", body: "old", author: "you" }, new Date(1_000_000));
    const edited = updateNote(paths, "p1", note.id, { body: "new" }, new Date(2_000_000))!;

    expect(edited.created.at).toBe(1_000_000);
    expect(edited.updated.at).toBe(2_000_000);
    expect(edited.body).toBe("new");
  });

  test("an empty body is allowed and a blank title is not", () => {
    const paths = statePaths(tmp("telar-notes-store-"));
    // "+, type a title, come back to it" is the gesture; a store that refused
    // the half-written note would lose the title the user just typed.
    expect(createNote(paths, "p1", { title: "Later", body: "", author: "you" }).body).toBe("");
    expect(() => createNote(paths, "p1", { title: "  ", body: "x", author: "you" })).toThrow(/needs a title/);
  });

  test("pinned sorts first, then the hand's order, then newest", () => {
    const stamp = (at: number) => ({ label: "Thu 10:00", at });
    const note = (id: string, extra: Record<string, unknown>) =>
      ({ id, projectId: "p1", title: id, body: "", created: stamp(1), updated: stamp(1), author: "you", schemaVersion: 1, ...extra }) as never;

    const order = sortNotes([
      note("c", { order: 2 }),
      note("a", { pinned: true, order: 5 }),
      note("b", { order: 1 }),
      note("d", {}),
    ]).map((row) => row.id);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  test("one broken row costs one note, not the notebook", () => {
    const paths = statePaths(tmp("telar-notes-store-"));
    const kept = createNote(paths, "p1", { title: "Keep", body: "x", author: "you" });
    const raw = JSON.parse(fs.readFileSync(notesPath(paths, "p1"), "utf8")) as unknown[];
    fs.writeFileSync(notesPath(paths, "p1"), JSON.stringify([{ id: "broken" }, ...raw]));

    const read = readNotes(paths, "p1");
    expect(read).toHaveLength(1);
    expect(read[0]!.id).toBe(kept.id);
  });

  test("a project id that is not a plain slug never becomes a path", () => {
    const paths = statePaths(tmp("telar-notes-store-"));
    // The one route family where a caller's string becomes a filename.
    expect(() => notesPath(paths, "../escape")).toThrow(ProjectNotesError);
    expect(() => readNotes(paths, "a/b")).toThrow(/not a project id/);
  });

  test("deleting what is already gone is the same state stated twice", () => {
    const paths = statePaths(tmp("telar-notes-store-"));
    const note = createNote(paths, "p1", { title: "Scratch", body: "", author: "session" });
    expect(deleteNote(paths, "p1", note.id)).toBe(true);
    expect(deleteNote(paths, "p1", note.id)).toBe(false);
    expect(readNotes(paths, "p1")).toHaveLength(0);
  });

  test("a note is findable by id alone, across notebooks", () => {
    const paths = statePaths(tmp("telar-notes-store-"));
    createNote(paths, "p1", { title: "One", body: "", author: "you" });
    const wanted = createNote(paths, "p2", { title: "Two", body: "", author: "session" });

    expect(findNote(paths, wanted.id)?.projectId).toBe("p2");
    expect(findNote(paths, "n-nothing")).toBeNull();
  });
});

describe("the routes", () => {
  test("a note written over HTTP is the human's; the notebook is the project's", async () => {
    const { client, projectId } = await withProject();

    const { note } = await client.createProjectNote(projectId, { title: "Deploy", body: "bun run ship" });
    expect(note.author).toBe("you");
    expect(note.projectId).toBe(projectId);

    const { notes } = await client.projectNotes(projectId);
    expect(notes.map((row) => row.title)).toEqual(["Deploy"]);
    expect((await client.projectNote(projectId, note.id)).note.body).toBe("bun run ship");
  });

  test("pin lifts a note above the unpinned ones, and unpin drops it back", async () => {
    const { client, projectId } = await withProject();
    // Newest lands at the front of its band, so without a pin the ORDER is
    // Second, First — and the pin has to be what moves First above it.
    const { note: first } = await client.createProjectNote(projectId, { title: "First" });
    await client.createProjectNote(projectId, { title: "Second" });
    expect((await client.projectNotes(projectId)).notes.map((row) => row.title)).toEqual(["Second", "First"]);

    await client.pinProjectNote(projectId, first.id, true);
    expect((await client.projectNotes(projectId)).notes.map((row) => row.title)).toEqual(["First", "Second"]);

    await client.pinProjectNote(projectId, first.id, false);
    expect((await client.projectNotes(projectId)).notes.map((row) => row.title)).toEqual(["Second", "First"]);
  });

  test("delete removes it, and a retried delete is not an error", async () => {
    const { client, projectId } = await withProject();
    const { note } = await client.createProjectNote(projectId, { title: "Scratch" });

    expect((await client.deleteProjectNote(projectId, note.id)).deleted).toBe(true);
    expect((await client.deleteProjectNote(projectId, note.id)).deleted).toBe(false);
    expect((await client.projectNotes(projectId)).notes).toHaveLength(0);
  });

  test("an unregistered project 404s rather than minting a notebook", async () => {
    const { client, engineRoot } = await withProject();
    await expect(client.projectNotes("project_nothing")).rejects.toThrow();
    await expect(client.createProjectNote("project_nothing", { title: "Ghost" })).rejects.toThrow();
    // And nothing was written for it: `getProject` runs before the store is
    // reached, so an unknown id cannot leave a file behind.
    expect(fs.existsSync(path.join(engineRoot, "notes", "project_nothing.json"))).toBe(false);
  });

  test("a missing note is a 404, and a refusal keeps its sentence", async () => {
    const { client, projectId } = await withProject();
    await expect(client.projectNote(projectId, "n-nothing")).rejects.toThrow();
    // The store's own words survive the HTTP boundary rather than becoming
    // "internal error" — see `errorFor`.
    await expect(client.createProjectNote(projectId, { title: "   " })).rejects.toThrow(/needs a title/);
  });
});
