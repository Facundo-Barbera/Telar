/**
 * The shelf — notes beside the items (`docs/spool-loops.md` §10.1).
 *
 * Two layers, deliberately, mirroring the store/routes split the rest of the
 * spool suites keep: the direct-store half owns the RULES (tolerant read, the
 * author that never changes, the retire that drains), and the daemon half owns
 * the SEAM — the human route's "you" default, the loud sentences surviving as
 * 400s with their text, retirement over HTTP.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { createNote, getNote, listNotes, readShelf, retireNote, shelfPath, updateNote } from "../src/spool/shelf";
import { ensureSpool, spoolPaths, type SpoolPaths } from "../src/spool/store";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-shelf-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

describe("the store's rules", () => {
  test("a note is stamped whole at creation — author, both stamps, trimmed title, gated tags", () => {
    const note = createNote(paths, {
      title: "  NO TOCAR #302/#304  ",
      body: "Those two issues are frozen until the client confirms.",
      tags: ["guard", " guard ", "ozom"],
      subjectKey: "ozom-gv",
      author: "you",
    });
    expect(note.title).toBe("NO TOCAR #302/#304");
    expect(note.author).toBe("you");
    // The tag gate: trimmed, deduped, order kept.
    expect(note.tags).toEqual(["guard", "ozom"]);
    expect(note.created).toEqual(note.updated);
    expect(getNote(paths, note.id)).toEqual(note);
  });

  test("an empty title, an empty body, an unaddressable subject and a blank tag all refuse with sentences", () => {
    expect(() => createNote(paths, { title: " ", body: "x", author: "you" })).toThrow(/title/);
    expect(() => createNote(paths, { title: "x", body: "  ", author: "you" })).toThrow(/body/);
    expect(() => createNote(paths, { title: "x", body: "y", subjectKey: "no/slash", author: "you" })).toThrow(/subject/);
    expect(() => createNote(paths, { title: "x", body: "y", tags: [" "], author: "you" })).toThrow(/tag/i);
  });

  test("the tolerant read keeps every row it can make sense of and skips the one it cannot", () => {
    const kept = createNote(paths, { title: "keep me", body: "x", author: "you" });
    const rows = JSON.parse(fs.readFileSync(shelfPath(paths), "utf8")) as unknown[];
    fs.writeFileSync(shelfPath(paths), JSON.stringify([...rows, { id: "n-broken" }, "not even an object"]));
    expect(readShelf(paths).map((n) => n.id)).toEqual([kept.id]);
  });

  test("the author NEVER changes: the patch path refuses it by name, loudly, and edits stamp `updated` only", () => {
    const note = createNote(paths, { title: "decision", body: "we ship on friday", author: "session" });
    expect(() => updateNote(paths, note.id, { author: "you" } as never)).toThrow(/author/);
    const edited = updateNote(paths, note.id, { title: "decision — ship day", tags: ["decision"] })!;
    expect(edited.author).toBe("session");
    expect(edited.created).toEqual(note.created);
    expect(edited.body).toBe("we ship on friday");
    // Blanking the body would be a delete path wearing an edit's name.
    expect(() => updateNote(paths, note.id, { body: "  " })).toThrow(/body/);
  });

  test("retire drains, never deletes: reason required, record kept, edits refused after, idempotent", () => {
    const note = createNote(paths, { title: "old guard note", body: "x", author: "you" });
    expect(() => retireNote(paths, note.id, "  ")).toThrow(/reason/i);
    const retired = retireNote(paths, note.id, "the client confirmed — the freeze is over")!;
    expect(retired.retired?.reason).toBe("the client confirmed — the freeze is over");
    // Still on disk, still listed — dismissing drains.
    expect(listNotes(paths).map((n) => n.id)).toEqual([note.id]);
    // A retired note is a record, not a draft.
    expect(() => updateNote(paths, note.id, { title: "rewritten" })).toThrow(/retired/);
    // Re-retiring is the same state stated twice, not a re-stamp.
    expect(retireNote(paths, note.id, "another reason")).toEqual(retired);
    // And an unknown id is null, tolerantly.
    expect(retireNote(paths, "n-none", "why")).toBeNull();
  });

  test("listNotes slices by subject; a subjectless note is floating and appears only unsliced", () => {
    createNote(paths, { title: "ozom note", body: "x", subjectKey: "ozom-gv", author: "you" });
    createNote(paths, { title: "floating note", body: "y", author: "you" });
    expect(listNotes(paths, "ozom-gv").map((n) => n.title)).toEqual(["ozom note"]);
    expect(listNotes(paths).map((n) => n.title)).toEqual(["ozom note", "floating note"]);
    expect(listNotes(paths, "aurora")).toEqual([]);
  });
});

describe("the shelf over HTTP", () => {
  const roots: string[] = [];
  const daemons: EngineDaemon[] = [];

  async function client(): Promise<EngineClient> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-shelf-routes-"));
    roots.push(directory);
    const daemon = await startEngine({ engineRoot: directory });
    daemons.push(daemon);
    return new EngineClient(daemon.discovery);
  }

  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) await daemon.close();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  test("the human route stamps 'you' unless the tool wall's own declaration arrives — the items rule, on notes", async () => {
    const engine = await client();
    const byHand = (await engine.createSpoolNote({ title: "hand note", body: "mine" })).note;
    expect(byHand.author).toBe("you");
    const bySession = (await engine.createSpoolNote({ title: "agent note", body: "asked for", author: "session" })).note;
    expect(bySession.author).toBe("session");

    const { notes } = await engine.spoolNotes();
    expect(notes.map((n) => n.author)).toEqual(["you", "session"]);
    expect((await engine.spoolNote(byHand.id)).note.title).toBe("hand note");
    await expect(engine.spoolNote("n-none")).rejects.toBeInstanceOf(EngineClientError);
  });

  test("edit, retire and the subject slice work end to end, with the store's sentences surviving the seam", async () => {
    const engine = await client();
    const { note } = await engine.createSpoolNote({ title: "runbook", body: "step one", subjectKey: "ozom-gv", tags: ["ops"] });

    const edited = (await engine.updateSpoolNote(note.id, { body: "step one, step two" })).note;
    expect(edited.body).toBe("step one, step two");

    // A forbidden key is refused with the store's own sentence, not a bare 400.
    await expect(engine.updateSpoolNote(note.id, { author: "you" } as never)).rejects.toThrow(/author/);
    // A retirement without a reason is refused the same way.
    await expect(engine.retireSpoolNote(note.id, " ")).rejects.toThrow(/reason|WHY/i);

    const retired = (await engine.retireSpoolNote(note.id, "superseded by the new runbook")).note;
    expect(retired.retired?.reason).toBe("superseded by the new runbook");

    // The slice: still listed (drained, not deleted), and subject-filterable.
    expect((await engine.spoolNotes("ozom-gv")).notes.map((n) => n.id)).toEqual([note.id]);
    expect((await engine.spoolNotes("aurora")).notes).toEqual([]);
  });

  test("the search route reads the shelf too — a note is findable the moment it lands, retired ones marked", async () => {
    const engine = await client();
    await engine.createSpoolNote({ title: "facturación — guía", body: "cómo cuadrar los presupuestos", subjectKey: "ozom-gv" });
    const { hits } = await engine.spoolSearch("facturacion");
    expect(hits.map((h) => [h.kind, h.title])).toEqual([["note", "facturación — guía"]]);
  });
});
