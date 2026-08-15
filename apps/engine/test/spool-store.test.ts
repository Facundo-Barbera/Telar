/**
 * The Spool store's proof — ported from `packages/core/test/workspace-store.test.ts`.
 *
 * SANDBOX MECHANISM: an `fs.mkdtempSync` root per test, handed to every verb as
 * `SpoolPaths`. This is strictly simpler than the donor's, and the difference is
 * the port's whole point: the donor pinned `TELAR_HOME` at module scope AND
 * re-pinned it in a `beforeEach`, because the store read a global and a sibling
 * suite in the same bun process could move it out from under this one. The root
 * is now an argument, so there is no global to move and no way for this suite to
 * reach an operator's real state root by forgetting a line.
 *
 * WHAT IS PROVED WITH A CONTENT HASH AND NOT AN MTIME: "this file was not
 * rewritten", and its two-direction twin "this file WAS". macOS mtime resolution
 * is coarse enough that a rewrite inside one tick passes an mtime check, so the
 * claim would be a comment wearing a test's clothes. sha256 of the bytes cannot
 * be fooled that way.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPOOL_ITEM_SCHEMA_VERSION, SpoolItem, SpoolLane } from "@telar/engine-client";
import {
  addSubtask,
  agentsAddedCount,
  applyExpertPass,
  attachmentTally,
  createItem,
  createLane,
  deskSlice,
  ensureSpool,
  expertDigestPath,
  getSpoolItem,
  listExpertDigests,
  listItems,
  migratePacket,
  minedCommitments,
  promoteSubtask,
  queueSlice,
  rankOf,
  readExpertDigest,
  readLanes,
  readPacketAttachments,
  renameLane,
  reorderLane,
  retireLane,
  setSubtaskDone,
  spoolPaths,
  storeEntries,
  subjectSlice,
  updateItem,
  writeExpertDigest,
  writeLanes,
  type SpoolItemPatch,
  type SpoolPaths,
} from "../src/spool/store";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-store-"));
let paths: SpoolPaths;

beforeEach(() => {
  // A fresh store per test. The engine root is the sandbox; `spool/` under it is
  // what gets cleared, so nothing outside this temp directory is ever touched.
  fs.rmSync(path.join(ROOT, "spool"), { recursive: true, force: true });
  paths = spoolPaths(ROOT);
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── local helpers (paths composed here on purpose: this suite asserts the
//    LAYOUT, so re-deriving it from the module under test would assert nothing) ─
const lanesPath = () => path.join(ROOT, "spool", "lanes.json");
const packetDirOf = (id: string) => path.join(ROOT, "spool", "packets", id);
const packetPath = (id: string) => path.join(packetDirOf(id), "packet.json");
const hashOf = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const lane = (key: string, items: string[] = []): SpoolLane => ({
  key,
  label: key.toUpperCase(),
  window: "whenever",
  items,
});

// ── the store's layout ──────────────────────────────────────────────────────

describe("the store's layout on disk", () => {
  test("ensureSpool creates lanes.json, packets/ and a home/ that holds NO store files", () => {
    ensureSpool(paths);

    expect(paths.root).toBe(path.join(ROOT, "spool"));
    expect(paths.home).toBe(path.join(ROOT, "spool", "home"));
    expect(fs.existsSync(lanesPath())).toBe(true);
    expect(fs.existsSync(paths.packets)).toBe(true);

    // The master's cwd is a dedicated, EMPTY directory, so "the store above it
    // stays outside the master's path-based write boundary" is at least true of
    // the LAYOUT. The mechanism that makes it a real boundary is a later stage's.
    expect(fs.existsSync(paths.home)).toBe(true);
    const homeEntries = fs.readdirSync(paths.home);
    expect(homeEntries).toEqual([]);
    expect(homeEntries).not.toContain("lanes.json");
    expect(homeEntries).not.toContain("packets");
  });

  test("storeEntries names the two entries a session must not rewrite, and NOT the master's home", () => {
    // The list a path-protection mechanism will consume. `home/` must stay out:
    // protecting a session's own working directory would deny every write it is
    // meant to make. `experts/` must stay out too — protection denies reads, and
    // the master is required to read digests.
    expect(storeEntries(paths)).toEqual([lanesPath(), path.join(ROOT, "spool", "packets")]);
    expect(storeEntries(paths)).not.toContain(paths.home);
    expect(storeEntries(paths)).not.toContain(paths.experts);
  });

  test("the store seeds EXACTLY ONE ordinary lane — written by the ensure step, never by a tool", () => {
    ensureSpool(paths);
    const lanes = readLanes(paths);
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.key).toBe("unfiled");
    expect(lanes[0]!.items).toEqual([]);
    // An ORDINARY row: it carries the same fields every other lane does and no
    // extra ones, which is what "carries no special behaviour" means structurally.
    expect(Object.keys(lanes[0]!).sort()).toEqual(["items", "key", "label", "note", "window"]);
  });

  test("an item is packets/<id>/packet.json and attachments are its SIBLINGS", () => {
    const item = createItem(paths, { title: "a one-liner" });
    expect(fs.existsSync(packetPath(item.id))).toBe(true);
    fs.writeFileSync(path.join(packetDirOf(item.id), "notes.md"), "# gathered along the way");
    expect(fs.readdirSync(packetDirOf(item.id)).sort()).toEqual(["notes.md", "packet.json"]);
  });

  test("a read against a root with NO spool/ returns the empty values and does not throw", () => {
    // A store that has never been written is the ordinary first-run state, not
    // an error.
    expect(fs.existsSync(paths.root)).toBe(false);
    expect(readLanes(paths)).toEqual([]);
    expect(listItems(paths)).toEqual({ items: [], unreadable: [] });
    expect(getSpoolItem(paths, "i-nothing")).toBeNull();
    expect(rankOf([], "i-nothing")).toBeNull();
    expect(queueSlice([], [])).toEqual([]);
    expect(deskSlice([])).toEqual([]);
  });

  test("ensureSpool is idempotent and does NOT resurrect a retired seed lane", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office")]); // the human retired `unfiled` and made their own
    ensureSpool(paths);
    expect(readLanes(paths).map((l) => l.key)).toEqual(["office"]);
  });

  test("a malformed or traversal item id is treated as not-found, never as a 500", () => {
    ensureSpool(paths);
    for (const bad of ["../../etc", "a/b", "", "..", "has space"]) {
      expect(getSpoolItem(paths, bad)).toBeNull();
    }
  });

  test("the traversal guard CONTAINS — a real readable packet outside packets/ is not reachable by id", () => {
    // The test above proves "not a 500" and NOT containment: with the guard
    // deleted entirely, every id there still resolves to a path that does not
    // exist, so it returns null anyway and the suite stays green. This plants a
    // VALID packet at a path a traversal id would reach, so the only way to
    // return null is to refuse the id.
    ensureSpool(paths);
    const inside = createItem(paths, { title: "the real one" });
    const escaped = path.join(ROOT, "spool", "escaped");
    fs.mkdirSync(escaped, { recursive: true });
    writeJson(path.join(escaped, "packet.json"), {
      ...getSpoolItem(paths, inside.id),
      id: "escaped",
      title: "OUTSIDE packets/",
    });
    // The plant is genuinely readable — otherwise this proves nothing.
    expect(readJson(path.join(escaped, "packet.json")).title).toBe("OUTSIDE packets/");
    const outsideBefore = hashOf(path.join(escaped, "packet.json"));

    expect(getSpoolItem(paths, "../escaped")).toBeNull();
    expect(readPacketAttachments(paths, "../escaped")).toEqual([]);
    // …and the WRITE direction is contained too: the same id reaches no file.
    expect(updateItem(paths, "../escaped", { title: "clobbered" })).toBeNull();
    expect(hashOf(path.join(escaped, "packet.json"))).toBe(outsideBefore);
  });
});

// ── one shape for all items ─────────────────────────────────────────────────

describe("one shape for all items", () => {
  const RIPE = {
    title: "Rework onboarding flow",
    project: "aurora",
    raw: "onboarding feels clunky?? ask diego — maybe merge steps 2/3",
    rawSource: "Telar Note · Tue 16:42",
  };

  test("a bare one-liner and a fully ripened packet go through ONE writer, ONE reader and ONE schema", () => {
    ensureSpool(paths);
    const bare = createItem(paths, { title: "call María" });
    const ripe = createItem(paths, RIPE);

    const readBare = getSpoolItem(paths, bare.id)!;
    const readRipe = getSpoolItem(paths, ripe.id)!;
    expect(SpoolItem.safeParse(readBare).success).toBe(true);
    expect(SpoolItem.safeParse(readRipe).success).toBe(true);

    // The bare one has no tally and no attachments — and needed no second path
    // to get there.
    expect(readPacketAttachments(paths, bare.id)).toEqual([]);
    expect(attachmentTally(readPacketAttachments(paths, bare.id))).toEqual({ files: 0, mockups: 0 });
    expect(readBare.raw).toBeUndefined();
    expect(readRipe.raw).toBe(RIPE.raw);
    expect(readRipe.rawSource).toBe(RIPE.rawSource);
    // Both carry a version, because there is only one shape to version.
    expect(readBare.schemaVersion).toBe(SPOOL_ITEM_SCHEMA_VERSION);
    expect(readRipe.schemaVersion).toBe(SPOOL_ITEM_SCHEMA_VERSION);
  });

  test("adding an attachment changes the TALLY and rewrites NO packet.json — content hash, not mtime", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "gather the mockups" });
    const before = hashOf(packetPath(item.id));
    expect(attachmentTally(readPacketAttachments(paths, item.id))).toEqual({ files: 0, mockups: 0 });

    fs.writeFileSync(path.join(packetDirOf(item.id), "brief.md"), "the brief");
    fs.writeFileSync(path.join(packetDirOf(item.id), "flow.png"), "not really a png");

    expect(attachmentTally(readPacketAttachments(paths, item.id))).toEqual({ files: 1, mockups: 1 });
    // THIS is what "no migration when an item grows" means mechanically, and it
    // is only true because the tally is derived rather than persisted.
    expect(hashOf(packetPath(item.id))).toBe(before);
  });
});

// ── atomic writes ───────────────────────────────────────────────────────────

describe("atomic writes", () => {
  test("no temp file survives any write path", () => {
    ensureSpool(paths);
    const a = createItem(paths, { title: "one" });
    createItem(paths, { title: "two" });
    updateItem(paths, a.id, { title: "one, renamed" });
    writeLanes(paths, readLanes(paths));

    const strays: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        // The engine's writer uses `<file>.tmp-<pid>-<uuid>`, not `<file>.tmp`.
        else if (e.name.includes(".tmp-")) strays.push(abs);
      }
    };
    walk(paths.root);
    expect(strays).toEqual([]);
  });
});

// ── the version field and migrate-on-read ───────────────────────────────────

describe("migrate-on-read — five behaviours, five tests", () => {
  const base = {
    id: "i-abc123",
    title: "a hand-authored packet",
    provenance: "note",
    captured: "Tue 16:42",
  };

  test("ABSENT schemaVersion normalises to 1 BEFORE any comparison — the hand-authored case", () => {
    const out = migratePacket({ ...base }) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(1);
    // …and it really parses, so "normalised" is not merely a field edit.
    expect(SpoolItem.parse(out).schemaVersion).toBe(1);
  });

  test("LOWER migrates up the ladder — the 0 → 1 rung mints the sub-task ids the fixtures' shape lacks", () => {
    const v0 = {
      ...base,
      schemaVersion: 0,
      // exactly the design-source fixtures' shape: {title, done?} and NO id
      subtasks: [{ title: "draft the copy" }, { title: "draft the copy" }, { title: "ship it", done: true }],
    };
    const out = migratePacket(v0) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(1);
    const subtasks = out.subtasks as Array<Record<string, unknown>>;
    expect(subtasks.length).toBe(3);
    for (const st of subtasks) expect(typeof st.id).toBe("string");
    // Two sub-tasks sharing a title still get DISTINCT ids — a title is not an
    // address, which is the whole reason the rung exists.
    expect(new Set(subtasks.map((s) => s.id)).size).toBe(3);
    expect(subtasks[2]!.done).toBe(true);
    // Deterministic: the same input migrates to the same ids.
    expect(migratePacket(v0)).toEqual(out);
    expect(SpoolItem.safeParse(out).success).toBe(true);
  });

  test("EQUAL is returned UNTOUCHED — the discriminator, without which 'migrate everything on every read' passes", () => {
    const current = { ...base, schemaVersion: SPOOL_ITEM_SCHEMA_VERSION };
    // Identity, not merely deep equality: a migratePacket that rebuilt the
    // object on every read would satisfy toEqual and fail this.
    expect(migratePacket(current)).toBe(current);
  });

  test("HIGHER throws — never migrated down, never defaulted", () => {
    let thrown: Error | null = null;
    try {
      migratePacket({ ...base, schemaVersion: SPOOL_ITEM_SCHEMA_VERSION + 1 });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    // The diagnosis, in the asserted value: the rule, the consequence, the next
    // step.
    expect(thrown!.message).toContain("newer Telar");
    expect(thrown!.message).toContain("Upgrade Telar");
  });

  test("MALFORMED throws, same shape", () => {
    for (const bad of [null, 42, "a string", ["an", "array"]]) {
      expect(() => migratePacket(bad)).toThrow(/must be a JSON object/);
    }
    expect(() => migratePacket({ ...base, schemaVersion: "one" })).toThrow(/schemaVersion/);
  });

  test("lanes.json's schema carries NO version field and packet.json's DOES — asserted in both directions", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "versioned" });

    const lanesRaw = readJson(lanesPath()) as Record<string, unknown>[];
    for (const l of lanesRaw) {
      expect(Object.keys(l)).not.toContain("version");
      expect(Object.keys(l)).not.toContain("schemaVersion");
    }
    // The schema itself, not merely today's written bytes: an unknown key on a
    // lane is STRIPPED, which is what "lanes.json is not versioned" means.
    const stripped = SpoolLane.parse({ ...lane("x"), schemaVersion: 9 }) as Record<string, unknown>;
    expect(stripped.schemaVersion).toBeUndefined();

    expect((readJson(packetPath(item.id)) as Record<string, unknown>).schemaVersion).toBe(SPOOL_ITEM_SCHEMA_VERSION);
  });

  test("migrate-on-read writes NOTHING back — content hash unchanged across a read", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "read me" });
    // Plant a lower version by hand, so the read genuinely migrates.
    writeJson(packetPath(item.id), { ...readJson(packetPath(item.id)), schemaVersion: 0 });
    const before = hashOf(packetPath(item.id));

    const read = getSpoolItem(paths, item.id)!;
    expect(read.schemaVersion).toBe(SPOOL_ITEM_SCHEMA_VERSION); // it DID migrate in memory
    expect(hashOf(packetPath(item.id))).toBe(before); // …and wrote nothing back

    // The migrated shape lands on the next LEGITIMATE write.
    updateItem(paths, item.id, { title: "read me twice" });
    expect((readJson(packetPath(item.id)) as Record<string, unknown>).schemaVersion).toBe(SPOOL_ITEM_SCHEMA_VERSION);
  });

  test("an UNKNOWN key set by hand survives an updateItem rewrite — the looseObject proof", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "written by a newer telar", raw: "the original words" });
    writeJson(packetPath(item.id), {
      ...readJson(packetPath(item.id)),
      aFieldThisBuildHasNeverHeardOf: { nested: ["shape", 1] },
    });

    const read = getSpoolItem(paths, item.id)! as Record<string, unknown>;
    expect(read.aFieldThisBuildHasNeverHeardOf).toEqual({ nested: ["shape", 1] });

    updateItem(paths, item.id, { title: "renamed" });

    const after = readJson(packetPath(item.id)) as Record<string, unknown>;
    expect(after.aFieldThisBuildHasNeverHeardOf).toEqual({ nested: ["shape", 1] });
    expect(after.title).toBe("renamed");
    expect(after.raw).toBe("the original words");
  });

  test("the survival goes ALL THE WAY DOWN — a hand-added key INSIDE `deadline` survives too", () => {
    // The claim was true one level deep and false everywhere else in the donor's
    // first pass, which is the worst of the three states because it looks like
    // the good one: the item was loose while every shape it nests was strict, so
    // a key hand-added under `deadline` was DESTROYED by the next update while a
    // top-level one survived. Nested user text is exactly what the version field
    // protects.
    ensureSpool(paths);
    const item = createItem(paths, { title: "with a deadline" });
    updateItem(paths, item.id, { deadline: { label: "Fri", kind: "self" } });
    const onDisk = readJson(packetPath(item.id)) as Record<string, unknown>;
    writeJson(packetPath(item.id), {
      ...onDisk,
      deadline: { label: "Fri", kind: "self", userNote: "the one I keep sliding" },
      timeline: [{ ...(onDisk.timeline as Record<string, unknown>[])[0]!, mood: "resigned" }],
    });

    updateItem(paths, item.id, { title: "renamed again" });

    const after = readJson(packetPath(item.id)) as Record<string, unknown>;
    expect((after.deadline as Record<string, unknown>).userNote).toBe("the one I keep sliding");
    expect((after.timeline as Record<string, unknown>[])[0]!.mood).toBe("resigned");
    expect(after.title).toBe("renamed again");
  });

  test("the tolerance DISCRIMINATES — z.object would have stripped that key, z.looseObject does not", () => {
    // Both halves through the SAME zod the schema uses, so this cannot pass on a
    // mistaken belief about the library. Without it, the test above would prove
    // only that JSON round-trips.
    const { z } = require("zod") as typeof import("zod");
    const strict = z.object({ a: z.string() });
    const loose = z.looseObject({ a: z.string() });
    expect(strict.parse({ a: "x", extra: 1 })).toEqual({ a: "x" });
    expect(loose.parse({ a: "x", extra: 1 })).toEqual({ a: "x", extra: 1 });
  });
});

// ── the reconcile rule, all four arms, each run TWICE ───────────────────────

describe("the reconcile rule — lanes.json is authoritative, and reconciliation is projection-only", () => {
  // Hand-writes a packet WITHOUT touching lanes.json. This is the crash gap, and
  // it is also the WRITE-ORDER proof: the orphan arm can only adopt an item
  // whose packet was written FIRST.
  const plantPacket = (id: string, extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(packetDirOf(id), { recursive: true });
    writeJson(packetPath(id), {
      id,
      title: `planted ${id}`,
      provenance: "note",
      captured: "Tue 16:42",
      schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
      ...extra,
    });
  };

  // "Run every read twice and assert nothing changes" — idempotence, per arm.
  const twice = <T,>(f: () => T): [T, T] => [f(), f()];

  test("arm 1 ORPHAN — an id in no stack is adopted into the stack its packet names", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", []), lane("free", [])]);
    plantPacket("i-orphan", { lane: "office" });

    const [a, b] = twice(() => queueSlice(readLanes(paths), listItems(paths).items));
    expect(a.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["office", 1, "i-orphan"]]);
    expect(b).toEqual(a);
    // PROJECTION-ONLY: lanes.json was not rewritten to record the adoption.
    expect(readLanes(paths).find((l) => l.key === "office")!.items).toEqual([]);
  });

  test("arm 2 TOMBSTONE — a stack id with no readable packet is dropped from the projection, never thrown", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", ["i-ghost"])]);

    const [a, b] = twice(() => queueSlice(readLanes(paths), listItems(paths).items));
    expect(a).toEqual([]);
    expect(b).toEqual(a);
    // …and the human is TOLD, through the one diagnostic channel.
    const { unreadable } = listItems(paths);
    expect(unreadable.map((u) => u.id)).toEqual(["i-ghost"]);
    expect(unreadable[0]!.reason).toContain("NEVER removed from lanes.json");
    // The id is still in lanes.json. A read that pruned it would be a deletion
    // path that never calls rmSync.
    expect(readLanes(paths)[0]!.items).toEqual(["i-ghost"]);
  });

  test("arm 3 LANE GONE — the item is UNFILED: listed and on the desk, excluded from the queue, rank null", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("free", [])]);
    plantPacket("i-homeless", { lane: "office", desk: true }); // `office` was retired

    const [a, b] = twice(() => queueSlice(readLanes(paths), listItems(paths).items));
    expect(a).toEqual([]); // excluded from the queue…
    expect(b).toEqual(a);
    expect(listItems(paths).items.map((i) => i.id)).toEqual(["i-homeless"]); // …but never lost…
    expect(deskSlice(listItems(paths).items).map((d) => d.id)).toEqual(["i-homeless"]); // …and still visible
    expect(rankOf(readLanes(paths), "i-homeless")).toBeNull();
    // No lane was created to receive it — that would be the agent lane-structure
    // change the contract reserves to the human.
    expect(readLanes(paths).map((l) => l.key)).toEqual(["free"]);
  });

  test("arm 3 an item whose packet names NO lane at all is unfiled by the same arm", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("free", [])]);
    plantPacket("i-nolane");
    expect(queueSlice(readLanes(paths), listItems(paths).items)).toEqual([]);
    expect(listItems(paths).items.map((i) => i.id)).toEqual(["i-nolane"]);
  });

  test("arm 4 DUPLICATE — the FIRST stack in file order wins and the later one is reported", () => {
    ensureSpool(paths);
    plantPacket("i-dup", { lane: "office" });
    writeLanes(paths, [lane("office", ["i-dup"]), lane("free", ["i-dup"])]);

    const [a, b] = twice(() => queueSlice(readLanes(paths), listItems(paths).items));
    expect(a.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["office", 1, "i-dup"]]);
    expect(b).toEqual(a);
    const dupes = listItems(paths).unreadable.filter((u) => u.reason.includes("more than one lane"));
    expect(dupes.map((u) => u.id)).toEqual(["i-dup"]);
    expect(dupes[0]!.reason).toContain('"free"');
  });

  test("an UNREADABLE packet directory does not remove its id from lanes.json across a create", () => {
    // The deletion path that never calls rmSync. If reconciliation wrote its
    // projection back, one transiently unreadable packet would be permanently
    // dropped from lanes.json by the very next create.
    ensureSpool(paths);
    const survivor = createItem(paths, { title: "keep me" });
    const sick = createItem(paths, { title: "temporarily unreadable" });
    writeLanes(paths, [lane("office", [survivor.id, sick.id])]);

    fs.writeFileSync(packetPath(sick.id), "{{{ not json at all ][");
    expect(getSpoolItem(paths, sick.id)).toBeNull();
    expect(listItems(paths).unreadable.some((u) => u.id === sick.id)).toBe(true);

    createItem(paths, { title: "an ordinary new item", lane: "office" });

    const after = readLanes(paths).find((l) => l.key === "office")!.items;
    expect(after).toContain(sick.id);
    expect(after).toContain(survivor.id);
  });

  test("a lane move writes BOTH files — the packet AND lanes.json", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", []), lane("free", [])]);
    const item = createItem(paths, { title: "moved by a tool", lane: "office" });
    const lanesBefore = hashOf(lanesPath());
    const packetBefore = hashOf(packetPath(item.id));

    updateItem(paths, item.id, { lane: "free" });

    // Both halves moved, and the STORED stacks say so — not just the projection.
    expect(hashOf(lanesPath())).not.toBe(lanesBefore);
    expect(hashOf(packetPath(item.id))).not.toBe(packetBefore);
    expect(readLanes(paths).find((l) => l.key === "office")!.items).toEqual([]);
    expect(readLanes(paths).find((l) => l.key === "free")!.items).toEqual([item.id]);
    expect(getSpoolItem(paths, item.id)!.lane).toBe("free");
    expect(rankOf(readLanes(paths), item.id)).toBe(1);

    // …and exactly ONE row, in the new lane: removed from the old stack rather
    // than copied into the new one.
    const rows = queueSlice(readLanes(paths), listItems(paths).items);
    expect(rows.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["free", 1, item.id]]);
  });

  test("the lanes write is DISCRIMINATING — a patch that names no lane leaves lanes.json byte-identical", () => {
    // The other direction, so the arm above pins a lane MOVE rather than an
    // unconditional lanes write on every update.
    ensureSpool(paths);
    writeLanes(paths, [lane("office", []), lane("free", [])]);
    const item = createItem(paths, { title: "retitled only", lane: "office" });
    const before = hashOf(lanesPath());

    updateItem(paths, item.id, { title: "a new title", desk: false });

    expect(hashOf(lanesPath())).toBe(before);
    expect(getSpoolItem(paths, item.id)!.title).toBe("a new title");

    // …and a "move" to the lane the item is ALREADY in writes nothing either,
    // because removing and re-appending would silently send it to the BOTTOM of
    // its own lane — a queue-position change nobody asked for.
    const sibling = createItem(paths, { title: "below it", lane: "office" });
    const twoDeep = hashOf(lanesPath());
    expect(rankOf(readLanes(paths), item.id)).toBe(1);
    updateItem(paths, item.id, { lane: "office" });
    expect(hashOf(lanesPath())).toBe(twoDeep);
    expect(rankOf(readLanes(paths), item.id)).toBe(1);
    expect(rankOf(readLanes(paths), sibling.id)).toBe(2);
  });

  test("a move to a lane that does not exist creates no lane, and does NOT evict the item", () => {
    // A create has no home, so an unknown key has to land somewhere. An update
    // HAS a home: redirecting a typo'd lane key into the seed lane would throw a
    // filed item out of the user's queue on a model's spelling mistake.
    ensureSpool(paths);
    writeLanes(paths, [lane("unfiled", []), lane("office", [])]);
    const item = createItem(paths, { title: "filed properly", lane: "office" });
    const lanesBefore = hashOf(lanesPath());

    const moved = updateItem(paths, item.id, { lane: "school" })!;

    expect(moved.lane).toBe("office"); // where it actually is, not where it was asked to go
    expect(moved.unplaced).toBe(true); // …and the user is asked
    expect(readLanes(paths).map((l) => l.key)).toEqual(["unfiled", "office"]); // no `school`
    expect(readLanes(paths).find((l) => l.key === "office")!.items).toEqual([item.id]);
    expect(rankOf(readLanes(paths), item.id)).toBe(1); // its queue position survived
    expect(hashOf(lanesPath())).toBe(lanesBefore); // lanes.json untouched
  });

  test("with the seed lane RETIRED, a typo'd lane key still does not make the item vanish", () => {
    // The sharpest form of the same defect: with nowhere to redirect to, an
    // evicting update leaves the item in no stack at all — no queue row, no desk
    // card, and NOTHING in the unreadable channel naming it.
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const item = createItem(paths, { title: "must not vanish", lane: "office" });

    updateItem(paths, item.id, { lane: "ofice" }); // the typo

    expect(rankOf(readLanes(paths), item.id)).toBe(1);
    expect(queueSlice(readLanes(paths), listItems(paths).items).map((r) => [r.lane, r.item.id])).toEqual([
      ["office", item.id],
    ]);
    expect(deskSlice(listItems(paths).items).map((d) => d.id)).toEqual([item.id]);
  });

  test("a SUCCESSFUL move clears `unplaced` — the desk stops asking a question that was answered", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("unfiled", []), lane("office", [])]);
    const typo = createItem(paths, { title: "typo lane", lane: "ofice" });
    expect(typo.unplaced).toBe(true);

    const placed = updateItem(paths, typo.id, { lane: "office" })!;

    expect(placed.lane).toBe("office");
    expect(placed.unplaced).toBe(false);
    expect(rankOf(readLanes(paths), typo.id)).toBe(1);
    expect(deskSlice(listItems(paths).items)[0]!.hint).toBeUndefined();
    // …and a caller that explicitly asks for unplaced in the SAME patch wins.
    expect(updateItem(paths, typo.id, { lane: "office", unplaced: true })!.unplaced).toBe(true);
  });

  test("a duplicated id elsewhere does not re-rank the item on a no-op move to its own lane", () => {
    // The "already in the target" guard has to look at the TARGET stack, not at
    // whichever stack holds the id first.
    ensureSpool(paths);
    const top = createItem(paths, { title: "top" });
    const middle = createItem(paths, { title: "middle" });
    const bottom = createItem(paths, { title: "bottom" });
    writeLanes(paths, [lane("school", [middle.id]), lane("office", [top.id, middle.id, bottom.id])]);
    const before = hashOf(lanesPath());

    updateItem(paths, middle.id, { lane: "office" });

    // Kept its position in the target…
    expect(readLanes(paths).find((l) => l.key === "office")!.items).toEqual([top.id, middle.id, bottom.id]);
    // …and the stray duplicate was cleaned out of the other stack, which is the
    // one thing this call SHOULD change.
    expect(readLanes(paths).find((l) => l.key === "school")!.items).toEqual([]);
    expect(hashOf(lanesPath())).not.toBe(before);
    expect(rankOf(readLanes(paths), middle.id)).toBe(2);
  });

  test("a WRITE preserves a lane row this build could not read — tolerance is not a delayed delete", () => {
    // The trap in per-row tolerance: a partial READ written back is a partial
    // DELETE.
    ensureSpool(paths);
    const held = createItem(paths, { title: "inside the broken row" });
    writeJson(lanesPath(), [
      { key: "office", label: "Office", window: "work hours", items: [] },
      { key: "school", label: "School", items: [held.id], note: "the human dropped `window`" },
      { key: "free", label: "Free", window: "whenever", items: [] },
    ]);
    expect(readLanes(paths).map((l) => l.key)).toEqual(["office", "free"]);

    createItem(paths, { title: "an ordinary capture", lane: "free" });

    const onDisk = readJson(lanesPath()) as Record<string, unknown>[];
    expect(onDisk.map((r) => r.key)).toEqual(["office", "school", "free"]);
    const school = onDisk.find((r) => r.key === "school")!;
    expect(school.items).toEqual([held.id]); // its ids survived
    expect(school.note).toBe("the human dropped `window`"); // and every other key
    expect(listItems(paths).unreadable.map((u) => u.id)).toContain("school"); // still reported

    // …and an update write preserves it too.
    updateItem(paths, held.id, { lane: "free" });
    const after = readJson(lanesPath()) as Record<string, unknown>[];
    expect(after.map((r) => r.key)).toEqual(["office", "school", "free"]);
    expect(after.find((r) => r.key === "school")!.note).toBe("the human dropped `window`");
    // The id was removed from the broken row's stack because that row's `items`
    // is still a readable list — the row keeps every one of its own keys.
    expect(after.find((r) => r.key === "school")!.items).toEqual([]);
    expect(readLanes(paths).find((l) => l.key === "free")!.items).toContain(held.id);
  });

  test("a TORN lane move — packet written, lanes.json not — simply did not happen", () => {
    // FAULT-INJECTED, not narrated: the packet is rewritten ON DISK exactly as a
    // crash between the two writes would leave it, and lanes.json is untouched.
    ensureSpool(paths);
    writeLanes(paths, [lane("office", []), lane("free", [])]);
    const item = createItem(paths, { title: "mid-move", lane: "office" });
    expect(readLanes(paths).find((l) => l.key === "office")!.items).toEqual([item.id]);
    const lanesBefore = hashOf(lanesPath());

    // The torn state: packet.lane says `free`, the id is still in `office`.
    writeJson(packetPath(item.id), { ...getSpoolItem(paths, item.id), lane: "free" });
    expect(getSpoolItem(paths, item.id)!.lane).toBe("free");
    expect(hashOf(lanesPath())).toBe(lanesBefore);

    // lanes.json is authoritative, so the move did not happen: the id is still
    // in its OLD stack and the orphan arm does not fire.
    const rows = queueSlice(readLanes(paths), listItems(paths).items);
    expect(rows.map((r) => [r.lane, r.item.id])).toEqual([["office", item.id]]);
    expect(rows.length).toBe(1); // exactly one row: no duplicate

    // …and the recovery is a re-run of the same call, not a repair tool.
    updateItem(paths, item.id, { lane: "free" });
    expect(queueSlice(readLanes(paths), listItems(paths).items).map((r) => [r.lane, r.item.id])).toEqual([
      ["free", item.id],
    ]);
  });

  test("a DUPLICATE lane key does not make the store write the same id into two stacks", () => {
    // A hand-edited paste leaves two rows keyed `office`. Appending to every
    // matching row would have the store MANUFACTURING the exact duplicate-id
    // fault arm 4 then reports and blames on the human.
    ensureSpool(paths);
    writeLanes(paths, [lane("office", []), lane("office", [])]);
    const item = createItem(paths, { title: "into a duplicated key", lane: "office" });

    expect(readLanes(paths).map((l) => l.items)).toEqual([[item.id], []]);
    expect(listItems(paths).unreadable.filter((u) => u.reason.includes("more than one lane"))).toEqual([]);
  });
});

// ── the human-editability claim, exercised ──────────────────────────────────

describe("lanes.json is authoritative, so a hand-edit WINS", () => {
  test("a hand REORDER changes the ranks and rewrites NO packet.json", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const a = createItem(paths, { title: "first", lane: "office" });
    const b = createItem(paths, { title: "second", lane: "office" });
    expect(rankOf(readLanes(paths), a.id)).toBe(1);
    expect(rankOf(readLanes(paths), b.id)).toBe(2);
    const hashes = [hashOf(packetPath(a.id)), hashOf(packetPath(b.id))];

    // The hand-edit: swap two ids in the file, exactly as a text editor would.
    writeLanes(paths, [lane("office", [b.id, a.id])]);

    expect(rankOf(readLanes(paths), b.id)).toBe(1);
    expect(rankOf(readLanes(paths), a.id)).toBe(2);
    expect([hashOf(packetPath(a.id)), hashOf(packetPath(b.id))]).toEqual(hashes);
  });

  test("a hand CROSS-LANE MOVE takes effect and rewrites NO packet.json, even though packet.lane still says otherwise", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", []), lane("free", [])]);
    const item = createItem(paths, { title: "moved by hand", lane: "office" });
    const before = hashOf(packetPath(item.id));
    expect(getSpoolItem(paths, item.id)!.lane).toBe("office");

    // Move the id between stacks in the file. packet.lane is a RECOVERY HINT and
    // is consulted only when the id is in no stack — so lanes.json wins.
    writeLanes(paths, [lane("office", []), lane("free", [item.id])]);

    const rows = queueSlice(readLanes(paths), listItems(paths).items);
    expect(rows.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["free", 1, item.id]]);
    expect(getSpoolItem(paths, item.id)!.lane).toBe("office"); // the stale hint, harmlessly
    expect(hashOf(packetPath(item.id))).toBe(before);
  });
});

// ── the address-mismatch guard ──────────────────────────────────────────────
//
// Shared by EVERY writer that resolves a packet by id first. The donor's
// adversarial mutation pass found that commenting out any one of the four call
// sites left its suite fully green, so each writer is driven separately here. A
// human is invited to hand-edit a packet, so a directory whose own `id` no longer
// matches the directory it sits in is a state the store WILL see.

describe("address-mismatch guard — every writer that resolves a packet by id refuses a hand-edited id mismatch", () => {
  function createWithMismatchedId(): { dirId: string; claimedId: string } {
    const item = createItem(paths, { title: "will be hand-edited" });
    const other = createItem(paths, { title: "the id it will falsely claim" });
    const before = hashOf(packetPath(other.id)); // the OTHER item, never touched
    writeJson(packetPath(item.id), { ...item, id: other.id });
    expect(hashOf(packetPath(other.id))).toBe(before); // sanity: only item.id's own file was touched
    return { dirId: item.id, claimedId: other.id };
  }

  test("updateItem throws and writes nothing, naming both the directory and the claimed id", () => {
    const { dirId, claimedId } = createWithMismatchedId();
    const before = hashOf(packetPath(dirId));
    expect(() => updateItem(paths, dirId, { title: "clobber attempt" })).toThrow(
      new RegExp(`${dirId}.*${claimedId}|${claimedId}.*${dirId}`, "s"),
    );
    expect(hashOf(packetPath(dirId))).toBe(before); // nothing written
  });

  test("addSubtask throws and writes nothing", () => {
    const { dirId } = createWithMismatchedId();
    const before = hashOf(packetPath(dirId));
    expect(() => addSubtask(paths, dirId, "a sub-task")).toThrow(/directory it sits in/);
    expect(hashOf(packetPath(dirId))).toBe(before);
  });

  test("setSubtaskDone throws and writes nothing", () => {
    const { dirId } = createWithMismatchedId();
    const before = hashOf(packetPath(dirId));
    // The subtask id does not need to exist — the address check runs first,
    // before the subtask lookup, so this proves the GUARD fires rather than
    // merely proving the not-found path does.
    expect(() => setSubtaskDone(paths, dirId, "st-doesnotexist", true)).toThrow(/directory it sits in/);
    expect(hashOf(packetPath(dirId))).toBe(before);
  });

  test("applyExpertPass throws and writes nothing", () => {
    const { dirId } = createWithMismatchedId();
    const before = hashOf(packetPath(dirId));
    expect(() => applyExpertPass(paths, dirId, { note: "enriched" })).toThrow(/directory it sits in/);
    expect(hashOf(packetPath(dirId))).toBe(before);
  });

  test("promoteSubtask throws and writes NEITHER the parent NOR any new promoted packet", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const parent = createItem(paths, { title: "parent", lane: "office" });
    const withSub = addSubtask(paths, parent.id, "a sub-task")!;
    const other = createItem(paths, { title: "the id it will falsely claim" });
    writeJson(packetPath(parent.id), { ...withSub, id: other.id });
    const before = hashOf(packetPath(parent.id));
    const packetsBefore = fs.readdirSync(paths.packets).sort();
    expect(() => promoteSubtask(paths, parent.id, withSub.subtasks![0]!.id)).toThrow(/directory it sits in/);
    expect(hashOf(packetPath(parent.id))).toBe(before);
    // No third packet directory was minted for a promoted item that never happened.
    expect(fs.readdirSync(paths.packets).sort()).toEqual(packetsBefore);
  });
});

// ── lanes.json is read PER ROW, because the hand-edit is invited ────────────

describe("one malformed lane row does not discard the file", () => {
  test("a row missing `window` is SKIPPED and every other lane survives", () => {
    // The all-or-nothing read the donor shipped with returned `[]` here: the
    // user's ENTIRE lane structure vanished from every read because one row of
    // five was imperfect, and the next create then filed into no stack at all.
    ensureSpool(paths);
    const item = createItem(paths, { title: "already filed" });
    writeJson(lanesPath(), [
      { key: "office", label: "Office", window: "work hours", items: [item.id] },
      { key: "school", label: "School", items: [] }, // the human dropped `window`
      { key: "free", label: "Free", window: "whenever", items: [] },
    ]);

    expect(readLanes(paths).map((l) => l.key)).toEqual(["office", "free"]);
    expect(rankOf(readLanes(paths), item.id)).toBe(1);
    // …and a create still files into a real lane rather than accumulating unfiled.
    const next = createItem(paths, { title: "filed after the bad edit", lane: "free" });
    expect(next.unplaced).toBeUndefined();
    expect(readLanes(paths).find((l) => l.key === "free")!.items).toEqual([next.id]);
  });

  test("the skipped row is REPORTED by name, so tolerance is not silent loss", () => {
    ensureSpool(paths);
    writeJson(lanesPath(), [
      { key: "office", label: "Office", window: "work hours", items: [] },
      { key: "school", label: "School", items: [] },
    ]);
    const reported = listItems(paths).unreadable;
    expect(reported.map((u) => u.id)).toEqual(["school"]);
    expect(reported[0]!.reason).toContain("lanes.json");
    expect(reported[0]!.reason).toContain("window");
    expect(reported[0]!.reason).toContain("SKIPPED");
    // Nothing was rewritten to "fix" it — the human's file is theirs.
    expect((readJson(lanesPath()) as unknown[]).length).toBe(2);
  });

  test("a row with no readable key at all is reported by its POSITION", () => {
    ensureSpool(paths);
    writeJson(lanesPath(), [{ key: "office", label: "Office", window: "work hours", items: [] }, "not an object"]);
    expect(readLanes(paths).map((l) => l.key)).toEqual(["office"]);
    expect(listItems(paths).unreadable.map((u) => u.id)).toEqual(["lanes.json[1]"]);
  });

  test("a WHOLE-FILE fault is still [] — and says so, rather than returning half a structure", () => {
    ensureSpool(paths);
    fs.writeFileSync(lanesPath(), "{{{ not json at all ][");
    expect(readLanes(paths)).toEqual([]);
    expect(listItems(paths).unreadable.map((u) => u.id)).toEqual(["lanes.json"]);

    writeJson(lanesPath(), { office: ["i-1"] }); // an object, not an array
    expect(readLanes(paths)).toEqual([]);
    expect(listItems(paths).unreadable[0]!.reason).toContain("must be a JSON array");

    // An EMPTY file is the ordinary first-run state, not a fault. JSON.parse("")
    // throws where the donor's YAML.parse("") returned null, so this is the one
    // place the serializer swap needed a line of code — and it is asserted.
    fs.writeFileSync(lanesPath(), "");
    expect(readLanes(paths)).toEqual([]);
    expect(listItems(paths).unreadable).toEqual([]);

    // …and whitespace only, which is what an editor leaves behind.
    fs.writeFileSync(lanesPath(), "\n  \n");
    expect(readLanes(paths)).toEqual([]);
    expect(listItems(paths).unreadable).toEqual([]);
  });
});

// ── provenance, the desk, and filing ────────────────────────────────────────

describe("creating an item files it, stamps provenance, and places it on the desk", () => {
  test("create files into the named lane, stamps provenance server-side, and sets desk true", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("aurora", [])]);
    const item = createItem(paths, { title: "ship the retry flow", project: "aurora", lane: "aurora" });

    expect(item.lane).toBe("aurora");
    expect(item.desk).toBe(true);
    expect(item.unplaced).toBeUndefined();
    expect(item.provenance).toBe("session");
    expect(rankOf(readLanes(paths), item.id)).toBe(1);
    // `captured` is a DISPLAY label, never a scheduling input: a shape check,
    // because asserting a value would be asserting the wall clock.
    expect(item.captured).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2}:\d{2}$/);
    // The session's identity rides the creation timeline entry's text, not a
    // field on the item.
    expect(Object.keys(item)).not.toContain("sessionId");
    expect(item.timeline!.length).toBe(1);
    expect(item.timeline![0]!.actor).toBe("session");
  });

  test("a create naming an UNKNOWN lane files into the seed lane and asks, rather than creating the lane", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "the pdf thing", lane: "a-lane-nobody-made" });
    expect(item.lane).toBe("unfiled");
    expect(item.unplaced).toBe(true);
    expect(readLanes(paths).map((l) => l.key)).toEqual(["unfiled"]); // lane structure held
    expect(deskSlice([item])[0]!.hint).toBe("unplaced — what is it?");
  });

  test("with the seed lane RETIRED, a create writes the item and creates NO lane at all", () => {
    // A lane-creating `else` branch — the natural-looking fix for an item that
    // lands nowhere — is exactly the agent lane-structure change the contract
    // forbids, and it left the donor's whole suite green.
    ensureSpool(paths);
    writeLanes(paths, []); // the human retired every lane, seed included
    const item = createItem(paths, { title: "nowhere to land", lane: "office" });

    expect(readLanes(paths)).toEqual([]); // NOTHING was created — not `office`, not `unfiled`
    expect(fs.readFileSync(lanesPath(), "utf8").includes("office")).toBe(false);
    // The item itself still exists and is readable; it is UNFILED, a resting
    // state, and it is on the desk so the human is asked.
    expect(getSpoolItem(paths, item.id)!.title).toBe("nowhere to land");
    expect(rankOf(readLanes(paths), item.id)).toBeNull();
    expect(queueSlice(readLanes(paths), listItems(paths).items)).toEqual([]);
    expect(deskSlice(listItems(paths).items).map((d) => d.id)).toEqual([item.id]);
  });

  test("the creation note reaches the timeline's TEXT and the caller cannot forge the actor", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "captured", creationNote: "captured by facundo in session s-123" });
    expect(item.timeline![0]!.text).toBe("captured by facundo in session s-123");
    expect(item.timeline![0]!.actor).toBe("session"); // the store's, not the caller's
  });

  test("desk is cleared by updateItem({desk:false}) and the item STAYS in its lane", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const item = createItem(paths, { title: "dismiss me", lane: "office" });
    expect(deskSlice(listItems(paths).items).map((d) => d.id)).toEqual([item.id]);

    updateItem(paths, item.id, { desk: false });

    expect(deskSlice(listItems(paths).items)).toEqual([]);
    // Dismiss DRAINS TO THE QUEUE. There is no delete.
    expect(rankOf(readLanes(paths), item.id)).toBe(1);
    expect(getSpoolItem(paths, item.id)).not.toBeNull();
  });

  test("a project-scoped view excludes a FLOATING item rather than treating it as a failure", () => {
    ensureSpool(paths);
    const scoped = createItem(paths, { title: "aurora work", project: "aurora" });
    const floating = createItem(paths, { title: "no project yet" });
    const all = listItems(paths).items;
    expect(all.length).toBe(2);
    expect(all.filter((i) => i.project === "aurora").map((i) => i.id)).toEqual([scoped.id]);
    expect(floating.project).toBeUndefined();
  });

  test("updateItem returns null for an item that does not exist", () => {
    ensureSpool(paths);
    expect(updateItem(paths, "i-nothing", { title: "x" })).toBeNull();
  });
});

// ── raw and rawSource are never overwritten ─────────────────────────────────
//
// `tsconfig.json` is `include: ["src"], exclude: ["test"]`, so `bun run
// typecheck` NEVER SEES THIS FILE. A bare @ts-expect-error here would be a
// comment wearing a test's clothes, so the compile-time claim is proved by
// RUNNING the compiler over a generated fixture, in both directions.

const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_TSC = path.join(ENGINE_DIR, "node_modules", "typescript", "bin", "tsc");
const STORE_MODULE = path.join(ENGINE_DIR, "src", "spool", "store");
const ENGINE_CLIENT = fileURLToPath(new URL("../../../packages/engine-client/src/index.ts", import.meta.url));

/**
 * A GENERATED tsconfig, not CLI flags alone, and that is the one thing this
 * port had to add: the store imports `@telar/engine-client`, a workspace
 * package, which does not resolve from a fixture in `os.tmpdir()`. A `paths`
 * mapping is the smallest thing that makes the fixture compile at all — without
 * it every fixture "fails to compile" for a reason that has nothing to do with
 * the patch type, and the negative half of the proof would pass for the wrong
 * reason. The discriminating test below is what catches that.
 */
const typecheck = (source: string): { ok: boolean; output: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-compile-"));
  try {
    fs.writeFileSync(path.join(dir, "fixture.ts"), `import type { SpoolItemPatch } from ${JSON.stringify(STORE_MODULE)};\n${source}\n`);
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [path.join(ENGINE_DIR, "node_modules", "@types")],
          // NO `baseUrl`: it is deprecated in TypeScript 6 and emits TS5101,
          // which the discriminating test below caught as non-empty output on a
          // fixture that was otherwise compiling clean. Absolute `paths` entries
          // need no base to resolve against.
          paths: { "@telar/engine-client": [ENGINE_CLIENT] },
        },
        files: ["fixture.ts"],
      }),
    );
    const out = spawnSync(process.execPath, [REPO_TSC, "--noEmit", "-p", path.join(dir, "tsconfig.json")], {
      encoding: "utf8",
      // THE CHILD GETS ITS OWN THROWAWAY ROOTS. A spawned process inherits the
      // parent's env unless told otherwise. This child only compiles a fixture
      // and opens no store — but it costs one option not to take that on trust.
      env: { ...process.env, HOME: dir, TELAR_HOME: dir },
    });
    return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("raw and rawSource are never overwritten", () => {
  test(
    "SpoolItemPatch CANNOT EXPRESS a change to raw or rawSource — proved by running tsc",
    () => {
      // A TYPED DATA OBJECT, never a directive above a call.
      for (const field of ["raw", "rawSource", "promotedFrom", "schemaVersion", "id", "timeline"]) {
        const r = typecheck(`const patch: SpoolItemPatch = { ${field}: undefined as never };`);
        expect(r.ok).toBe(false);
        expect(r.output).toContain(field);
      }
      // SIX SEQUENTIAL tsc SPAWNS. The timeout is raised rather than the loop
      // split, so the six stay one claim.
    },
    120_000,
  );

  test(
    "the compile proof DISCRIMINATES — a patch of a PERMITTED field compiles clean",
    () => {
      // Without this half, a fixture failing to compile for any reason at all (a
      // bad path, an unresolvable workspace import, a renamed export) would read
      // as a passing proof.
      const r = typecheck(`const patch: SpoolItemPatch = { title: "fine", desk: false, lane: "office" };\nvoid patch;`);
      expect(r.output).toBe("");
      expect(r.ok).toBe(true);
    },
    120_000,
  );

  test("a hostile updateItem past the type leaves both fields byte-identical AND is REPORTED", () => {
    ensureSpool(paths);
    const item = createItem(paths, {
      title: "the user's own words",
      raw: "onboarding feels clunky?? ask diego",
      rawSource: "Telar Note · Tue 16:42",
    });
    const before = hashOf(packetPath(item.id));

    // The cast is what a JSON.parse, an `as`, or a future deserialization
    // boundary would produce. Silently dropping it would look identical, from
    // the outside, to honouring it — which is why it throws.
    const hostile = { raw: "REWRITTEN", rawSource: "REWRITTEN" } as unknown as SpoolItemPatch;
    let thrown: Error | null = null;
    try {
      updateItem(paths, item.id, hostile);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("raw");

    const after = getSpoolItem(paths, item.id)!;
    expect(after.raw).toBe("onboarding feels clunky?? ask diego");
    expect(after.rawSource).toBe("Telar Note · Tue 16:42");
    expect(hashOf(packetPath(item.id))).toBe(before); // not even rewritten
  });

  test("a legitimate patch still writes, so the guard is not simply refusing everything", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "before", raw: "kept" });
    const updated = updateItem(paths, item.id, { title: "after", desk: false })!;
    expect(updated.title).toBe("after");
    expect(updated.raw).toBe("kept");
    expect(getSpoolItem(paths, item.id)!.title).toBe("after");
  });
});

// ── the absence that IS the moat ────────────────────────────────────────────

describe("the item schema exposes no accept path", () => {
  test("there is no status, state, done or accepted field on an item — and unknown keys are not it", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "nothing to transition" });
    for (const forbidden of ["status", "state", "done", "accepted", "acceptedAt", "acceptedBy"]) {
      expect(Object.keys(item)).not.toContain(forbidden);
    }
    // The schema, not merely one instance: these are not optional-and-absent,
    // they are not in the shape at all. A loose object preserves an unknown key
    // from DISK but never invents one, and nothing in this store writes one.
    const shapeKeys = Object.keys(SpoolItem.shape);
    for (const forbidden of ["status", "state", "done", "accepted"]) {
      expect(shapeKeys).not.toContain(forbidden);
    }
    // Anti-vacuity: the shape really was read.
    expect(shapeKeys).toContain("title");
    expect(shapeKeys.length).toBeGreaterThanOrEqual(19);
  });
});

// ── the pure projections ────────────────────────────────────────────────────

describe("the pure projections take already-read data and touch no disk", () => {
  const item = (over: Record<string, unknown> & { id: string; title: string }) =>
    SpoolItem.parse({ provenance: "note", captured: "Tue 16:42", ...over });

  test("rankOf is 1-BASED and returns null for an unfiled item", () => {
    const lanes = [lane("office", ["i-a", "i-b"]), lane("free", ["i-c"])];
    expect(rankOf(lanes, "i-a")).toBe(1); // 1-based: every rendering in the tree is
    expect(rankOf(lanes, "i-b")).toBe(2);
    expect(rankOf(lanes, "i-c")).toBe(1); // per-lane, not global
    expect(rankOf(lanes, "i-nowhere")).toBeNull();
    expect(rankOf([], "i-a")).toBeNull();
  });

  test("queueSlice's COUNT is unchanged when sub-tasks are added — the conservation law", () => {
    const lanes = [lane("office", ["i-a", "i-b"])];
    const plain = [item({ id: "i-a", title: "a" }), item({ id: "i-b", title: "b" })];
    const decomposed = [
      item({
        id: "i-a",
        title: "a",
        subtasks: [
          { id: "st-1", title: "one" },
          { id: "st-2", title: "two" },
          { id: "st-3", title: "three", done: true },
        ],
      }),
      item({ id: "i-b", title: "b" }),
    ];
    expect(queueSlice(lanes, plain).length).toBe(2);
    expect(queueSlice(lanes, decomposed).length).toBe(2);
    // …and it really returns ITEMS, never items-plus-subtasks.
    expect(queueSlice(lanes, decomposed).map((r) => r.item.id)).toEqual(["i-a", "i-b"]);
  });

  test("queueSlice ranks per lane, in lane order then stack order", () => {
    const lanes = [lane("office", ["i-b", "i-a"]), lane("free", ["i-c"])];
    const items = ["i-a", "i-b", "i-c"].map((id) => item({ id, title: id }));
    expect(queueSlice(lanes, items).map((r) => `${r.lane}:${r.rank}:${r.item.id}`)).toEqual([
      "office:1:i-b",
      "office:2:i-a",
      "free:1:i-c",
    ]);
  });

  test("deskSlice emits {id,title,project?,mirrored?,deadline?,hint?,unplaced?} from ITEM FIELDS ALONE", () => {
    // FIELDS, NOT SENTENCES. The deadline and the mirrored ref used to be
    // flattened into one prose `hint`, which stranded the Desk outside the frozen
    // chip grammar: a self-deadline cannot render dashed with `· self` / `· slid
    // ×N`, and a mirrored item cannot render its ref, if the projection has
    // already turned both into a string.
    const cards = deskSlice([
      item({
        id: "i-1",
        title: "Remove CSV export button",
        project: "aurora",
        desk: true,
        deadline: { label: "Fri", kind: "external" },
      }),
      item({ id: "i-2", title: "Call María — invoice", desk: true }),
      item({ id: "i-3", title: "the pdf thing", desk: true, unplaced: true }),
      item({ id: "i-4", title: "not on the desk" }),
      item({ id: "i-5", title: "mirrored one", desk: true, project: "aurora", mirrored: "#214" }),
      item({ id: "i-6", title: "slid twice", desk: true, deadline: { label: "Thu", kind: "self", slips: 2 } }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["i-1", "i-2", "i-3", "i-5", "i-6"]);
    expect(cards[0]).toEqual({
      id: "i-1",
      title: "Remove CSV export button",
      project: "aurora",
      deadline: { label: "Fri", kind: "external" },
    });
    expect(cards[1]).toEqual({ id: "i-2", title: "Call María — invoice" });
    expect(cards[2]).toEqual({ id: "i-3", title: "the pdf thing", hint: "unplaced — what is it?", unplaced: true });
    expect(cards[3]).toEqual({ id: "i-5", title: "mirrored one", project: "aurora", mirrored: "#214" });
    // The slip count survives the projection — it is the witness CAP-7 renders.
    expect(cards[4]!.deadline).toEqual({ label: "Thu", kind: "self", slips: 2 });
    // `hint` is prose ONLY where no chip exists to say it: the unplaced question.
    expect(cards.filter((c) => c.hint !== undefined).map((c) => c.id)).toEqual(["i-3"]);
    for (const c of cards) {
      for (const k of Object.keys(c)) {
        expect(["id", "title", "project", "mirrored", "deadline", "hint", "unplaced"]).toContain(k);
      }
    }
  });

  test("attachmentTally counts siblings and excludes packet.json", () => {
    expect(attachmentTally([])).toEqual({ files: 0, mockups: 0 });
    expect(attachmentTally(["packet.json"])).toEqual({ files: 0, mockups: 0 });
    expect(attachmentTally(["packet.json", "brief.md", "notes.txt", "flow.png", "wire.SVG"])).toEqual({
      files: 2,
      mockups: 2,
    });
  });

  test("a stray FILE in packets/ is not an item, and is not reported as a corrupt one", () => {
    // An item is a DIRECTORY. A `.DS_Store`, a temp file from an interrupted
    // write, or a note someone dropped in packets/ used to reach the packet
    // resolver, throw on the id guard, and be handed to the model as an
    // unreadable ITEM — telling the user one of their tasks was corrupt when
    // nothing of theirs was involved.
    ensureSpool(paths);
    const real = createItem(paths, { title: "a real one" });
    fs.writeFileSync(path.join(paths.packets, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(paths.packets, "stray-note.md"), "# dropped here");

    const { items, unreadable } = listItems(paths);
    expect(items.map((i) => i.id)).toEqual([real.id]);
    expect(unreadable).toEqual([]);
  });

  test("the tally excludes THIS STORE'S OWN crash residue and the OS's, not just packet.json", () => {
    // The engine's writer leaves `<file>.tmp-<pid>-<uuid>` behind if it dies
    // between write and rename, and reporting it as "1 file" tells the user they
    // attached something when what actually happened is that a write of THEIRS
    // failed. `.DS_Store` is Finder's, from opening the directory once.
    expect(attachmentTally(["packet.json.tmp-123-abc", ".DS_Store"])).toEqual({ files: 0, mockups: 0 });
    expect(attachmentTally(["brief.md", "packet.json.tmp-123-abc", ".DS_Store", "flow.png"])).toEqual({
      files: 1,
      mockups: 1,
    });

    // …and the disk reader agrees, so the exclusion is not only true of the pure
    // half. Both are planted as REAL files beside a real packet.
    ensureSpool(paths);
    const item = createItem(paths, { title: "with residue beside it" });
    fs.writeFileSync(path.join(packetDirOf(item.id), "packet.json.tmp-123-abc"), "half a write");
    fs.writeFileSync(path.join(packetDirOf(item.id), ".DS_Store"), "finder");
    fs.writeFileSync(path.join(packetDirOf(item.id), "brief.md"), "# real");
    expect(readPacketAttachments(paths, item.id)).toEqual(["brief.md"]);
    expect(attachmentTally(readPacketAttachments(paths, item.id))).toEqual({ files: 1, mockups: 0 });
  });

  test("capturedLabel's VALUE is asserted, not just its presence", () => {
    // Scrambling the weekday table or swapping HH:MM left the donor's whole suite
    // green, because every assertion on `captured` only checked that a string was
    // there. The label is what the UI renders, so its FORM is the contract:
    // "<Www> <HH>:<MM>", zero-padded, and the weekday must be the one the clock
    // says. Derived from the SAME instant, so this cannot go stale at midnight.
    ensureSpool(paths);
    const before = new Date();
    const item = createItem(paths, { title: "stamped" });
    const after = new Date();
    const expected = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    expect(item.captured).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [0-2][0-9]:[0-5][0-9]$/);
    const [day, clock] = item.captured.split(" ");
    // The weekday is the RIGHT one — a scrambled table names a different day
    // (except across a midnight boundary, which is why both ends are accepted).
    expect([expected[before.getDay()], expected[after.getDay()]]).toContain(day);
    const [hh, mm] = clock!.split(":").map(Number);
    expect([before.getHours(), after.getHours()]).toContain(hh);
    expect([before.getMinutes(), after.getMinutes()]).toContain(mm);
    // …and the ORDER is HH then MM, which a swap would break.
    expect(hh).toBeLessThanOrEqual(23);
    expect(mm).toBeLessThanOrEqual(59);
    // The timeline entry carries the SAME label — one clock read, not two.
    expect(item.timeline![0]!.at).toBe(item.captured);
  });

  test("the tally excludes SUBDIRECTORIES, because the reader hands it files only", () => {
    ensureSpool(paths);
    const it = createItem(paths, { title: "with a subdirectory" });
    fs.writeFileSync(path.join(packetDirOf(it.id), "brief.md"), "x");
    fs.mkdirSync(path.join(packetDirOf(it.id), "drafts"));
    fs.writeFileSync(path.join(packetDirOf(it.id), "drafts", "v1.md"), "x");

    expect(readPacketAttachments(paths, it.id)).toEqual(["brief.md"]);
    expect(attachmentTally(readPacketAttachments(paths, it.id))).toEqual({ files: 1, mockups: 0 });
  });
});

// ── lane structure: human-only, and none of these four is reachable from a tool ─

describe("createLane mints a key, dedupes it, and never disturbs another row", () => {
  test("createLane mints a slug from the label and appends an empty stack", () => {
    ensureSpool(paths); // seeds the "unfiled" row — createLane must not disturb it
    const made = createLane(paths, { label: "Evenings & Weekends", window: "after 6pm" });
    expect(made).toEqual({ key: "evenings-weekends", label: "Evenings & Weekends", window: "after 6pm", items: [] });
    expect(readLanes(paths).map((l) => l.key)).toEqual(["unfiled", "evenings-weekends"]);
    expect(readLanes(paths)[1]).toEqual(made);
  });

  test("createLane dedupes a key collision by suffix, and reads existing keys off the RAW rows, not just the parsed ones", () => {
    ensureSpool(paths);
    // A malformed row (no `window`) still claims a key — createLane must not mint
    // a colliding one just because that row cannot be parsed.
    writeJson(lanesPath(), [
      { key: "office", label: "Office", window: "work hours", items: [] },
      { key: "office-2", label: "Office (old)", items: [] }, // missing window — unreadable
    ]);
    const made = createLane(paths, { label: "Office", window: "work hours" });
    expect(made.key).toBe("office-3");
    // Both prior rows, including the unreadable one, survive intact.
    expect(readJson(lanesPath())).toEqual([
      { key: "office", label: "Office", window: "work hours", items: [] },
      { key: "office-2", label: "Office (old)", items: [] },
      { key: "office-3", label: "Office", window: "work hours", items: [] },
    ]);
  });

  test("createLane appends after every existing row, including one this build cannot parse, and rewrites none of them", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "already filed", lane: "unfiled" });
    const before = hashOf(packetPath(item.id));
    writeJson(lanesPath(), [{ key: "unfiled", label: "Unfiled", window: "n/a", items: [item.id] }, "not an object"]);
    createLane(paths, { label: "Free", window: "whenever", note: "split from Office" });
    expect(readJson(lanesPath())).toEqual([
      { key: "unfiled", label: "Unfiled", window: "n/a", items: [item.id] },
      "not an object",
      { key: "free", label: "Free", window: "whenever", note: "split from Office", items: [] },
    ]);
    expect(hashOf(packetPath(item.id))).toBe(before); // no packet touched by a lane-only write
  });
});

describe("renameLane rewrites `label` ONLY — the key never moves once a lane exists", () => {
  test("renameLane changes the label and leaves the key, window, items and unknown hand-added keys untouched", () => {
    ensureSpool(paths);
    writeJson(lanesPath(), [
      { key: "office", label: "Office", window: "work hours", items: ["i-a"], color: "blue" },
    ]);
    const renamed = renameLane(paths, "office", "Day Job");
    expect(renamed).toEqual({ key: "office", label: "Day Job", window: "work hours", items: ["i-a"] });
    expect(readJson(lanesPath())).toEqual([
      { key: "office", label: "Day Job", window: "work hours", items: ["i-a"], color: "blue" },
    ]);
  });

  test("renameLane on an unknown key writes nothing and returns null — and the seed-lane-rename hazard stays closed", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("unfiled", ["i-a"])]);
    const before = fs.readFileSync(lanesPath(), "utf8");
    expect(renameLane(paths, "does-not-exist", "New Label")).toBeNull();
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before);
    // …and renaming the SEED lane's label still routes an unresolvable-lane
    // create to the same stored key — renaming a label never touches routing,
    // because there is no function anywhere that can change a `key`.
    renameLane(paths, "unfiled", "Everything Else");
    const item = createItem(paths, { title: "unresolvable lane request", lane: "nope-not-a-real-key" });
    expect(item.unplaced).toBe(true);
    expect(readLanes(paths).find((l) => l.key === "unfiled")!.items).toContain(item.id);
  });
});

describe("retireLane refuses a non-empty stack and never partially applies", () => {
  test("retireLane refuses when the STORED stack is non-empty, and writes nothing", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", ["i-a", "i-b"])]);
    const before = fs.readFileSync(lanesPath(), "utf8");
    const result = retireLane(paths, "office");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("2 items") });
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before);
  });

  test("retireLane refuses even when every id in the stack is an unreadable ghost", () => {
    ensureSpool(paths);
    // Neither id resolves to a real packet — both are ghosts — but the STORED
    // array still has length 2, and that is the number that decides.
    writeLanes(paths, [lane("office", ["i-ghost-1", "i-ghost-2"])]);
    expect(retireLane(paths, "office").ok).toBe(false);
    expect(readLanes(paths).map((l) => l.key)).toEqual(["office"]); // still there
  });

  test("retireLane refuses a row this build cannot parse — its item count cannot be confirmed", () => {
    ensureSpool(paths);
    writeJson(lanesPath(), [
      { key: "office", label: "Office", window: "work hours", items: [] },
      { key: "school", items: [] }, // missing `window` — unparseable
    ]);
    const before = fs.readFileSync(lanesPath(), "utf8");
    const result = retireLane(paths, "school");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("cannot be confirmed") });
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before); // nothing written — not even deleted
    expect(listItems(paths).unreadable.map((u) => u.id)).toEqual(["school"]);
  });

  test("retireLane succeeds when the stored stack is empty, and removes exactly that row", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", []), lane("free", ["i-a"])]);
    expect(retireLane(paths, "office")).toEqual({ ok: true });
    expect(readLanes(paths).map((l) => l.key)).toEqual(["free"]);
  });

  test("retireLane on an unknown key reports failure without touching the file", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const before = fs.readFileSync(lanesPath(), "utf8");
    expect(retireLane(paths, "nope").ok).toBe(false);
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before);
  });

  test("retireLane refuses the seed lane even when its stored stack is empty", () => {
    ensureSpool(paths); // seeds exactly one row, key "unfiled", empty stack
    const before = fs.readFileSync(lanesPath(), "utf8");
    const result = retireLane(paths, "unfiled");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cannot be placed");
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before); // nothing written
    expect(readLanes(paths).map((l) => l.key)).toEqual(["unfiled"]); // still there

    // And the fallback it protects still resolves.
    const item = createItem(paths, { title: "unresolvable lane", lane: "does-not-exist" });
    expect(item.lane).toBe("unfiled");
    expect(item.unplaced).toBe(true);
    expect(readLanes(paths).find((l) => l.key === "unfiled")!.items).toContain(item.id);
  });

  test("retireLane refuses a lane whose stack is empty but whose packets still name it", () => {
    // The stored stack is not the only way an item is IN a lane: arm 1 adopts an
    // item whose packet names a lane the stored stack has forgotten, and it
    // renders under that group header, ranked. Retiring on the strength of an
    // empty `items` array therefore evicts an item the human can see.
    ensureSpool(paths);
    writeLanes(paths, [lane("unfiled", []), lane("office", [])]);
    const item = createItem(paths, { title: "invoice for aurora", lane: "office" });
    expect(item.lane).toBe("office");
    // The stored stack forgets it — a hand-edit, a half-applied move.
    writeLanes(paths, [lane("unfiled", []), lane("office", [])]);
    expect(readLanes(paths).find((l) => l.key === "office")!.items).toEqual([]);
    const before = fs.readFileSync(lanesPath(), "utf8");
    expect(queueSlice(readLanes(paths), listItems(paths).items).map((r) => [r.lane, r.item.id])).toEqual([
      ["office", item.id],
    ]);

    const result = retireLane(paths, "office");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(item.id);
      expect(result.reason).toContain("never evicts an item on the human's behalf");
    }
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before); // nothing written
    expect(getSpoolItem(paths, item.id)!.lane).toBe("office");
    expect(queueSlice(readLanes(paths), listItems(paths).items)).toHaveLength(1);
  });

  test("retireLane still retires an ordinary empty lane named anything but the seed key", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("unfiled", []), lane("office", [])]);
    expect(retireLane(paths, "office")).toEqual({ ok: true });
    expect(readLanes(paths).map((l) => l.key)).toEqual(["unfiled"]);
  });
});

describe("reorderLane sets a lane's stack to an exact permutation, and adopts across lanes", () => {
  test("reorderLane within one lane rewrites only that lane's order", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const a = createItem(paths, { title: "a", lane: "office" });
    const b = createItem(paths, { title: "b", lane: "office" });
    const c = createItem(paths, { title: "c", lane: "office" });
    const result = reorderLane(paths, "office", [c.id, a.id, b.id]);
    expect(result.items).toEqual([c.id, a.id, b.id]);
    expect(readLanes(paths).find((l) => l.key === "office")!.items).toEqual([c.id, a.id, b.id]);
  });

  test("reorderLane adopts an id out of a DIFFERENT lane's stored stack", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", []), lane("free", [])]);
    const a = createItem(paths, { title: "a", lane: "office" });
    const b = createItem(paths, { title: "b", lane: "free" });
    reorderLane(paths, "office", [a.id, b.id]);
    const lanes = readLanes(paths);
    expect(lanes.find((l) => l.key === "office")!.items).toEqual([a.id, b.id]);
    expect(lanes.find((l) => l.key === "free")!.items).toEqual([]); // evicted from its old row
    // packet.lane is left as the stale hint — lanes.json alone decided this,
    // exactly like a hand cross-lane move.
    expect(getSpoolItem(paths, b.id)!.lane).toBe("free");
  });

  test("reorderLane throws and writes NOTHING when an id does not resolve to a readable packet", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const a = createItem(paths, { title: "a", lane: "office" });
    const before = fs.readFileSync(lanesPath(), "utf8");
    expect(() => reorderLane(paths, "office", [a.id, "i-does-not-exist"])).toThrow(/does not resolve/);
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before);
  });

  test("reorderLane throws on an unknown lane key", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    expect(() => reorderLane(paths, "nope", [])).toThrow(/No lane named/);
  });
});

describe("sub-tasks live INSIDE the item — the conservation law holds under the real disk writers too", () => {
  test("addSubtask appends with a minted id, touches no lanes.json, and never changes queueSlice's row count", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const item = createItem(paths, { title: "decompose me", lane: "office" });
    const lanesHash = hashOf(lanesPath());
    const before = queueSlice(readLanes(paths), listItems(paths).items).length;

    const next = addSubtask(paths, item.id, "first step");
    expect(next!.subtasks).toEqual([{ id: expect.any(String), title: "first step", done: false }]);
    expect(next!.subtasks![0]!.id).toMatch(/^st-/); // distinct prefix from an item id
    expect(hashOf(lanesPath())).toBe(lanesHash); // lanes.json untouched

    addSubtask(paths, item.id, "second step");
    expect(queueSlice(readLanes(paths), listItems(paths).items).length).toBe(before); // never grows
    expect(getSpoolItem(paths, item.id)!.subtasks!.map((s) => s.title)).toEqual(["first step", "second step"]);
  });

  test("addSubtask returns null and writes nothing for an id that does not resolve", () => {
    ensureSpool(paths);
    expect(addSubtask(paths, "i-does-not-exist", "x")).toBeNull();
  });

  test("setSubtaskDone toggles exactly the named sub-task, in both directions, and leaves its siblings alone", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "with steps" });
    addSubtask(paths, item.id, "one");
    addSubtask(paths, item.id, "two");
    const [st1, st2] = getSpoolItem(paths, item.id)!.subtasks!;

    const marked = setSubtaskDone(paths, item.id, st1!.id, true);
    expect(marked!.subtasks).toEqual([
      { id: st1!.id, title: "one", done: true },
      { id: st2!.id, title: "two", done: false },
    ]);

    expect(setSubtaskDone(paths, item.id, st1!.id, false)!.subtasks![0]!.done).toBe(false);
  });

  test("setSubtaskDone returns null for an unknown sub-task id, and writes nothing", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "with steps" });
    addSubtask(paths, item.id, "one");
    const before = hashOf(packetPath(item.id));
    expect(setSubtaskDone(paths, item.id, "st-not-real", true)).toBeNull();
    expect(hashOf(packetPath(item.id))).toBe(before);
  });
});

describe("promoteSubtask — the ONLY promotion path in the codebase, and never reachable from a tool", () => {
  test("promoteSubtask mints a real item, removes the sub-task, lands at the BOTTOM of the parent's ACTUAL stack, and stamps actor \"you\"", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const parent = createItem(paths, { title: "parent", lane: "office", project: "aurora" });
    addSubtask(paths, parent.id, "spin this out");
    const sibling = createItem(paths, { title: "already in office", lane: "office" });
    const [sub] = getSpoolItem(paths, parent.id)!.subtasks!;

    const result = promoteSubtask(paths, parent.id, sub!.id);
    expect(result).not.toBeNull();
    const { parent: nextParent, promoted } = result!;

    expect(nextParent.subtasks).toEqual([]);
    expect(promoted.title).toBe("spin this out");
    expect(promoted.promotedFrom).toBe(parent.id);
    expect(promoted.project).toBe("aurora"); // inherits the parent's project
    expect(promoted.provenance).toContain(parent.title);
    // NOT built like a created item — a human click is neither "the master asking
    // a question" nor a session filing something.
    expect(promoted.desk).toBeUndefined();
    expect(promoted.unplaced).toBeUndefined();
    expect(promoted.timeline).toEqual([
      { at: promoted.captured, actor: "you", text: expect.stringContaining(parent.title) },
    ]);

    // Lands at the BOTTOM of the parent's real stack — after the sibling that was
    // already there, not wherever the packet's stale hint would imply.
    expect(readLanes(paths).find((l) => l.key === "office")!.items).toEqual([parent.id, sibling.id, promoted.id]);
    expect(getSpoolItem(paths, parent.id)!.subtasks).toEqual([]);
  });

  test("promoteSubtask leaves the promoted sibling unfiled when the parent itself has no stack", () => {
    ensureSpool(paths);
    const parent = createItem(paths, { title: "homeless parent" });
    addSubtask(paths, parent.id, "spin this out too");
    // Hand-edit: wipe every lane row, so the parent is in no stack at all.
    writeLanes(paths, []);
    const [sub] = getSpoolItem(paths, parent.id)!.subtasks!;

    const { promoted } = promoteSubtask(paths, parent.id, sub!.id)!;
    expect(promoted.desk).toBeUndefined();
    expect(promoted.unplaced).toBeUndefined();
    expect(readLanes(paths)).toEqual([]); // no row exists to receive it, and none was created
    expect(queueSlice(readLanes(paths), listItems(paths).items).map((r) => r.item.id)).not.toContain(promoted.id);
  });

  test("promoteSubtask returns null, and writes nothing, for an unknown parent or an unknown sub-task id", () => {
    ensureSpool(paths);
    expect(promoteSubtask(paths, "i-does-not-exist", "st-1")).toBeNull();
    const parent = createItem(paths, { title: "parent" });
    const before = hashOf(packetPath(parent.id));
    expect(promoteSubtask(paths, parent.id, "st-not-real")).toBeNull();
    expect(hashOf(packetPath(parent.id))).toBe(before);
  });
});

describe("agentsAddedCount — the queue footer's \"agents added N\"", () => {
  test("zero over a fresh store, and one after an agent files through create", () => {
    ensureSpool(paths);
    expect(agentsAddedCount(listItems(paths).items)).toBe(0);
    createItem(paths, { title: "filed by a session" }); // stamps provenance server-side
    expect(agentsAddedCount(listItems(paths).items)).toBe(1);
  });

  test("does not count an item with a different provenance, even one that mentions a session", () => {
    const item = SpoolItem.parse({
      id: "i-x",
      title: "x",
      provenance: "pasted transcript",
      captured: "Tue 16:42",
    });
    expect(agentsAddedCount([item])).toBe(0);
  });
});

// ── the weave stamp: its whole suite went out with looms ────────────────────
//
// `trackLoom` had six tests here, and the two that mattered asserted a file was
// NOT rewritten rather than that a field was: a weave had to leave lanes.json
// byte-identical, because removing woven ids from their stacks is the
// leave-at-weave-time behaviour CAP-11 forbids AND a deletion path that never
// calls rmSync. Whoever restores the verb restores those assertions with it —
// `packages/core/test/workspace-store.test.ts` still has the originals.

// ── the enrichment pass and the digests ─────────────────────────────────────

describe("applyExpertPass — the only writer of fixed, acceptance and commitments", () => {
  test("writes the brief beside the raw fragment, never over it, and marks every event a proposal", () => {
    ensureSpool(paths);
    const item = createItem(paths, {
      title: "onboarding",
      raw: "onboarding feels clunky?? ask diego",
      rawSource: "Telar Note",
    });

    const result = applyExpertPass(paths, item.id, {
      fixed: "Merge onboarding steps 2 and 3.",
      acceptance: ["a new user reaches the dashboard in two steps"],
      note: "decompressed the shorthand",
    })!;

    const after = getSpoolItem(paths, item.id)!;
    expect(after.raw).toBe("onboarding feels clunky?? ask diego"); // never overwritten
    expect(after.rawSource).toBe("Telar Note");
    expect(after.fixed).toBe("Merge onboarding steps 2 and 3.");
    expect(after.acceptance).toEqual(["a new user reaches the dashboard in two steps"]);
    // Every event the pass appended is a proposal awaiting a human look.
    const appended = after.timeline!.slice(1);
    expect(appended.length).toBe(1);
    expect(appended[0]!.actor).toBe("expert");
    expect(appended[0]!.proposal).toBe(true);
    expect(result.events).toBe(1);
  });

  test("mined commitments are APPENDED, carry a minted id, and never create an item", () => {
    ensureSpool(paths);
    const item = createItem(paths, { title: "sync notes", raw: "we'll sync Thursday" });
    const countBefore = listItems(paths).items.length;

    applyExpertPass(paths, item.id, { commitments: [{ text: "we'll sync Thursday", when: "Thursday" }] });
    applyExpertPass(paths, item.id, { commitments: [{ text: "and demo after", when: "next week" }] });

    const after = getSpoolItem(paths, item.id)!;
    expect(after.commitments!.map((c) => c.text)).toEqual(["we'll sync Thursday", "and demo after"]);
    for (const c of after.commitments!) {
      expect(c.id).toMatch(/^x-/);
      expect(c.itemId).toBe(item.id);
      expect(c.mined).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
    }
    // Gap detection reads expectations only — it never creates an item on its
    // own, and the conservation law says the same from the queue's side.
    expect(listItems(paths).items.length).toBe(countBefore);
    expect(minedCommitments(listItems(paths).items).map((c) => c.text)).toEqual([
      "we'll sync Thursday",
      "and demo after",
    ]);
  });

  test("a pass never touches lanes.json and returns null for an item that does not resolve", () => {
    ensureSpool(paths);
    writeLanes(paths, [lane("office", [])]);
    const item = createItem(paths, { title: "enrich me", lane: "office" });
    const before = hashOf(lanesPath());
    applyExpertPass(paths, item.id, { fixed: "a brief" });
    expect(hashOf(lanesPath())).toBe(before);
    expect(applyExpertPass(paths, "i-nothing", { fixed: "x" })).toBeNull();
  });
});

describe("the expert digests — experts write, the master reads", () => {
  test("a digest round-trips, is addressed by its own project, and lands beside the store", () => {
    ensureSpool(paths);
    const written = writeExpertDigest(paths, {
      project: "aurora",
      schemaVersion: 1,
      updated: "Tue 16:42",
      summary: "mid-flight on the retry work",
      methodology: "trunk-based",
      glossary: [{ term: "SEP", means: "the shared entry path" }],
      notes: ["diego owns the API surface"],
    });
    expect(written.project).toBe("aurora");
    expect(expertDigestPath(paths, "aurora")).toBe(path.join(paths.experts, "aurora", "digest.json"));
    expect(readExpertDigest(paths, "aurora")!.summary).toBe("mid-flight on the retry work");
    expect(listExpertDigests(paths).map((d) => d.project)).toEqual(["aurora"]);
  });

  test("a COLD expert reads null rather than throwing — a first pass has nothing to rehydrate from", () => {
    ensureSpool(paths);
    expect(readExpertDigest(paths, "never-seen")).toBeNull();
    expect(listExpertDigests(paths)).toEqual([]);
  });

  test("an unreadable digest degrades to null, and does NOT refuse the way a version-ahead packet does", () => {
    // The asymmetry is the point: a packet holds the user's own words and is
    // refused; a digest is the expert's own compression and the next pass
    // rewrites it, so degrading costs one cold pass and loses nothing a human
    // authored.
    ensureSpool(paths);
    writeExpertDigest(paths, { project: "aurora", schemaVersion: 1, updated: "Tue 16:42", summary: "", methodology: "", glossary: [], notes: [] });
    fs.writeFileSync(expertDigestPath(paths, "aurora"), "{{{ not json ][");
    expect(readExpertDigest(paths, "aurora")).toBeNull();
    expect(listExpertDigests(paths)).toEqual([]); // skipped, not reported as a project
  });

  test("a project name this store cannot address is null on READ and THROWS on write", () => {
    ensureSpool(paths);
    for (const bad of ["../../etc", "a/b", "", ".hidden"]) {
      expect(readExpertDigest(paths, bad)).toBeNull();
      expect(() =>
        writeExpertDigest(paths, { project: bad, schemaVersion: 1, updated: "x", summary: "", methodology: "", glossary: [], notes: [] }),
      ).toThrow(/invalid project/);
    }
  });

  test("the digests are NOT under the master's home, and not inside a packet", () => {
    // Four rejected locations, one of them asserted: a digest under the master's
    // own cwd would be the master's to rewrite by accident on any turn, which
    // inverts "experts write, master reads".
    ensureSpool(paths);
    writeExpertDigest(paths, { project: "aurora", schemaVersion: 1, updated: "x", summary: "", methodology: "", glossary: [], notes: [] });
    expect(fs.readdirSync(paths.home)).toEqual([]);
    expect(expertDigestPath(paths, "aurora").startsWith(paths.experts)).toBe(true);
    expect(expertDigestPath(paths, "aurora").startsWith(paths.packets)).toBe(false);
  });
});

// ── the subject axis: the same items, grouped by what they are ABOUT ────────

describe("subjectSlice groups by SUBJECT, and inherits its order from the lanes it does not replace", () => {
  const item = (over: Record<string, unknown> & { id: string; title: string }) =>
    SpoolItem.parse({ provenance: "note", captured: "Tue 16:42", ...over });
  const idsOf = (groups: ReturnType<typeof subjectSlice>) => groups.map((g) => g.rows.map((r) => r.item.id));

  test("every readable item lands in exactly one group, including the ones no lane holds", () => {
    // THE CONSERVATION LAW, and it is the reason this projection exists rather
    // than a filter over `rows`: `queueSlice` shows FILED items only, so a
    // subject view built on it would silently drop the unfiled and the floating
    // — a deletion path that never calls rmSync, with a footer count that still
    // says they are there. `i-a` is also pasted into a second stack, because a
    // duplicate id must not become a second row either.
    const lanes = [lane("office", ["i-a", "i-b"]), lane("evenings", ["i-c", "i-a"])];
    const items = [
      item({ id: "i-a", title: "a", project: "aurora" }),
      item({ id: "i-b", title: "b", project: "borealis" }),
      item({ id: "i-c", title: "c", project: "aurora" }),
      item({ id: "i-d", title: "d", project: "aurora" }), // in no stack and no hint — unfiled
      item({ id: "i-e", title: "e" }), // unfiled AND floating
      item({ id: "i-f", title: "f", project: "borealis", lane: "retired" }), // arm 3: lane gone
    ];

    const rows = subjectSlice(lanes, items).flatMap((g) => g.rows);
    expect(rows.length).toBe(items.length);
    expect(new Set(rows.map((r) => r.item.id)).size).toBe(items.length); // once each, not twice
    // …and the queue really does show fewer, so the count above is conservation
    // and not an accident of a fixture where everything happened to be filed.
    expect(queueSlice(lanes, items).length).toBe(3);
  });

  test("floating items form ONE group and it comes last", () => {
    // `item-model.md`: "Absent = floating. Floating is a valid resting state,
    // not an error." Hiding them would lose exactly the captures nobody has
    // filed yet — the ones most likely to be forgotten. The group carries NO
    // `project` KEY rather than an undefined one, so a renderer branching on
    // presence cannot read it as a subject literally named "undefined".
    const lanes = [lane("office", ["i-a", "i-b", "i-c"])];
    const groups = subjectSlice(lanes, [
      item({ id: "i-a", title: "a", project: "zephyr" }),
      item({ id: "i-b", title: "b" }),
      item({ id: "i-c", title: "c", project: "aurora" }),
      item({ id: "i-d", title: "d" }), // floating and unfiled — same group
      item({ id: "i-e", title: "e", project: "" }), // an EMPTY subject is the absence, not a group
    ]);
    expect(groups.map((g) => g.project)).toEqual(["aurora", "zephyr", undefined]);
    expect(idsOf(groups)).toEqual([["i-c"], ["i-a"], ["i-b", "i-d", "i-e"]]);
    expect(Object.keys(groups.at(-1)!)).toEqual(["rows"]);
    // Nothing empty is emitted: a heading with no rows under it is noise.
    expect(subjectSlice([], []).length).toBe(0);
    expect(subjectSlice(lanes, [item({ id: "i-a", title: "a", project: "aurora" })]).length).toBe(1);
  });

  test("subjects sort alphabetically and CASE-INSENSITIVELY, and never by anything a clock knows", () => {
    // Case-insensitive because an ASCII sort puts every capitalised subject
    // before every lowercase one — "Borealis" and "Zephyr" would sort ahead of
    // "aurora", which reads as random to the human who typed them. Alphabetical
    // because it is stable and predictable: "most recently touched" would be a
    // clock deciding what a surface draws, which §3.2 still forbids outright.
    const lanes = [lane("office", ["i-1", "i-2", "i-3", "i-4"])];
    const groups = subjectSlice(lanes, [
      item({ id: "i-1", title: "1", project: "Zephyr" }),
      item({ id: "i-2", title: "2", project: "aurora" }),
      item({ id: "i-3", title: "3", project: "Borealis" }),
      item({ id: "i-4", title: "4", project: "ozom-gv" }),
    ]);
    expect(groups.map((g) => g.project)).toEqual(["aurora", "Borealis", "ozom-gv", "Zephyr"]);

    // Folding is LOSSY, so two subjects differing only in case stay two groups
    // — the key is the item's own string — and their order is decided rather
    // than left to whichever stack mentioned one first.
    const cased = subjectSlice(
      [lane("office", ["i-b", "i-a"])],
      [item({ id: "i-a", title: "a", project: "Aurora" }), item({ id: "i-b", title: "b", project: "aurora" })],
    );
    expect(cased.map((g) => g.project)).toEqual(["Aurora", "aurora"]);
  });

  test("order INSIDE a subject is the lane-stack walk, not the order the items arrived in", () => {
    // The user already expressed an order by arranging the stacks, and this
    // projection has no business inventing a second one. Re-deriving it here
    // would also be a second implementation of the reconcile rule; `queueSlice`
    // owns that, so a row's lane and rank are the ones the queue itself shows
    // and the two views cannot drift.
    const lanes = [lane("office", ["i-c", "i-a"]), lane("evenings", ["i-b"])];
    const items = [
      item({ id: "i-a", title: "a", project: "aurora" }),
      item({ id: "i-b", title: "b", project: "aurora" }),
      item({ id: "i-c", title: "c", project: "aurora" }),
    ];
    const rows = subjectSlice(lanes, items)[0]!.rows;
    expect(rows.map((r) => r.item.id)).toEqual(["i-c", "i-a", "i-b"]); // NOT a, b, c
    expect(rows.map((r) => `${r.lane}:${r.rank}`)).toEqual(["office:1", "office:2", "evenings:1"]);
  });

  test("an item in no stack sorts after every stacked item of its subject, and claims no lane", () => {
    // An unfiled item still belongs to its subject, so it is shown — but giving
    // it a lane or a rank to make the row uniform would render it as filed when
    // it is not, which is the same lie as rendering the packet's `lane` hint as
    // its location. Their relative INPUT order is kept rather than re-sorted, so
    // the caller's read order survives the projection.
    const lanes = [lane("office", ["i-b"])];
    const rows = subjectSlice(lanes, [
      item({ id: "i-z", title: "z", project: "aurora" }),
      item({ id: "i-a", title: "a", project: "aurora" }),
      item({ id: "i-b", title: "b", project: "aurora" }),
    ])[0]!.rows;
    expect(rows.map((r) => r.item.id)).toEqual(["i-b", "i-z", "i-a"]);
    expect(Object.keys(rows[1]!)).toEqual(["item"]); // no lane, no rank — absent, not zeroed
    expect(rows[1]!.lane).toBeUndefined();
    expect(rows[1]!.rank).toBeUndefined();
  });

  test("a subject spread across several lanes is ONE group — this is the whole point", () => {
    // The failure this exists to prevent: ozom-gv's four months are cut by
    // milestone and dependency, so grouping by lane files all 29 open issues
    // under "Office" and the axis carries no information. Grouped by subject the
    // work reads as one body regardless of when the user meant to do each piece,
    // and the lane survives ON THE ROW as secondary structure.
    const lanes = [lane("office", ["i-a", "i-d"]), lane("evenings", ["i-b"]), lane("weekend", ["i-c"])];
    const groups = subjectSlice(lanes, [
      item({ id: "i-a", title: "a", project: "ozom-gv" }),
      item({ id: "i-b", title: "b", project: "ozom-gv" }),
      item({ id: "i-c", title: "c", project: "ozom-gv" }),
      item({ id: "i-d", title: "d", project: "aurora" }),
    ]);
    expect(groups.map((g) => g.project)).toEqual(["aurora", "ozom-gv"]);
    expect(idsOf(groups)).toEqual([["i-d"], ["i-a", "i-b", "i-c"]]);
    expect(groups[1]!.rows.map((r) => r.lane)).toEqual(["office", "evenings", "weekend"]);
  });

  test("an adopted orphan is placed where the QUEUE places it, hint and all", () => {
    // Arm 1 of the reconcile rule: an id in no stack whose packet names a real
    // lane is adopted into it, appended after the stacked rows and ranked over
    // the projection. Re-walking the stacks here instead of calling `queueSlice`
    // would give this row no lane at all, and the subject view would then
    // disagree with the queue about where the same item sits.
    const lanes = [lane("office", ["i-a"])];
    const rows = subjectSlice(lanes, [
      item({ id: "i-a", title: "a", project: "aurora" }),
      item({ id: "i-b", title: "b", project: "aurora", lane: "office" }), // orphan, adoptable
    ])[0]!.rows;
    expect(rows.map((r) => `${r.item.id}@${r.lane}:${r.rank}`)).toEqual(["i-a@office:1", "i-b@office:2"]);
  });

  test("NO CLOCK IS READ ANYWHERE IN THIS PROJECTION", () => {
    // §3.2's line, stated for this file: "a clock may be read by an agent
    // deciding what to do; a clock may not be read by a renderer deciding what
    // to draw." A projection is the renderer's side of that. Three witnesses:
    // the output mints no field of its own beyond {project, rows} and
    // {item, lane, rank}, so no minted stamp can hide in it; two calls over the
    // same input are identical, so nothing non-deterministic is consulted; and
    // capture labels that read as "later" move nothing, so `captured` is passed
    // through and never compared.
    const lanes = [lane("office", ["i-a", "i-b"])];
    const early = [
      item({ id: "i-a", title: "a", project: "aurora", captured: "Mon 09:00" }),
      item({ id: "i-b", title: "b", project: "aurora", captured: "Fri 23:59" }),
    ];
    const swapped = [
      item({ id: "i-a", title: "a", project: "aurora", captured: "Fri 23:59" }),
      item({ id: "i-b", title: "b", project: "aurora", captured: "Mon 09:00" }),
    ];
    const groups = subjectSlice(lanes, early);
    for (const g of groups) {
      expect(Object.keys(g).every((k) => k === "project" || k === "rows")).toBe(true);
      for (const r of g.rows) expect(Object.keys(r).every((k) => k === "item" || k === "lane" || k === "rank")).toBe(true);
    }
    expect(groups).toEqual(subjectSlice(lanes, early));
    expect(idsOf(subjectSlice(lanes, swapped))).toEqual(idsOf(groups));
  });
});
