/**
 * Tags — the free-text labels items and notes already carry, projected at
 * read time (`spoolTags`) and rewritten everywhere by one verb
 * (`renameSpoolTag`), which merges when the destination name already exists.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeItem, createItem, ensureSpool, getSpoolItem, spoolPaths, type SpoolPaths } from "../src/spool/store";
import { createNote, getNote, retireNote } from "../src/spool/shelf";
import { renameSpoolTag, spoolTags } from "../src/spool/tags";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-tags-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

describe("spoolTags — the read-time projection", () => {
  test("no tag exists until something carries it", () => {
    expect(spoolTags(paths)).toEqual([]);
  });

  test("counts items and notes separately, alphabetised by tag", () => {
    createItem(paths, { title: "factura de luz", tags: ["facturación", "urgente"] });
    createItem(paths, { title: "factura de agua", tags: ["facturación"] });
    createNote(paths, { title: "runbook", body: "…", tags: ["facturación"], author: "you" });

    expect(spoolTags(paths)).toEqual([
      { tag: "facturación", items: 2, notes: 1 },
      { tag: "urgente", items: 1, notes: 0 },
    ]);
  });
});

describe("renameSpoolTag — rewrites every item and every note", () => {
  test("renames the tag on every item and note that carries it", () => {
    const a = createItem(paths, { title: "a", tags: ["urgente", "facturación"] });
    const b = createItem(paths, { title: "b", tags: ["otra"] });
    const note = createNote(paths, { title: "n", body: "…", tags: ["urgente"], author: "you" });

    const result = renameSpoolTag(paths, "urgente", "cliente");
    expect(result).toEqual({ tag: "cliente", items: 1, notes: 1 });

    const tags = spoolTags(paths);
    expect(tags.find((t) => t.tag === "cliente")).toEqual({ tag: "cliente", items: 1, notes: 1 });
    expect(tags.find((t) => t.tag === "urgente")).toBeUndefined();
    expect(tags.find((t) => t.tag === "otra")).toEqual({ tag: "otra", items: 1, notes: 0 });
    void a;
    void b;
    void note;
  });

  test("renaming onto an existing tag MERGES the two — no duplicate, one count", () => {
    createItem(paths, { title: "a", tags: ["urgente", "cliente"] });
    createItem(paths, { title: "b", tags: ["urgente"] });

    const result = renameSpoolTag(paths, "urgente", "cliente");
    expect(result).toEqual({ tag: "cliente", items: 2, notes: 0 });

    const tags = spoolTags(paths);
    expect(tags).toEqual([{ tag: "cliente", items: 2, notes: 0 }]);
  });

  test("a tag nothing carries still renames — zero rows touched, no error", () => {
    expect(renameSpoolTag(paths, "fantasma", "real")).toEqual({ tag: "real", items: 0, notes: 0 });
  });

  test("a blank name refuses with a sentence, and touches nothing", () => {
    createItem(paths, { title: "a", tags: ["urgente"] });
    expect(() => renameSpoolTag(paths, "urgente", "   ")).toThrow(/word or two/);
    expect(() => renameSpoolTag(paths, "   ", "cliente")).toThrow(/word or two/);
    expect(spoolTags(paths)).toEqual([{ tag: "urgente", items: 1, notes: 0 }]);
  });

  test("renaming a tag onto itself is refused — it would change nothing", () => {
    createItem(paths, { title: "a", tags: ["urgente"] });
    expect(() => renameSpoolTag(paths, "urgente", "urgente")).toThrow(/already called that/);
    expect(spoolTags(paths)).toEqual([{ tag: "urgente", items: 1, notes: 0 }]);
  });

  test("trims both names before comparing and writing", () => {
    createItem(paths, { title: "a", tags: ["urgente"] });
    const result = renameSpoolTag(paths, "  urgente  ", "  cliente  ");
    expect(result).toEqual({ tag: "cliente", items: 1, notes: 0 });
  });

  // 2026-08-18 — a retired note is the ORDINARY end state of a note, and
  // `spoolTags` counts retired notes on purpose (file header, same law as
  // `listNotes`). A rename that could not reach a retired carrier would be
  // able to list a tag it could never actually rename.
  test("renames a tag whose only carrier is a retired note", () => {
    const note = createNote(paths, { title: "check", body: "…", tags: ["check"], author: "you" });
    retireNote(paths, note.id, "live check done");

    const result = renameSpoolTag(paths, "check", "check2");
    expect(result).toEqual({ tag: "check2", items: 0, notes: 1 });
    expect(spoolTags(paths)).toEqual([{ tag: "check2", items: 0, notes: 1 }]);
  });

  // The law the old (verb-routed) implementation broke protects the note's
  // WORDS: what was said, and why it stopped mattering. A tag rename must
  // leave both byte-identical — only `tags` (and, incidentally, nothing else
  // `SpoolNote.parse` would touch) may differ.
  test("a renamed retired note's words and retired state are untouched", () => {
    const note = createNote(paths, { title: "Live check note", body: "the body, verbatim", tags: ["check"], author: "you" });
    const retired = retireNote(paths, note.id, "live check done");

    renameSpoolTag(paths, "check", "check2");

    const after = getNote(paths, note.id);
    expect(after?.title).toBe("Live check note");
    expect(after?.body).toBe("the body, verbatim");
    expect(after?.retired).toEqual(retired!.retired);
    expect(after?.created).toEqual(note.created);
    expect(after?.tags).toEqual(["check2"]);
  });

  test("both tags landing on one note dedup on merge, not duplicate", () => {
    createNote(paths, { title: "n", body: "…", tags: ["urgente", "cliente"], author: "you" });
    const result = renameSpoolTag(paths, "urgente", "cliente");
    expect(result).toEqual({ tag: "cliente", items: 0, notes: 1 });
    const after = spoolTags(paths);
    expect(after).toEqual([{ tag: "cliente", items: 0, notes: 1 }]);
  });

  // Closing an item drains it from the active queue (§9.3); it does not
  // freeze what indexes it. A closed item is as renameable a carrier as an
  // open one.
  test("a closed item's tags rewrite too", () => {
    const item = createItem(paths, { title: "a", tags: ["urgente"] });
    closeItem(paths, item.id);

    const result = renameSpoolTag(paths, "urgente", "cliente");
    expect(result).toEqual({ tag: "cliente", items: 1, notes: 0 });

    const after = getSpoolItem(paths, item.id);
    expect(after?.tags).toEqual(["cliente"]);
    expect(after?.closed).toBeTruthy();
  });
});
