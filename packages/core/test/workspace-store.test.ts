// The workspace store's proof (story 5.1, AC1–AC5, AC7 and AC9).
//
// SANDBOX MECHANISM: the FIRST of INV-7's three sanctioned ones — TELAR_HOME
// pinned to an fs.mkdtempSync root at module scope AND re-pinned in a beforeEach,
// because bun runs every suite in ONE process and a sibling file can move the
// variable out from under this one. Every test here touches real disk; there is
// no injected-reader escape from a store whose whole job is the filesystem.
// TELAR_HOME is never BLANKED to "disable" the read — an empty TELAR_HOME
// resolves to the operator's real ~/.telar (manifest.ts's telarDir states why),
// which is exactly how a synthetic billing line reached it during story 1.1.
//
// WHAT IS PROVED WITH A CONTENT HASH AND NOT AN MTIME, in three places below:
// "this file was not rewritten". macOS mtime resolution is coarse enough that a
// rewrite inside one tick passes an mtime check, so the claim would be a comment
// wearing a test's clothes. sha256 of the bytes cannot be fooled that way.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "telar-workspace-store-"));
const ORIGINAL_HOME = process.env.TELAR_HOME;
process.env.TELAR_HOME = HOME;

beforeEach(() => {
  process.env.TELAR_HOME = HOME;
  // A fresh store per test. rmSync targets the SANDBOX's workspace subtree only.
  fs.rmSync(path.join(HOME, "workspace"), { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const {
  attachmentTally,
  createItem,
  deskSlice,
  ensureWorkspace,
  getWorkspaceItem,
  listItems,
  migratePacket,
  queueSlice,
  rankOf,
  readLanes,
  readPacketAttachments,
  updateItem,
  workspaceDir,
  workspaceHomeDir,
  writeLanes,
} = await import("../src/workspace/store");
const { ITEM_SCHEMA_VERSION, Item, WorkspaceLane } = await import("../src/workspace/schema");
type Item = import("../src/workspace/schema").Item;
type ItemPatch = import("../src/workspace/store").ItemPatch;
type WorkspaceLane = import("../src/workspace/schema").WorkspaceLane;

// ── local helpers (paths composed here on purpose: this suite asserts the
//    LAYOUT, so re-deriving it from the module under test would assert nothing) ─
const lanesPath = () => path.join(HOME, "workspace", "lanes.yaml");
const packetDirOf = (id: string) => path.join(HOME, "workspace", "packets", id);
const packetPath = (id: string) => path.join(packetDirOf(id), "packet.yaml");
const hashOf = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const lane = (key: string, items: string[] = []): WorkspaceLane => ({
  key,
  label: key.toUpperCase(),
  window: "whenever",
  items,
});

// ── AC1 — the store's layout ────────────────────────────────────────────────

describe("AC1 the store's layout on disk", () => {
  test("AC1 ensureWorkspace creates lanes.yaml, packets/ and a home/ that holds NO store files", () => {
    ensureWorkspace();

    expect(workspaceDir()).toBe(path.join(HOME, "workspace"));
    expect(workspaceHomeDir()).toBe(path.join(HOME, "workspace", "home"));
    expect(fs.existsSync(lanesPath())).toBe(true);
    expect(fs.existsSync(path.join(HOME, "workspace", "packets"))).toBe(true);

    // AD-9/SPEC.md — the master's cwd is a dedicated, EMPTY directory, so "the
    // store above it stays outside the master's path-based write boundary" is
    // structurally true rather than merely intended.
    expect(fs.existsSync(workspaceHomeDir())).toBe(true);
    const homeEntries = fs.readdirSync(workspaceHomeDir());
    expect(homeEntries).toEqual([]);
    expect(homeEntries).not.toContain("lanes.yaml");
    expect(homeEntries).not.toContain("packets");
  });

  test("AC1 the store seeds EXACTLY ONE ordinary lane — written by the store's ensure step, never by a tool", () => {
    ensureWorkspace();
    const lanes = readLanes();
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.key).toBe("unfiled");
    expect(lanes[0]!.items).toEqual([]);
    // An ORDINARY row: it carries the same fields every other lane does and no
    // extra ones, which is what "carries no special behaviour in code" means
    // structurally (NFR-OW-10 — lane structure is the human's).
    expect(Object.keys(lanes[0]!).sort()).toEqual(["items", "key", "label", "note", "window"]);
  });

  test("AC1 an item is packets/<id>/packet.yaml and attachments are its SIBLINGS", () => {
    const item = createItem({ title: "a one-liner" });
    expect(fs.existsSync(packetPath(item.id))).toBe(true);
    fs.writeFileSync(path.join(packetDirOf(item.id), "notes.md"), "# gathered along the way");
    expect(fs.readdirSync(packetDirOf(item.id)).sort()).toEqual(["notes.md", "packet.yaml"]);
  });

  test("AC1 a read against a TELAR_HOME with NO workspace/ returns the empty values and does not throw", () => {
    // loadManifest is this repo's ONE deliberate throw-on-absent and is
    // explicitly not the model: a workspace that has never been written is the
    // ordinary first-run state, not an error.
    expect(fs.existsSync(path.join(HOME, "workspace"))).toBe(false);
    expect(readLanes()).toEqual([]);
    expect(listItems()).toEqual({ items: [], unreadable: [] });
    expect(getWorkspaceItem("i-nothing")).toBeNull();
    expect(rankOf([], "i-nothing")).toBeNull();
    expect(queueSlice([], [])).toEqual([]);
    expect(deskSlice([])).toEqual([]);
  });

  test("AC1 ensureWorkspace is idempotent and does NOT resurrect a retired seed lane", () => {
    ensureWorkspace();
    writeLanes([lane("office")]); // the human retired `unfiled` and made their own
    ensureWorkspace();
    expect(readLanes().map((l) => l.key)).toEqual(["office"]);
  });

  test("AC1 a malformed or traversal item id is treated as not-found, never as a 500", () => {
    ensureWorkspace();
    for (const bad of ["../../etc", "a/b", "", "..", "has space"]) {
      expect(getWorkspaceItem(bad)).toBeNull();
    }
  });
});

// ── AC2 — one shape for all items ───────────────────────────────────────────

describe("AC2 one shape for all items", () => {
  const RIPE = {
    title: "Rework onboarding flow",
    project: "aurora",
    raw: "onboarding feels clunky?? ask diego — maybe merge steps 2/3",
    rawSource: "Telar Note · Tue 16:42",
  };

  test("AC2 a bare one-liner and a fully ripened packet go through ONE writer, ONE reader and ONE schema", () => {
    ensureWorkspace();
    const bare = createItem({ title: "call María" });
    const ripe = createItem(RIPE);

    // The SAME reader, and both parse under the SAME schema.
    const readBare = getWorkspaceItem(bare.id)!;
    const readRipe = getWorkspaceItem(ripe.id)!;
    expect(Item.safeParse(readBare).success).toBe(true);
    expect(Item.safeParse(readRipe).success).toBe(true);

    // The bare one has no tally and no attachments — and needed no second path
    // to get there.
    expect(readPacketAttachments(bare.id)).toEqual([]);
    expect(attachmentTally(readPacketAttachments(bare.id))).toEqual({ files: 0, mockups: 0 });
    expect(readBare.raw).toBeUndefined();
    expect(readRipe.raw).toBe(RIPE.raw);
    expect(readRipe.rawSource).toBe(RIPE.rawSource);
    // Both carry a version, because there is only one shape to version.
    expect(readBare.schemaVersion).toBe(ITEM_SCHEMA_VERSION);
    expect(readRipe.schemaVersion).toBe(ITEM_SCHEMA_VERSION);
  });

  test("AC2 adding an attachment changes the TALLY and rewrites NO packet.yaml — content hash, not mtime", () => {
    ensureWorkspace();
    const item = createItem({ title: "gather the mockups" });
    const before = hashOf(packetPath(item.id));
    expect(attachmentTally(readPacketAttachments(item.id))).toEqual({ files: 0, mockups: 0 });

    fs.writeFileSync(path.join(packetDirOf(item.id), "brief.md"), "the brief");
    fs.writeFileSync(path.join(packetDirOf(item.id), "flow.png"), "not really a png");

    expect(attachmentTally(readPacketAttachments(item.id))).toEqual({ files: 1, mockups: 1 });
    // THIS is what "no migration when an item grows" means mechanically, and it
    // is only true because the tally is derived rather than persisted.
    expect(hashOf(packetPath(item.id))).toBe(before);
  });
});

// ── AC3 — atomic writes ─────────────────────────────────────────────────────

describe("AC3 atomic writes", () => {
  test("AC3 no .tmp survives any write path", () => {
    ensureWorkspace();
    const a = createItem({ title: "one" });
    createItem({ title: "two" });
    updateItem(a.id, { title: "one, renamed" });
    writeLanes(readLanes());

    const strays: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.name.endsWith(".tmp")) strays.push(abs);
      }
    };
    walk(path.join(HOME, "workspace"));
    expect(strays).toEqual([]);
  });
});

// ── AC4 — the version field and migrate-on-read ─────────────────────────────

describe("AC4 migrate-on-read — five behaviours, five tests", () => {
  const base = {
    id: "i-abc123",
    title: "a hand-authored packet",
    provenance: "note",
    captured: "Tue 16:42",
  };

  test("AC4 ABSENT schemaVersion normalises to 1 BEFORE any comparison — the hand-authored case AD-6 invites", () => {
    const out = migratePacket({ ...base }) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(1);
    // …and it really parses, so "normalised" is not merely a field edit.
    expect(Item.parse(out).schemaVersion).toBe(1);
  });

  test("AC4 LOWER migrates up the ladder — the 0 → 1 rung mints the sub-task ids the fixtures' shape lacks", () => {
    const v0 = {
      ...base,
      schemaVersion: 0,
      // exactly fixtures.ts's WsItem.subtasks shape: {title, done?} and NO id
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
    // And the migrated shape is what the schema wants.
    expect(Item.safeParse(out).success).toBe(true);
  });

  test("AC4 EQUAL is returned UNTOUCHED — the discriminator, without which 'migrate everything on every read' passes", () => {
    const current = { ...base, schemaVersion: ITEM_SCHEMA_VERSION };
    // Identity, not merely deep equality: a migratePacket that rebuilt the
    // object on every read would satisfy toEqual and fail this.
    expect(migratePacket(current)).toBe(current);
  });

  test("AC4 HIGHER throws — never migrated down, never defaulted", () => {
    let thrown: Error | null = null;
    try {
      migratePacket({ ...base, schemaVersion: ITEM_SCHEMA_VERSION + 1 });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    // The diagnosis, in the asserted value: the AD id, the rule, the
    // consequence, the next step.
    expect(thrown!.message).toContain("AD-7");
    expect(thrown!.message).toContain("newer Telar");
    expect(thrown!.message).toContain("Upgrade Telar");
  });

  test("AC4 MALFORMED throws, same shape", () => {
    for (const bad of [null, 42, "a string", ["a", "sequence"]]) {
      expect(() => migratePacket(bad)).toThrow(/AD-7/);
    }
    expect(() => migratePacket({ ...base, schemaVersion: "one" })).toThrow(/schemaVersion/);
  });

  test("AC4 lanes.yaml's schema carries NO version field and packet.yaml's DOES — asserted in both directions", () => {
    ensureWorkspace();
    const item = createItem({ title: "versioned" });

    const lanesRaw = YAML.parse(fs.readFileSync(lanesPath(), "utf8")) as Record<string, unknown>[];
    for (const l of lanesRaw) {
      expect(Object.keys(l)).not.toContain("version");
      expect(Object.keys(l)).not.toContain("schemaVersion");
    }
    // The schema itself, not merely today's written bytes: an unknown key on a
    // lane is STRIPPED, which is what "lanes.yaml is not versioned" means.
    const stripped = WorkspaceLane.parse({ ...lane("x"), schemaVersion: 9 }) as Record<string, unknown>;
    expect(stripped.schemaVersion).toBeUndefined();

    const packetRaw = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8")) as Record<string, unknown>;
    expect(packetRaw.schemaVersion).toBe(ITEM_SCHEMA_VERSION);
  });

  test("AC4 migrate-on-read writes NOTHING back — content hash unchanged across a read", () => {
    ensureWorkspace();
    const item = createItem({ title: "read me" });
    // Plant a lower version by hand, so the read genuinely migrates.
    const onDisk = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(packetPath(item.id), YAML.stringify({ ...onDisk, schemaVersion: 0 }));
    const before = hashOf(packetPath(item.id));

    const read = getWorkspaceItem(item.id)!;
    expect(read.schemaVersion).toBe(ITEM_SCHEMA_VERSION); // it DID migrate in memory
    expect(hashOf(packetPath(item.id))).toBe(before); // …and wrote nothing back

    // The migrated shape lands on the next LEGITIMATE write.
    updateItem(item.id, { title: "read me twice" });
    const after = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8")) as Record<string, unknown>;
    expect(after.schemaVersion).toBe(ITEM_SCHEMA_VERSION);
  });

  test("AC4 an UNKNOWN key set by hand survives an updateItem rewrite — the z.looseObject proof", () => {
    ensureWorkspace();
    const item = createItem({ title: "written by a newer telar", raw: "the original words" });
    const onDisk = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      packetPath(item.id),
      YAML.stringify({ ...onDisk, aFieldThisBuildHasNeverHeardOf: { nested: ["shape", 1] } }),
    );

    const read = getWorkspaceItem(item.id)! as Record<string, unknown>;
    expect(read.aFieldThisBuildHasNeverHeardOf).toEqual({ nested: ["shape", 1] });

    updateItem(item.id, { title: "renamed" });

    const after = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8")) as Record<string, unknown>;
    expect(after.aFieldThisBuildHasNeverHeardOf).toEqual({ nested: ["shape", 1] });
    expect(after.title).toBe("renamed");
    expect(after.raw).toBe("the original words");
  });

  test("AC4 the tolerance DISCRIMINATES — z.object would have stripped that key, z.looseObject does not", () => {
    // Both halves through the SAME zod the schema uses, so this cannot pass on a
    // mistaken belief about the library. Without it, the test above would prove
    // only that YAML.stringify round-trips.
    const { z } = require("zod") as typeof import("zod");
    const strict = z.object({ a: z.string() });
    const loose = z.looseObject({ a: z.string() });
    expect(strict.parse({ a: "x", extra: 1 })).toEqual({ a: "x" });
    expect(loose.parse({ a: "x", extra: 1 })).toEqual({ a: "x", extra: 1 });
  });
});

// ── §5.5-D9 — the reconcile rule, all four arms, each run TWICE ─────────────

describe("D9 the reconcile rule — lanes.yaml is authoritative, and reconciliation is projection-only", () => {
  // Hand-writes a packet WITHOUT touching lanes.yaml. This is the crash gap, and
  // it is also the WRITE-ORDER proof: the orphan arm can only adopt an item
  // whose packet was written FIRST.
  const plantPacket = (id: string, extra: Partial<Item> = {}) => {
    fs.mkdirSync(packetDirOf(id), { recursive: true });
    fs.writeFileSync(
      packetPath(id),
      YAML.stringify({
        id,
        title: `planted ${id}`,
        provenance: "note",
        captured: "Tue 16:42",
        schemaVersion: ITEM_SCHEMA_VERSION,
        ...extra,
      }),
    );
  };

  // "Run every read twice and assert nothing changes" — idempotence, per arm.
  const twice = <T,>(f: () => T): [T, T] => [f(), f()];

  test("D9 arm 1 ORPHAN — an id in no stack is adopted into the stack its packet names", () => {
    ensureWorkspace();
    writeLanes([lane("office", []), lane("free", [])]);
    plantPacket("i-orphan", { lane: "office" });

    const [a, b] = twice(() => queueSlice(readLanes(), listItems().items));
    expect(a.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["office", 1, "i-orphan"]]);
    expect(b).toEqual(a);
    // PROJECTION-ONLY: lanes.yaml was not rewritten to record the adoption.
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([]);
  });

  test("D9 arm 2 TOMBSTONE — a stack id with no readable packet is dropped from the projection, never thrown", () => {
    ensureWorkspace();
    writeLanes([lane("office", ["i-ghost"])]);

    const [a, b] = twice(() => queueSlice(readLanes(), listItems().items));
    expect(a).toEqual([]);
    expect(b).toEqual(a);
    // …and the human is TOLD, through the one diagnostic channel.
    const { unreadable } = listItems();
    expect(unreadable.map((u) => u.id)).toEqual(["i-ghost"]);
    expect(unreadable[0]!.reason).toContain("NEVER removed from lanes.yaml");
    // The id is still in lanes.yaml. A read that pruned it would be a deletion
    // path that never calls rmSync.
    expect(readLanes()[0]!.items).toEqual(["i-ghost"]);
  });

  test("D9 arm 3 LANE GONE — the item is UNFILED: listed and on the desk, excluded from the queue, rank null", () => {
    ensureWorkspace();
    writeLanes([lane("free", [])]);
    plantPacket("i-homeless", { lane: "office", desk: true }); // `office` was retired

    const [a, b] = twice(() => queueSlice(readLanes(), listItems().items));
    expect(a).toEqual([]); // excluded from the queue…
    expect(b).toEqual(a);
    expect(listItems().items.map((i) => i.id)).toEqual(["i-homeless"]); // …but never lost…
    expect(deskSlice(listItems().items).map((d) => d.id)).toEqual(["i-homeless"]); // …and still visible
    expect(rankOf(readLanes(), "i-homeless")).toBeNull();
    // No lane was created to receive it — that would be the agent lane-structure
    // change NFR-OW-10 reserves to the human.
    expect(readLanes().map((l) => l.key)).toEqual(["free"]);
  });

  test("D9 arm 3 an item whose packet names NO lane at all is unfiled by the same arm", () => {
    ensureWorkspace();
    writeLanes([lane("free", [])]);
    plantPacket("i-nolane");
    expect(queueSlice(readLanes(), listItems().items)).toEqual([]);
    expect(listItems().items.map((i) => i.id)).toEqual(["i-nolane"]);
  });

  test("D9 arm 4 DUPLICATE — the FIRST stack in lanes.yaml order wins and the later one is reported", () => {
    ensureWorkspace();
    plantPacket("i-dup", { lane: "office" });
    writeLanes([lane("office", ["i-dup"]), lane("free", ["i-dup"])]);

    const [a, b] = twice(() => queueSlice(readLanes(), listItems().items));
    expect(a.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["office", 1, "i-dup"]]);
    expect(b).toEqual(a);
    const dupes = listItems().unreadable.filter((u) => u.reason.includes("more than one lane"));
    expect(dupes.map((u) => u.id)).toEqual(["i-dup"]);
    expect(dupes[0]!.reason).toContain('"free"');
  });

  test("D9 an UNREADABLE packet directory does not remove its id from lanes.yaml across a create", () => {
    // The deletion path that never calls rmSync. If reconciliation wrote its
    // projection back, one transiently unreadable packet would be permanently
    // dropped from lanes.yaml by the very next create_item.
    ensureWorkspace();
    const survivor = createItem({ title: "keep me" });
    const sick = createItem({ title: "temporarily unreadable" });
    writeLanes([lane("office", [survivor.id, sick.id])]);

    fs.writeFileSync(packetPath(sick.id), "{{{ not yaml at all ][");
    expect(getWorkspaceItem(sick.id)).toBeNull();
    expect(listItems().unreadable.some((u) => u.id === sick.id)).toBe(true);

    createItem({ title: "an ordinary new item", lane: "office" });

    const after = readLanes().find((l) => l.key === "office")!.items;
    expect(after).toContain(sick.id);
    expect(after).toContain(survivor.id);
  });

  test("D9 a torn lane MOVE simply did not happen — no duplicate, no ambiguity", () => {
    ensureWorkspace();
    writeLanes([lane("office", []), lane("free", [])]);
    const item = createItem({ title: "mid-move", lane: "office" });
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([item.id]);

    // updateItem writes the packet and (simulating a crash) lanes.yaml is never
    // updated. The id is still in its OLD stack, so the orphan arm does not fire.
    updateItem(item.id, { lane: "free" });

    const rows = queueSlice(readLanes(), listItems().items);
    expect(rows.map((r) => [r.lane, r.item.id])).toEqual([["office", item.id]]);
    expect(rows.length).toBe(1); // exactly one row: no duplicate
  });
});

// ── AD-6 — the human-editability claim, exercised ───────────────────────────

describe("AD-6 lanes.yaml is authoritative, so a hand-edit WINS", () => {
  test("AD-6 a hand REORDER changes the ranks and rewrites NO packet.yaml", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const a = createItem({ title: "first", lane: "office" });
    const b = createItem({ title: "second", lane: "office" });
    expect(rankOf(readLanes(), a.id)).toBe(1);
    expect(rankOf(readLanes(), b.id)).toBe(2);
    const hashes = [hashOf(packetPath(a.id)), hashOf(packetPath(b.id))];

    // The hand-edit: swap two ids in the YAML, exactly as a text editor would.
    writeLanes([lane("office", [b.id, a.id])]);

    expect(rankOf(readLanes(), b.id)).toBe(1);
    expect(rankOf(readLanes(), a.id)).toBe(2);
    expect([hashOf(packetPath(a.id)), hashOf(packetPath(b.id))]).toEqual(hashes);
  });

  test("AD-6 a hand CROSS-LANE MOVE takes effect and rewrites NO packet.yaml, even though packet.lane still says otherwise", () => {
    ensureWorkspace();
    writeLanes([lane("office", []), lane("free", [])]);
    const item = createItem({ title: "moved by hand", lane: "office" });
    const before = hashOf(packetPath(item.id));
    expect(getWorkspaceItem(item.id)!.lane).toBe("office");

    // Move the id between stacks in the file. packet.lane is a RECOVERY HINT and
    // is consulted only when the id is in no stack — so lanes.yaml wins.
    writeLanes([lane("office", []), lane("free", [item.id])]);

    const rows = queueSlice(readLanes(), listItems().items);
    expect(rows.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["free", 1, item.id]]);
    expect(getWorkspaceItem(item.id)!.lane).toBe("office"); // the stale hint, harmlessly
    expect(hashOf(packetPath(item.id))).toBe(before);
  });
});

// ── AC5 — provenance, the desk, and filing ──────────────────────────────────

describe("AC5 creating an item files it, stamps provenance, and places it on the desk", () => {
  test("AC5 create files into the named lane, stamps provenance server-side, and sets desk true", () => {
    ensureWorkspace();
    writeLanes([lane("aurora", [])]);
    const item = createItem({ title: "ship the retry loom", project: "aurora", lane: "aurora" });

    expect(item.lane).toBe("aurora");
    expect(item.desk).toBe(true);
    expect(item.unplaced).toBeUndefined();
    expect(item.provenance).toBe("session");
    expect(rankOf(readLanes(), item.id)).toBe(1);
    // `captured` is a DISPLAY label, never a scheduling input: a shape check,
    // because asserting a value would be asserting the wall clock.
    expect(item.captured).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2}:\d{2}$/);
    // The session's identity rides the creation timeline entry's text, not a
    // field on the item (§5.5-D7 — no sessionId field is added).
    expect(Object.keys(item)).not.toContain("sessionId");
    expect(item.timeline!.length).toBe(1);
    expect(item.timeline![0]!.actor).toBe("session");
  });

  test("AC5 a create naming an UNKNOWN lane files into the seed lane and asks, rather than creating the lane", () => {
    ensureWorkspace();
    const item = createItem({ title: "the pdf thing", lane: "a-lane-nobody-made" });
    expect(item.lane).toBe("unfiled");
    expect(item.unplaced).toBe(true);
    expect(readLanes().map((l) => l.key)).toEqual(["unfiled"]); // NFR-OW-10 held
    expect(deskSlice([item])[0]!.hint).toBe("unplaced — what is it?");
  });

  test("AC5 the creation note reaches the timeline's TEXT and the caller cannot forge the actor", () => {
    ensureWorkspace();
    const item = createItem({ title: "captured", creationNote: "captured by facundo in session s-123" });
    expect(item.timeline![0]!.text).toBe("captured by facundo in session s-123");
    expect(item.timeline![0]!.actor).toBe("session"); // the store's, not the caller's
  });

  test("AC5 desk is cleared by updateItem({desk:false}) and the item STAYS in its lane", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const item = createItem({ title: "dismiss me", lane: "office" });
    expect(deskSlice(listItems().items).map((d) => d.id)).toEqual([item.id]);

    updateItem(item.id, { desk: false });

    expect(deskSlice(listItems().items)).toEqual([]);
    // Dismiss DRAINS TO THE QUEUE. There is no delete.
    expect(rankOf(readLanes(), item.id)).toBe(1);
    expect(getWorkspaceItem(item.id)).not.toBeNull();
  });

  test("AC5 a project-scoped view excludes a FLOATING item rather than treating it as a failure", () => {
    ensureWorkspace();
    const scoped = createItem({ title: "aurora work", project: "aurora" });
    const floating = createItem({ title: "no project yet" });
    const all = listItems().items;
    expect(all.length).toBe(2);
    expect(all.filter((i) => i.project === "aurora").map((i) => i.id)).toEqual([scoped.id]);
    expect(floating.project).toBeUndefined();
  });

  test("AC5 updateItem returns null for an item that does not exist", () => {
    ensureWorkspace();
    expect(updateItem("i-nothing", { title: "x" })).toBeNull();
  });
});

// ── AC9 — raw and rawSource are never overwritten ───────────────────────────

const REPO_TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const STORE_MODULE = fileURLToPath(new URL("../src/workspace/store.ts", import.meta.url)).replace(
  /\.ts$/,
  "",
);
// store.ts imports node:fs / node:path / node:crypto, so the throwaway fixture
// directory needs the workspace's own @types/node on its typeRoots — otherwise
// every fixture "fails to compile" for a reason that has nothing to do with
// ItemPatch, and the negative half of the proof would pass for the wrong reason.
// (event-bus.test.ts's fixtures need none of this because event-bus.ts imports
// only zod.)
const TYPE_ROOTS = fileURLToPath(new URL("../node_modules/@types", import.meta.url));

// packages/core/tsconfig.json is `include: ["src"], exclude: ["test"]`, so
// `bunx tsc --noEmit` in this workspace NEVER SEES THIS FILE. A bare
// @ts-expect-error here would be a comment wearing a test's clothes, so the
// compile-time claim is proved by RUNNING the compiler over a generated fixture,
// in both directions. Run through THIS runtime: the tsc shim is
// `#!/usr/bin/env node` and this repo is bun-only.
const typecheck = (source: string): { ok: boolean; output: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-workspace-compile-"));
  try {
    const file = path.join(dir, "fixture.ts");
    fs.writeFileSync(file, `import type { ItemPatch } from ${JSON.stringify(STORE_MODULE)};\n${source}\n`);
    const out = spawnSync(
      process.execPath,
      [
        REPO_TSC,
        "--noEmit",
        "--ignoreConfig",
        "--strict",
        "--target",
        "es2022",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--skipLibCheck",
        "--typeRoots",
        TYPE_ROOTS,
        "--types",
        "node",
        file,
      ],
      {
        encoding: "utf8",
        // THE CHILD GETS ITS OWN THROWAWAY ROOTS. A spawned process inherits the
        // parent's env unless told otherwise, so a child of this suite would
        // resolve the OPERATOR's ~/.telar. This particular child only compiles a
        // fixture and opens no store — but INV-7's child-probe arm is right not
        // to take that on trust, and hardening it costs one option.
        env: { ...process.env, HOME: dir, TELAR_HOME: dir },
      },
    );
    return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("AC9 raw and rawSource are never overwritten", () => {
  test("AC9 ItemPatch CANNOT EXPRESS a change to raw or rawSource — proved by running tsc", () => {
    // A TYPED DATA OBJECT, never a directive above a call: story 2.2 shipped a
    // @ts-expect-error above a call and it renamed directories under the
    // operator's real ~/.telar.
    for (const field of ["raw", "rawSource", "promotedFrom", "schemaVersion", "id", "timeline"]) {
      const r = typecheck(`const patch: ItemPatch = { ${field}: undefined as never };`);
      expect(r.ok).toBe(false);
      expect(r.output).toContain(field);
    }
  });

  test("AC9 the compile proof DISCRIMINATES — a patch of a PERMITTED field compiles clean", () => {
    // Without this half, a fixture failing to compile for any reason at all (a
    // bad path, a renamed export) would read as a passing AC9.
    const r = typecheck(`const patch: ItemPatch = { title: "fine", desk: false, lane: "office" };\nvoid patch;`);
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  test("AC9 a hostile updateItem past the type leaves both fields byte-identical AND is REPORTED", () => {
    ensureWorkspace();
    const item = createItem({
      title: "the user's own words",
      raw: "onboarding feels clunky?? ask diego",
      rawSource: "Telar Note · Tue 16:42",
    });
    const before = hashOf(packetPath(item.id));

    // The cast is what a JSON.parse, an `as`, or a future deserialization
    // boundary would produce. Silently dropping it would look identical, from
    // the outside, to honouring it — which is why it throws.
    const hostile = { raw: "REWRITTEN", rawSource: "REWRITTEN" } as unknown as ItemPatch;
    let thrown: Error | null = null;
    try {
      updateItem(item.id, hostile);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("AC9");
    expect(thrown!.message).toContain("raw");

    const after = getWorkspaceItem(item.id)!;
    expect(after.raw).toBe("onboarding feels clunky?? ask diego");
    expect(after.rawSource).toBe("Telar Note · Tue 16:42");
    expect(hashOf(packetPath(item.id))).toBe(before); // not even rewritten
  });

  test("AC9 a legitimate patch still writes, so the guard is not simply refusing everything", () => {
    ensureWorkspace();
    const item = createItem({ title: "before", raw: "kept" });
    const updated = updateItem(item.id, { title: "after", desk: false })!;
    expect(updated.title).toBe("after");
    expect(updated.raw).toBe("kept");
    expect(getWorkspaceItem(item.id)!.title).toBe("after");
  });
});

// ── AC8 proof 1 — the absence that IS the moat ──────────────────────────────

describe("AC8 the Item schema exposes no accept path", () => {
  test("AC8 there is no status, state, done or accepted field on an item — and unknown keys are not it", () => {
    ensureWorkspace();
    const item = createItem({ title: "nothing to transition" });
    for (const forbidden of ["status", "state", "done", "accepted", "acceptedAt", "acceptedBy"]) {
      expect(Object.keys(item)).not.toContain(forbidden);
    }
    // The schema, not merely one instance: these are not optional-and-absent,
    // they are not in the shape at all. z.looseObject preserves an unknown key
    // from DISK but never invents one, and nothing in this store writes one.
    const shapeKeys = Object.keys(Item.shape);
    for (const forbidden of ["status", "state", "done", "accepted"]) {
      expect(shapeKeys).not.toContain(forbidden);
    }
    // Anti-vacuity: the shape really was read.
    expect(shapeKeys).toContain("title");
    expect(shapeKeys.length).toBeGreaterThanOrEqual(19);
  });
});

// ── A5 — the pure projections ───────────────────────────────────────────────

describe("A5 the pure projections take already-read data and touch no disk", () => {
  const item = (over: Partial<Item> & { id: string; title: string }): Item =>
    Item.parse({ provenance: "note", captured: "Tue 16:42", ...over });

  test("A5 rankOf is 1-BASED and returns null for an unfiled item", () => {
    const lanes = [lane("office", ["i-a", "i-b"]), lane("free", ["i-c"])];
    expect(rankOf(lanes, "i-a")).toBe(1); // 1-based: every rendering in the tree is
    expect(rankOf(lanes, "i-b")).toBe(2);
    expect(rankOf(lanes, "i-c")).toBe(1); // per-lane, not global
    expect(rankOf(lanes, "i-nowhere")).toBeNull();
    expect(rankOf([], "i-a")).toBeNull();
  });

  test("A5 queueSlice's COUNT is unchanged when sub-tasks are added — NFR-OW-3's conservation law", () => {
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

  test("A5 queueSlice ranks per lane, in lane order then stack order", () => {
    const lanes = [lane("office", ["i-b", "i-a"]), lane("free", ["i-c"])];
    const items = ["i-a", "i-b", "i-c"].map((id) => item({ id, title: id }));
    expect(queueSlice(lanes, items).map((r) => `${r.lane}:${r.rank}:${r.item.id}`)).toEqual([
      "office:1:i-b",
      "office:2:i-a",
      "free:1:i-c",
    ]);
  });

  test("A5 deskSlice emits {id,title,tag?,hint?,unplaced?} from ITEM FIELDS ALONE", () => {
    const cards = deskSlice([
      item({ id: "i-1", title: "Remove CSV export button", project: "aurora", desk: true, deadline: { label: "Fri", kind: "external" } }),
      item({ id: "i-2", title: "Call María — invoice", desk: true }),
      item({ id: "i-3", title: "the pdf thing", desk: true, unplaced: true }),
      item({ id: "i-4", title: "not on the desk" }),
      item({ id: "i-5", title: "mirrored one", desk: true, mirrored: "#214" }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["i-1", "i-2", "i-3", "i-5"]);
    expect(cards[0]).toEqual({ id: "i-1", title: "Remove CSV export button", tag: "aurora", hint: "Fri · external" });
    expect(cards[1]).toEqual({ id: "i-2", title: "Call María — invoice" });
    expect(cards[2]).toEqual({ id: "i-3", title: "the pdf thing", hint: "unplaced — what is it?", unplaced: true });
    expect(cards[3]).toEqual({ id: "i-5", title: "mirrored one", hint: "mirrored #214" });
    // The card shape carries no field the fixtures' DeskItem does not.
    for (const c of cards) {
      for (const k of Object.keys(c)) expect(["id", "title", "tag", "hint", "unplaced"]).toContain(k);
    }
  });

  test("A5 attachmentTally counts siblings and excludes packet.yaml", () => {
    expect(attachmentTally([])).toEqual({ files: 0, mockups: 0 });
    expect(attachmentTally(["packet.yaml"])).toEqual({ files: 0, mockups: 0 });
    expect(attachmentTally(["packet.yaml", "brief.md", "notes.txt", "flow.png", "wire.SVG"])).toEqual({
      files: 2,
      mockups: 2,
    });
  });

  test("A5 the tally excludes SUBDIRECTORIES, because the reader hands it files only", () => {
    ensureWorkspace();
    const it = createItem({ title: "with a subdirectory" });
    fs.writeFileSync(path.join(packetDirOf(it.id), "brief.md"), "x");
    fs.mkdirSync(path.join(packetDirOf(it.id), "drafts"));
    fs.writeFileSync(path.join(packetDirOf(it.id), "drafts", "v1.md"), "x");

    expect(readPacketAttachments(it.id)).toEqual(["brief.md"]);
    expect(attachmentTally(readPacketAttachments(it.id))).toEqual({ files: 1, mockups: 0 });
  });
});
