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
// WHAT IS PROVED WITH A CONTENT HASH AND NOT AN MTIME, in TEN assertions below
// (`grep -n 'hashOf(' | grep toBe` — the header first said three, and the count
// was wrong before the review-fix round added four more): "this file was not
// rewritten", and its two-direction twin "this file WAS". macOS mtime resolution
// is coarse enough that a rewrite inside one tick passes an mtime check, so the
// claim would be a comment wearing a test's clothes. sha256 of the bytes cannot
// be fooled that way.
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
  addSubtask,
  agentsAddedCount,
  attachmentTally,
  createItem,
  createLane,
  deskSlice,
  ensureWorkspace,
  getWorkspaceItem,
  listItems,
  migratePacket,
  promoteSubtask,
  queueSlice,
  rankOf,
  readLanes,
  readLanesReport,
  readPacketAttachments,
  renameLane,
  reorderLane,
  retireLane,
  setSubtaskDone,
  trackLoom,
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

  test("AC1 the traversal guard CONTAINS — a real readable packet outside packets/ is not reachable by id", () => {
    // The test above proves "not a 500" and NOT containment: with the guard
    // deleted entirely, every id there still resolves to a path that does not
    // exist, so it returns null anyway and the suite stays green. This plants a
    // VALID packet at a path a traversal id would reach, so the only way to
    // return null is to refuse the id.
    ensureWorkspace();
    const inside = createItem({ title: "the real one" });
    const escaped = path.join(HOME, "workspace", "escaped");
    fs.mkdirSync(escaped, { recursive: true });
    fs.writeFileSync(
      path.join(escaped, "packet.yaml"),
      YAML.stringify({ ...getWorkspaceItem(inside.id), id: "escaped", title: "OUTSIDE packets/" }),
    );
    // The plant is genuinely readable — otherwise this proves nothing.
    expect(YAML.parse(fs.readFileSync(path.join(escaped, "packet.yaml"), "utf8")).title).toBe(
      "OUTSIDE packets/",
    );
    const outsideBefore = hashOf(path.join(escaped, "packet.yaml"));

    expect(getWorkspaceItem("../escaped")).toBeNull();
    expect(readPacketAttachments("../escaped")).toEqual([]);
    // …and the WRITE direction is contained too: the same id reaches no file.
    expect(updateItem("../escaped", { title: "clobbered" })).toBeNull();
    expect(hashOf(path.join(escaped, "packet.yaml"))).toBe(outsideBefore);
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

  test("AC4 the survival goes ALL THE WAY DOWN — a hand-added key INSIDE `deadline` survives too", () => {
    // The claim was true one level deep and false everywhere else, which is the
    // worst of the three states because it looks like the good one: `Item` was
    // loose while every shape it nests was strict, so a key hand-added under
    // `deadline:` was DESTROYED by the next updateItem while a top-level one
    // survived. Nested user text is exactly what AD-7's version field protects.
    ensureWorkspace();
    const item = createItem({ title: "with a deadline" });
    updateItem(item.id, { deadline: { label: "Fri", kind: "self" } });
    const onDisk = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      packetPath(item.id),
      YAML.stringify({
        ...onDisk,
        deadline: { label: "Fri", kind: "self", userNote: "the one I keep sliding" },
        timeline: [{ ...(onDisk.timeline as Record<string, unknown>[])[0]!, mood: "resigned" }],
      }),
    );

    updateItem(item.id, { title: "renamed again" });

    const after = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8")) as Record<string, unknown>;
    expect((after.deadline as Record<string, unknown>).userNote).toBe("the one I keep sliding");
    expect((after.timeline as Record<string, unknown>[])[0]!.mood).toBe("resigned");
    expect(after.title).toBe("renamed again");
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

  test("D9 a lane move writes BOTH files — the packet AND lanes.yaml", () => {
    // THE ARM THIS STORE SHIPPED WITHOUT, and its absence was not cosmetic:
    // updateItem wrote only the packet, so `mcp__workspace__update_item({lane})`
    // returned success while lanes.yaml — which OWNS membership — was
    // byte-identical and every read kept reporting the old lane.
    ensureWorkspace();
    writeLanes([lane("office", []), lane("free", [])]);
    const item = createItem({ title: "moved by a tool", lane: "office" });
    const lanesBefore = hashOf(lanesPath());
    const packetBefore = hashOf(packetPath(item.id));

    updateItem(item.id, { lane: "free" });

    // Both halves moved, and the STORED stacks say so — not just the projection.
    expect(hashOf(lanesPath())).not.toBe(lanesBefore);
    expect(hashOf(packetPath(item.id))).not.toBe(packetBefore);
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([]);
    expect(readLanes().find((l) => l.key === "free")!.items).toEqual([item.id]);
    expect(getWorkspaceItem(item.id)!.lane).toBe("free");
    expect(rankOf(readLanes(), item.id)).toBe(1);

    // …and exactly ONE row, in the new lane: removed from the old stack rather
    // than copied into the new one.
    const rows = queueSlice(readLanes(), listItems().items);
    expect(rows.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["free", 1, item.id]]);
  });

  test("D9 the lanes write is DISCRIMINATING — a patch that names no lane leaves lanes.yaml byte-identical", () => {
    // The other direction, so the arm above pins a lane MOVE rather than an
    // unconditional writeLanes on every update. Without this, a store that
    // rewrote lanes.yaml on every patch would pass the test above.
    ensureWorkspace();
    writeLanes([lane("office", []), lane("free", [])]);
    const item = createItem({ title: "retitled only", lane: "office" });
    const before = hashOf(lanesPath());

    updateItem(item.id, { title: "a new title", desk: false });

    expect(hashOf(lanesPath())).toBe(before);
    expect(getWorkspaceItem(item.id)!.title).toBe("a new title");

    // …and a "move" to the lane the item is ALREADY in writes nothing either,
    // because removing and re-appending would silently send it to the BOTTOM of
    // its own lane — a queue-position change nobody asked for.
    const sibling = createItem({ title: "below it", lane: "office" });
    const twoDeep = hashOf(lanesPath());
    expect(rankOf(readLanes(), item.id)).toBe(1);
    updateItem(item.id, { lane: "office" });
    expect(hashOf(lanesPath())).toBe(twoDeep);
    expect(rankOf(readLanes(), item.id)).toBe(1);
    expect(rankOf(readLanes(), sibling.id)).toBe(2);
  });

  test("D9 a move to a lane that does not exist creates no lane, and does NOT evict the item", () => {
    // update_item's missing half of create_item's guard — but NOT create's
    // resolution. A create has no home, so an unknown key has to land somewhere.
    // An update HAS a home: redirecting a typo'd laneKey into the seed lane
    // would throw a filed item out of the user's queue on a model's spelling
    // mistake, and with the seed lane retired it would land in NO stack, visible
    // in no queue, on no desk and in no report. It stays put and asks.
    ensureWorkspace();
    writeLanes([lane("unfiled", []), lane("office", [])]);
    const item = createItem({ title: "filed properly", lane: "office" });
    const lanesBefore = hashOf(lanesPath());

    const moved = updateItem(item.id, { lane: "school" })!;

    expect(moved.lane).toBe("office"); // where it actually is, not where it was asked to go
    expect(moved.unplaced).toBe(true); // …and the user is asked
    expect(readLanes().map((l) => l.key)).toEqual(["unfiled", "office"]); // no `school`
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([item.id]);
    expect(rankOf(readLanes(), item.id)).toBe(1); // its queue position survived
    expect(hashOf(lanesPath())).toBe(lanesBefore); // lanes.yaml untouched
  });

  test("D9 with the seed lane RETIRED, a typo'd lane key still does not make the item vanish", () => {
    // The sharpest form of the same defect: with nowhere to redirect to, an
    // evicting update leaves the item in no stack at all — no queue row, no desk
    // card, and NOTHING in the unreadable channel naming it. A real item, gone,
    // with zero diagnostics.
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const item = createItem({ title: "must not vanish", lane: "office" });

    updateItem(item.id, { lane: "ofice" }); // the typo

    expect(rankOf(readLanes(), item.id)).toBe(1);
    expect(queueSlice(readLanes(), listItems().items).map((r) => [r.lane, r.item.id])).toEqual([
      ["office", item.id],
    ]);
    expect(deskSlice(listItems().items).map((d) => d.id)).toEqual([item.id]);
  });

  test("D9 a SUCCESSFUL move clears `unplaced` — the desk stops asking a question that was answered", () => {
    // The failure direction sets the flag; without the success direction
    // clearing it, an item filed into a real lane keeps rendering "unplaced —
    // what is it?" forever, and deskSlice's hint chain puts unplaced FIRST, so
    // it masks the item's deadline too.
    ensureWorkspace();
    writeLanes([lane("unfiled", []), lane("office", [])]);
    const typo = createItem({ title: "typo lane", lane: "ofice" });
    expect(typo.unplaced).toBe(true);

    const placed = updateItem(typo.id, { lane: "office" })!;

    expect(placed.lane).toBe("office");
    expect(placed.unplaced).toBe(false);
    expect(rankOf(readLanes(), typo.id)).toBe(1);
    expect(deskSlice(listItems().items)[0]!.hint).toBeUndefined();
    // …and a caller that explicitly asks for unplaced in the SAME patch wins.
    expect(updateItem(typo.id, { lane: "office", unplaced: true })!.unplaced).toBe(true);
  });

  test("D9 a duplicated id elsewhere does not re-rank the item on a no-op move to its own lane", () => {
    // The "already in the target" guard has to look at the TARGET stack, not at
    // whichever stack holds the id first. A hand-edited paste that also lists the
    // id in an earlier lane would otherwise make a no-op move remove and
    // re-append it — sending the user's rank-2 item to the bottom.
    ensureWorkspace();
    const top = createItem({ title: "top" });
    const middle = createItem({ title: "middle" });
    const bottom = createItem({ title: "bottom" });
    writeLanes([lane("school", [middle.id]), lane("office", [top.id, middle.id, bottom.id])]);
    const before = hashOf(lanesPath());

    updateItem(middle.id, { lane: "office" });

    // Kept its position in the target…
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([top.id, middle.id, bottom.id]);
    // …and the stray duplicate was cleaned out of the other stack, which is the
    // one thing this call SHOULD change.
    expect(readLanes().find((l) => l.key === "school")!.items).toEqual([]);
    expect(hashOf(lanesPath())).not.toBe(before);
    expect(rankOf(readLanes(), middle.id)).toBe(2);
  });

  test("D9 a WRITE preserves a lane row this build could not read — tolerance is not a delayed delete", () => {
    // The trap in per-row tolerance: a partial READ written back is a partial
    // DELETE. createItem and updateItem rewrite the whole file, so writing the
    // parsed subset would erase the skipped row and every item id in it on the
    // very next capture — silently, and the unreadable channel would then go
    // quiet because there is nothing left to report.
    ensureWorkspace();
    const held = createItem({ title: "inside the broken row" });
    fs.writeFileSync(
      lanesPath(),
      YAML.stringify([
        { key: "office", label: "Office", window: "work hours", items: [] },
        { key: "school", label: "School", items: [held.id], note: "the human dropped `window:`" },
        { key: "free", label: "Free", window: "whenever", items: [] },
      ]),
    );
    expect(readLanes().map((l) => l.key)).toEqual(["office", "free"]);

    createItem({ title: "an ordinary capture", lane: "free" });

    const onDisk = YAML.parse(fs.readFileSync(lanesPath(), "utf8")) as Record<string, unknown>[];
    expect(onDisk.map((r) => r.key)).toEqual(["office", "school", "free"]);
    const school = onDisk.find((r) => r.key === "school")!;
    expect(school.items).toEqual([held.id]); // its ids survived
    expect(school.note).toBe("the human dropped `window:`"); // and every other key
    expect(listItems().unreadable.map((u) => u.id)).toContain("school"); // still reported

    // …and an updateItem write preserves it too.
    updateItem(held.id, { lane: "free" });
    const after = YAML.parse(fs.readFileSync(lanesPath(), "utf8")) as Record<string, unknown>[];
    expect(after.map((r) => r.key)).toEqual(["office", "school", "free"]);
    expect(after.find((r) => r.key === "school")!.note).toBe("the human dropped `window:`");
    // The id was removed from the broken row's stack because that row's `items`
    // is still a readable list — the row keeps every one of its own keys.
    expect(after.find((r) => r.key === "school")!.items).toEqual([]);
    expect(readLanes().find((l) => l.key === "free")!.items).toContain(held.id);
  });

  test("D9 a TORN lane move — packet written, lanes.yaml not — simply did not happen", () => {
    // FAULT-INJECTED, not narrated: the packet is rewritten ON DISK exactly as a
    // crash between updateItem's two writes would leave it, and lanes.yaml is
    // left untouched. (The previous version of this test called updateItem and
    // labelled the result "simulating a crash" — nothing was simulated, because
    // updateItem could not write lanes.yaml at all, so the assertion held for
    // the defect rather than for the safety property.)
    ensureWorkspace();
    writeLanes([lane("office", []), lane("free", [])]);
    const item = createItem({ title: "mid-move", lane: "office" });
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([item.id]);
    const lanesBefore = hashOf(lanesPath());

    // The torn state: packet.lane says `free`, the id is still in `office`.
    fs.writeFileSync(packetPath(item.id), YAML.stringify({ ...getWorkspaceItem(item.id), lane: "free" }));
    expect(getWorkspaceItem(item.id)!.lane).toBe("free");
    expect(hashOf(lanesPath())).toBe(lanesBefore);

    // lanes.yaml is authoritative, so the move did not happen: the id is still
    // in its OLD stack and the orphan arm does not fire.
    const rows = queueSlice(readLanes(), listItems().items);
    expect(rows.map((r) => [r.lane, r.item.id])).toEqual([["office", item.id]]);
    expect(rows.length).toBe(1); // exactly one row: no duplicate

    // …and the recovery is a re-run of the same call, not a repair tool.
    updateItem(item.id, { lane: "free" });
    expect(queueSlice(readLanes(), listItems().items).map((r) => [r.lane, r.item.id])).toEqual([
      ["free", item.id],
    ]);
  });

  test("D9 a DUPLICATE lane key does not make the store write the same id into two stacks", () => {
    // A hand-edited paste leaves two rows keyed `office`. Appending to every
    // matching row would have the store MANUFACTURING the exact duplicate-id
    // fault arm 4 then reports and blames on the human.
    ensureWorkspace();
    writeLanes([lane("office", []), lane("office", [])]);
    const item = createItem({ title: "into a duplicated key", lane: "office" });

    const stacks = readLanes().map((l) => l.items);
    expect(stacks).toEqual([[item.id], []]);
    expect(listItems().unreadable.filter((u) => u.reason.includes("more than one lane"))).toEqual([]);
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

// ── assertPacketAddressMatches — shared by EVERY writer that resolves a
//    packet by id first (updateItem, and 5.2's addSubtask/setSubtaskDone/
//    promoteSubtask), and untested against any of them before this fix round
//    (found by the adversarial mutation-test pass: commenting out any one of
//    the four call sites left the suite fully green). AD-6 invites a human to
//    hand-edit packet.yaml, so a directory whose own `id:` line no longer
//    matches the directory it sits in is a state the store WILL see; each
//    writer below has to refuse it rather than clobber whatever item that
//    `id:` line actually names. ────────────────────────────────────────────

describe("AD-6 address-mismatch guard — every writer that resolves a packet by id refuses a hand-edited id: mismatch", () => {
  // Creates a real item at `id`, then hand-rewrites its own packet.yaml to
  // claim a DIFFERENT id — the exact shape assertPacketAddressMatches exists
  // to catch, and the only way to construct it: no writer in this store can
  // produce the mismatch itself (every legitimate write stamps id from the
  // directory it is already writing to).
  function createWithMismatchedId(): { dirId: string; claimedId: string } {
    const item = createItem({ title: "will be hand-edited" });
    const other = createItem({ title: "the id it will falsely claim" });
    const before = hashOf(packetPath(other.id)); // the OTHER item, never touched
    fs.writeFileSync(packetPath(item.id), YAML.stringify({ ...item, id: other.id }));
    expect(hashOf(packetPath(other.id))).toBe(before); // sanity: only item.id's own file was touched
    return { dirId: item.id, claimedId: other.id };
  }

  test("updateItem throws and writes nothing, naming both the directory and the claimed id", () => {
    const { dirId, claimedId } = createWithMismatchedId();
    const before = hashOf(packetPath(dirId));
    expect(() => updateItem(dirId, { title: "clobber attempt" })).toThrow(
      new RegExp(`${dirId}.*${claimedId}|${claimedId}.*${dirId}`, "s"),
    );
    expect(hashOf(packetPath(dirId))).toBe(before); // nothing written
  });

  test("addSubtask throws and writes nothing", () => {
    const { dirId } = createWithMismatchedId();
    const before = hashOf(packetPath(dirId));
    expect(() => addSubtask(dirId, "a sub-task")).toThrow(/directory it sits in/);
    expect(hashOf(packetPath(dirId))).toBe(before);
  });

  test("setSubtaskDone throws and writes nothing", () => {
    const { dirId } = createWithMismatchedId();
    const before = hashOf(packetPath(dirId));
    // The subtask id does not need to exist — the address check runs first,
    // before the subtask lookup, so this proves the GUARD fires rather than
    // merely proving the not-found path does.
    expect(() => setSubtaskDone(dirId, "st-doesnotexist", true)).toThrow(/directory it sits in/);
    expect(hashOf(packetPath(dirId))).toBe(before);
  });

  test("promoteSubtask throws and writes NEITHER the parent NOR any new promoted packet", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const parent = createItem({ title: "parent", lane: "office" });
    const withSub = addSubtask(parent.id, "a sub-task")!;
    const other = createItem({ title: "the id it will falsely claim" });
    fs.writeFileSync(packetPath(parent.id), YAML.stringify({ ...withSub, id: other.id }));
    const before = hashOf(packetPath(parent.id));
    const packetsBefore = fs.readdirSync(path.join(HOME, "workspace", "packets")).sort();
    expect(() => promoteSubtask(parent.id, withSub.subtasks![0]!.id)).toThrow(/directory it sits in/);
    expect(hashOf(packetPath(parent.id))).toBe(before);
    // No third packet directory was minted for a promoted item that never happened.
    expect(fs.readdirSync(path.join(HOME, "workspace", "packets")).sort()).toEqual(packetsBefore);
  });
});

// ── AD-7 — lanes.yaml is read PER ROW, because AD-6 invites the hand-edit ────

describe("AD-7 one malformed lane row does not discard the file", () => {
  const brokenLanes = (rows: unknown[]) => fs.writeFileSync(lanesPath(), YAML.stringify(rows));

  test("AD-7 a row missing `window:` is SKIPPED and every other lane survives", () => {
    // The all-or-nothing read this store shipped with returned `[]` here: the
    // user's ENTIRE lane structure vanished from every read because one row of
    // five was imperfect, and the next create_item then filed into no stack at
    // all. Hand-editability is the premise (AD-6), so an imperfect hand-edit
    // cannot cost the whole file.
    ensureWorkspace();
    const item = createItem({ title: "already filed" });
    brokenLanes([
      { key: "office", label: "Office", window: "work hours", items: [item.id] },
      { key: "school", label: "School", items: [] }, // the human dropped `window:`
      { key: "free", label: "Free", window: "whenever", items: [] },
    ]);

    expect(readLanes().map((l) => l.key)).toEqual(["office", "free"]);
    expect(rankOf(readLanes(), item.id)).toBe(1);
    // …and a create still files into a real lane rather than accumulating unfiled.
    const next = createItem({ title: "filed after the bad edit", lane: "free" });
    expect(next.unplaced).toBeUndefined();
    expect(readLanes().find((l) => l.key === "free")!.items).toEqual([next.id]);
  });

  test("AD-7 the skipped row is REPORTED by name, so tolerance is not silent loss", () => {
    // Without the report, "tolerant" and "silently lossy" are the same thing
    // from the user's side: a lane would simply stop existing.
    ensureWorkspace();
    brokenLanes([
      { key: "office", label: "Office", window: "work hours", items: [] },
      { key: "school", label: "School", items: [] },
    ]);
    const reported = listItems().unreadable;
    expect(reported.map((u) => u.id)).toEqual(["school"]);
    expect(reported[0]!.reason).toContain("lanes.yaml");
    expect(reported[0]!.reason).toContain("window");
    expect(reported[0]!.reason).toContain("SKIPPED");
    // Nothing was rewritten to "fix" it — the human's file is theirs.
    expect(YAML.parse(fs.readFileSync(lanesPath(), "utf8")).length).toBe(2);
  });

  test("AD-7 a row with no readable key at all is reported by its POSITION", () => {
    ensureWorkspace();
    brokenLanes([{ key: "office", label: "Office", window: "work hours", items: [] }, "not a mapping"]);
    expect(readLanes().map((l) => l.key)).toEqual(["office"]);
    expect(listItems().unreadable.map((u) => u.id)).toEqual(["lanes.yaml[1]"]);
  });

  test("AD-7 a WHOLE-FILE fault is still [] — and says so, rather than returning half a structure", () => {
    // The per-row tolerance above must not turn a file that is not a lane list
    // into a partially-read one. Both whole-file faults report; neither throws.
    ensureWorkspace();
    fs.writeFileSync(lanesPath(), "{{{ not yaml at all ][");
    expect(readLanes()).toEqual([]);
    expect(listItems().unreadable.map((u) => u.id)).toEqual(["lanes.yaml"]);

    fs.writeFileSync(lanesPath(), YAML.stringify({ office: ["i-1"] })); // a mapping, not a sequence
    expect(readLanes()).toEqual([]);
    expect(listItems().unreadable[0]!.reason).toContain("must be a YAML sequence");

    // An EMPTY file is the ordinary first-run state, not a fault.
    fs.writeFileSync(lanesPath(), "");
    expect(readLanes()).toEqual([]);
    expect(listItems().unreadable).toEqual([]);
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

  test("AC8 proof 4 with the seed lane RETIRED, a create writes the item and creates NO lane at all", () => {
    // The arm with no test: `createItem`'s "no lane is created to receive it".
    // A lane-creating `else` branch — the natural-looking fix for an item that
    // lands nowhere — is exactly the agent lane-structure change NFR-OW-10
    // forbids, and it left the whole suite green.
    ensureWorkspace();
    writeLanes([]); // the human retired every lane, seed included
    const item = createItem({ title: "nowhere to land", lane: "office" });

    expect(readLanes()).toEqual([]); // NOTHING was created — not `office`, not `unfiled`
    expect(fs.readFileSync(lanesPath(), "utf8").includes("office")).toBe(false);
    // The item itself still exists and is readable; it is UNFILED, a resting
    // state, and it is on the desk so the human is asked.
    expect(getWorkspaceItem(item.id)!.title).toBe("nowhere to land");
    expect(rankOf(readLanes(), item.id)).toBeNull();
    expect(queueSlice(readLanes(), listItems().items)).toEqual([]);
    expect(deskSlice(listItems().items).map((d) => d.id)).toEqual([item.id]);
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
    // SIX SEQUENTIAL tsc SPAWNS, measured at ~4.85s against bun's 5000ms
    // default — a 3% margin, so any concurrent load would turn the whole AC9
    // gate red for a reason that has nothing to do with the code. The timeout is
    // raised rather than the loop split, so the six stay one claim.
  }, 60_000);

  test("AC9 the compile proof DISCRIMINATES — a patch of a PERMITTED field compiles clean", () => {
    // Without this half, a fixture failing to compile for any reason at all (a
    // bad path, a renamed export) would read as a passing AC9.
    const r = typecheck(`const patch: ItemPatch = { title: "fine", desk: false, lane: "office" };\nvoid patch;`);
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
    // ONE tsc SPAWN, and it still crossed bun's 5 s default on the loaded CI
    // Mac mini (#458 names this test by name). Same explicit budget as the six
    // spawns above rather than the suite's 20 s ceiling: a cold compiler is the
    // slowest thing this file does, and its budget should say so out loud.
  }, 60_000);

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

  test("A5 deskSlice emits {id,title,project?,mirrored?,deadline?,hint?,unplaced?} from ITEM FIELDS ALONE", () => {
    // FIELDS, NOT SENTENCES (5.7's review). The deadline and the mirrored ref
    // used to be flattened into one prose `hint`, which stranded the Desk
    // outside the frozen chip grammar: a self-deadline cannot render dashed
    // with `· self`/`· slid ×N`, and a mirrored item cannot render its
    // dot-icon ref, if the projection has already turned both into a string.
    const cards = deskSlice([
      item({ id: "i-1", title: "Remove CSV export button", project: "aurora", desk: true, deadline: { label: "Fri", kind: "external" } }),
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

  test("A5 attachmentTally counts siblings and excludes packet.yaml", () => {
    expect(attachmentTally([])).toEqual({ files: 0, mockups: 0 });
    expect(attachmentTally(["packet.yaml"])).toEqual({ files: 0, mockups: 0 });
    expect(attachmentTally(["packet.yaml", "brief.md", "notes.txt", "flow.png", "wire.SVG"])).toEqual({
      files: 2,
      mockups: 2,
    });
  });

  test("A5 a stray FILE in packets/ is not an item, and is not reported as a corrupt one", () => {
    // An item is a DIRECTORY. A `.DS_Store`, a `.tmp` from an interrupted write,
    // or a note someone dropped in packets/ used to reach packetFile(), throw on
    // the id guard, and be handed to the model as an unreadable ITEM — telling
    // the user one of their tasks was corrupt when nothing of theirs was
    // involved.
    ensureWorkspace();
    const real = createItem({ title: "a real one" });
    fs.writeFileSync(path.join(HOME, "workspace", "packets", ".DS_Store"), "finder");
    fs.writeFileSync(path.join(HOME, "workspace", "packets", "stray-note.md"), "# dropped here");

    const { items, unreadable } = listItems();
    expect(items.map((i) => i.id)).toEqual([real.id]);
    expect(unreadable).toEqual([]);
  });

  test("A5 the tally excludes THIS STORE'S OWN crash residue and the OS's, not just packet.yaml", () => {
    // atomicWrite writes `<file>.tmp` then renames; a crash between the two
    // leaves the .tmp behind, and reporting it as "1 file" tells the user they
    // attached something when what actually happened is that a write of THEIRS
    // failed. `.DS_Store` is Finder's, from opening the directory once.
    expect(attachmentTally(["packet.yaml.tmp", ".DS_Store"])).toEqual({ files: 0, mockups: 0 });
    expect(attachmentTally(["brief.md", "packet.yaml.tmp", ".DS_Store", "flow.png"])).toEqual({
      files: 1,
      mockups: 1,
    });

    // …and the disk reader agrees, so the exclusion is not only true of the pure
    // half. Both are planted as REAL files beside a real packet.
    ensureWorkspace();
    const item = createItem({ title: "with residue beside it" });
    fs.writeFileSync(path.join(packetDirOf(item.id), "packet.yaml.tmp"), "half a write");
    fs.writeFileSync(path.join(packetDirOf(item.id), ".DS_Store"), "finder");
    fs.writeFileSync(path.join(packetDirOf(item.id), "brief.md"), "# real");
    expect(readPacketAttachments(item.id)).toEqual(["brief.md"]);
    expect(attachmentTally(readPacketAttachments(item.id))).toEqual({ files: 1, mockups: 0 });
  });

  test("A5 capturedLabel's VALUE is asserted, not just its presence", () => {
    // Scrambling the weekday table or swapping HH:MM left the whole suite green,
    // because every assertion on `captured` only checked that a string was
    // there. The label is what the UI renders, so its FORM is the contract:
    // "<Www> <HH>:<MM>", zero-padded, and the weekday must be the one the clock
    // says. Derived from the SAME instant, so this cannot go stale at midnight.
    ensureWorkspace();
    const before = new Date();
    const item = createItem({ title: "stamped" });
    const after = new Date();
    const expected = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    expect(item.captured).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [0-2][0-9]:[0-5][0-9]$/);
    const [day, clock] = item.captured.split(" ");
    // The weekday is the RIGHT one — a scrambled table names a different day
    // (except across a midnight boundary, which is why both ends are accepted).
    expect([expected[before.getDay()], expected[after.getDay()]]).toContain(day);
    const [hh, mm] = clock!.split(":").map(Number);
    expect(hh).toBe(before.getHours() === after.getHours() ? before.getHours() : hh);
    expect([before.getMinutes(), after.getMinutes()]).toContain(mm);
    // …and the ORDER is HH then MM, which a swap would break: minutes cannot
    // exceed 59 and hours cannot exceed 23.
    expect(hh).toBeLessThanOrEqual(23);
    expect(mm).toBeLessThanOrEqual(59);
    // The timeline entry carries the SAME label — one clock read, not two.
    expect(item.timeline![0]!.at).toBe(item.captured);
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

// ── story 5.2 — lane structure (NFR-OW-10: human-only, and none of these four
//    functions is reachable from an MCP tool — see their block comment) ──────

describe("5.2 createLane mints a key, dedupes it, and never disturbs another row", () => {
  test("createLane mints a slug from the label and appends an empty stack", () => {
    ensureWorkspace(); // seeds the "unfiled" row — createLane must not disturb it
    const made = createLane({ label: "Evenings & Weekends", window: "after 6pm" });
    expect(made).toEqual({ key: "evenings-weekends", label: "Evenings & Weekends", window: "after 6pm", items: [] });
    expect(readLanes().map((l) => l.key)).toEqual(["unfiled", "evenings-weekends"]);
    expect(readLanes()[1]).toEqual(made);
  });

  test("createLane dedupes a key collision by suffix, and reads existing keys off the RAW rows, not just the parsed ones", () => {
    ensureWorkspace();
    // A malformed row (no `window:`) still claims the key "office" — createLane
    // must not mint a second "office" just because that row cannot be parsed.
    fs.writeFileSync(
      lanesPath(),
      YAML.stringify([
        { key: "office", label: "Office", window: "work hours", items: [] },
        { key: "office-2", label: "Office (old)", items: [] }, // missing window: — unreadable
      ]),
    );
    const made = createLane({ label: "Office", window: "work hours" });
    expect(made.key).toBe("office-3");
    // Both prior rows, including the unreadable one, survive byte-for-byte.
    expect(YAML.parse(fs.readFileSync(lanesPath(), "utf8"))).toEqual([
      { key: "office", label: "Office", window: "work hours", items: [] },
      { key: "office-2", label: "Office (old)", items: [] },
      { key: "office-3", label: "Office", window: "work hours", items: [] },
    ]);
  });

  test("createLane appends after every existing row, including one this build cannot parse, and rewrites none of them", () => {
    ensureWorkspace();
    const item = createItem({ title: "already filed", lane: "unfiled" });
    const before = hashOf(packetPath(item.id));
    fs.writeFileSync(
      lanesPath(),
      YAML.stringify([{ key: "unfiled", label: "Unfiled", window: "n/a", items: [item.id] }, "not a mapping"]),
    );
    createLane({ label: "Free", window: "whenever", note: "split from Office" });
    const rows = YAML.parse(fs.readFileSync(lanesPath(), "utf8"));
    expect(rows).toEqual([
      { key: "unfiled", label: "Unfiled", window: "n/a", items: [item.id] },
      "not a mapping",
      { key: "free", label: "Free", window: "whenever", note: "split from Office", items: [] },
    ]);
    expect(hashOf(packetPath(item.id))).toBe(before); // no packet touched by a lane-only write
  });
});

describe("5.2 renameLane rewrites `label` ONLY — the key never moves once a lane exists", () => {
  test("renameLane changes the label and leaves the key, window, items and unknown hand-added keys untouched", () => {
    ensureWorkspace();
    fs.writeFileSync(
      lanesPath(),
      YAML.stringify([{ key: "office", label: "Office", window: "work hours", items: ["i-a"], color: "blue" }]),
    );
    const renamed = renameLane("office", "Day Job");
    expect(renamed).toEqual({ key: "office", label: "Day Job", window: "work hours", items: ["i-a"] });
    expect(YAML.parse(fs.readFileSync(lanesPath(), "utf8"))).toEqual([
      { key: "office", label: "Day Job", window: "work hours", items: ["i-a"], color: "blue" },
    ]);
  });

  test("renameLane on an unknown key writes nothing and returns null — the seed-lane-rename hazard, closed: the KEY that resolveLane falls back to can never move under existing data", () => {
    ensureWorkspace();
    writeLanes([lane("unfiled", ["i-a"])]);
    const before = fs.readFileSync(lanesPath(), "utf8");
    expect(renameLane("does-not-exist", "New Label")).toBeNull();
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before);
    // …and renaming the SEED lane's label still routes an unresolvable-lane
    // create to the same stored key "unfiled" — renaming a label never touches
    // resolveLane's routing, because there is no function anywhere that can
    // change a `key`.
    renameLane("unfiled", "Everything Else");
    const item = createItem({ title: "unresolvable lane request", lane: "nope-not-a-real-key" });
    expect(item.unplaced).toBe(true); // unknown lane -> seed key fallback, marked unplaced (desk asks)
    expect(readLanes().find((l) => l.key === "unfiled")!.items).toContain(item.id);
  });
});

describe("5.2 retireLane refuses a non-empty stack and never partially applies", () => {
  test("retireLane refuses when the STORED stack is non-empty, and writes nothing", () => {
    ensureWorkspace();
    writeLanes([lane("office", ["i-a", "i-b"])]);
    const before = fs.readFileSync(lanesPath(), "utf8");
    const result = retireLane("office");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("2 items") });
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before);
  });

  test("retireLane refuses even when every id in the stack is an unreadable ghost — a non-empty stored array always counts as non-empty", () => {
    ensureWorkspace();
    // Neither id resolves to a real packet — both are ghosts — but the STORED
    // array still has length 2, and that is the number that decides.
    writeLanes([lane("office", ["i-ghost-1", "i-ghost-2"])]);
    const result = retireLane("office");
    expect(result.ok).toBe(false);
    expect(readLanes().map((l) => l.key)).toEqual(["office"]); // still there
  });

  // Fix-round regression: a row this build cannot parse (AD-7 tolerance) has
  // to be refused, not silently deleted. The sibling test above proves the
  // author was already thinking about "every id in the stack is a ghost";
  // this proves the adjacent, previously-untested case — the ROW ITSELF is
  // unreadable, so there is no parsed `items` array to even ask about. Found
  // by the adversarial mutation-test pass: collapsing this branch into the
  // length check left the suite fully green.
  test("retireLane refuses a row this build cannot parse — its item count cannot be confirmed", () => {
    ensureWorkspace();
    fs.writeFileSync(
      lanesPath(),
      YAML.stringify([{ key: "office", label: "Office", window: "work hours", items: [] }, { key: "school", items: [] }]), // "school" is missing `window:` — unparseable, per AD-7's own broken-row test above
    );
    const before = fs.readFileSync(lanesPath(), "utf8");
    const result = retireLane("school");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("cannot be confirmed") });
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before); // nothing written — not even deleted
    // The row survives exactly as AD-7 promises: still unreadable as a lane, still reported.
    expect(listItems().unreadable.map((u) => u.id)).toEqual(["school"]);
  });

  test("retireLane succeeds when the stored stack is empty, and removes exactly that row", () => {
    ensureWorkspace();
    writeLanes([lane("office", []), lane("free", ["i-a"])]);
    const result = retireLane("office");
    expect(result).toEqual({ ok: true });
    expect(readLanes().map((l) => l.key)).toEqual(["free"]);
  });

  test("retireLane on an unknown key reports failure without touching the file", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const before = fs.readFileSync(lanesPath(), "utf8");
    expect(retireLane("nope").ok).toBe(false);
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before);
  });

  // Fix-round regression: retireLane must refuse "unfiled" even while its
  // stored stack is empty, because it is create_item's only fallback target
  // (resolveLane). Retiring it does not free the key — it strands the next
  // unresolvable capture in a lane that no longer exists, invisible on the
  // queue (queueSlice never adopts an orphan whose `lane` names no row) until
  // a later story gives resolveLane a different fallback.
  test("retireLane refuses the seed lane even when its stored stack is empty", () => {
    ensureWorkspace(); // seeds exactly one row, key "unfiled", empty stack
    const before = fs.readFileSync(lanesPath(), "utf8");
    const result = retireLane("unfiled");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("create_item");
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before); // nothing written
    expect(readLanes().map((l) => l.key)).toEqual(["unfiled"]); // still there

    // And the fallback it protects still resolves: an unresolvable lane on
    // createItem still lands somewhere the queue and desk can both show.
    const item = createItem({ title: "unresolvable lane", lane: "does-not-exist" });
    expect(item.lane).toBe("unfiled");
    expect(item.unplaced).toBe(true);
    expect(readLanes().find((l) => l.key === "unfiled")!.items).toContain(item.id);
  });

  // 5.7 fix-round: the stored stack is not the only way an item is IN a lane.
  // queueSlice's arm 1 adopts an item whose packet names a lane the stored
  // stack has forgotten — it renders under that group header, ranked,
  // indistinguishable from a stacked one. Retiring the row on the strength of
  // an empty `items:` array therefore evicted an item the human could see, and
  // arm 3 gives an item naming no known lane NO ROW AT ALL: it falls off the
  // queue and out of `totalItems` while the desk rail promises, in words, that
  // dismissing a card "sends it here".
  test("retireLane refuses a lane whose stack is empty but whose packets still name it", () => {
    ensureWorkspace();
    writeLanes([lane("unfiled", []), lane("office", [])]);
    const item = createItem({ title: "invoice for aurora", lane: "office" });
    expect(item.lane).toBe("office");
    // The stored stack forgets it — a hand-edited lanes.yaml, a half-applied
    // move, or any of the ways AD-7 tolerates a file it did not write.
    writeLanes([lane("unfiled", []), lane("office", [])]);
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([]);
    // …and the queue still shows it under "office", which is the whole point:
    // arm 1 adopts an orphan whose packet names a real lane.
    const before = fs.readFileSync(lanesPath(), "utf8");
    expect(queueSlice(readLanes(), listItems().items).map((r) => [r.lane, r.item.id])).toEqual([
      ["office", item.id],
    ]);

    const result = retireLane("office");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(item.id);
      expect(result.reason).toContain("never evicts an item on the human's behalf");
    }
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before); // nothing written
    // The item is still where it was, and still on the queue.
    expect(getWorkspaceItem(item.id)!.lane).toBe("office");
    expect(queueSlice(readLanes(), listItems().items)).toHaveLength(1);
  });

  // A lane other than the seed still retires exactly as before — the guard
  // above is scoped to SEED_LANE_KEY alone, not a general "protect empty
  // fallback-shaped lanes" rule.
  test("retireLane still retires an ordinary empty lane named anything but the seed key", () => {
    ensureWorkspace();
    writeLanes([lane("unfiled", []), lane("office", [])]);
    expect(retireLane("office")).toEqual({ ok: true });
    expect(readLanes().map((l) => l.key)).toEqual(["unfiled"]);
  });
});

describe("5.2 reorderLane sets a lane's stack to an exact permutation, and adopts across lanes", () => {
  test("reorderLane within one lane rewrites only that lane's order", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const a = createItem({ title: "a", lane: "office" });
    const b = createItem({ title: "b", lane: "office" });
    const c = createItem({ title: "c", lane: "office" });
    const result = reorderLane("office", [c.id, a.id, b.id]);
    expect(result.items).toEqual([c.id, a.id, b.id]);
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([c.id, a.id, b.id]);
  });

  test("reorderLane adopts an id out of a DIFFERENT lane's stored stack — one call serves both an in-lane reorder and a cross-lane move", () => {
    ensureWorkspace();
    writeLanes([lane("office", []), lane("free", [])]);
    const a = createItem({ title: "a", lane: "office" });
    const b = createItem({ title: "b", lane: "free" });
    reorderLane("office", [a.id, b.id]);
    const lanes = readLanes();
    expect(lanes.find((l) => l.key === "office")!.items).toEqual([a.id, b.id]);
    expect(lanes.find((l) => l.key === "free")!.items).toEqual([]); // evicted from its old row
    // packet.lane is left as the stale hint — lanes.yaml alone decided this,
    // exactly like AD-6's hand cross-lane move.
    expect(getWorkspaceItem(b.id)!.lane).toBe("free");
  });

  test("reorderLane throws and writes NOTHING when an id does not resolve to a readable packet", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const a = createItem({ title: "a", lane: "office" });
    const before = fs.readFileSync(lanesPath(), "utf8");
    expect(() => reorderLane("office", [a.id, "i-does-not-exist"])).toThrow(/does not resolve/);
    expect(fs.readFileSync(lanesPath(), "utf8")).toBe(before);
  });

  test("reorderLane throws on an unknown lane key", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    expect(() => reorderLane("nope", [])).toThrow(/No lane named/);
  });
});

describe("5.2 sub-tasks live INSIDE the item — NFR-OW-3's conservation law holds under the real disk writers too", () => {
  test("addSubtask appends with a minted id, touches no lanes.yaml, and never changes queueSlice's row count", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const item = createItem({ title: "decompose me", lane: "office" });
    const lanesHash = hashOf(lanesPath());
    const before = queueSlice(readLanes(), listItems().items).length;

    const next = addSubtask(item.id, "first step");
    expect(next!.subtasks).toEqual([{ id: expect.any(String), title: "first step", done: false }]);
    expect(next!.subtasks![0]!.id).toMatch(/^st-/); // distinct prefix from an item id
    expect(hashOf(lanesPath())).toBe(lanesHash); // lanes.yaml untouched

    addSubtask(item.id, "second step");
    const after = queueSlice(readLanes(), listItems().items).length;
    expect(after).toBe(before); // the count NEVER grows from breakdown
    expect(getWorkspaceItem(item.id)!.subtasks!.map((s) => s.title)).toEqual(["first step", "second step"]);
  });

  test("addSubtask returns null and writes nothing for an id that does not resolve", () => {
    ensureWorkspace();
    expect(addSubtask("i-does-not-exist", "x")).toBeNull();
  });

  test("setSubtaskDone toggles exactly the named sub-task, in both directions, and leaves its siblings alone", () => {
    ensureWorkspace();
    const item = createItem({ title: "with steps" });
    addSubtask(item.id, "one");
    addSubtask(item.id, "two");
    const [st1, st2] = getWorkspaceItem(item.id)!.subtasks!;

    const marked = setSubtaskDone(item.id, st1!.id, true);
    expect(marked!.subtasks).toEqual([
      { id: st1!.id, title: "one", done: true },
      { id: st2!.id, title: "two", done: false },
    ]);

    const unmarked = setSubtaskDone(item.id, st1!.id, false);
    expect(unmarked!.subtasks![0]!.done).toBe(false);
  });

  test("setSubtaskDone returns null for an unknown sub-task id, and writes nothing", () => {
    ensureWorkspace();
    const item = createItem({ title: "with steps" });
    addSubtask(item.id, "one");
    const before = hashOf(packetPath(item.id));
    expect(setSubtaskDone(item.id, "st-not-real", true)).toBeNull();
    expect(hashOf(packetPath(item.id))).toBe(before);
  });
});

describe("5.2 promoteSubtask — the ONLY promotion path in the codebase, and it is never reachable from an MCP tool", () => {
  test("promoteSubtask mints a real item, removes the sub-task from the parent, lands at the BOTTOM of the parent's ACTUAL stack, and stamps actor \"you\"", () => {
    ensureWorkspace();
    writeLanes([lane("office", [])]);
    const parent = createItem({ title: "parent", lane: "office", project: "aurora" });
    addSubtask(parent.id, "spin this out");
    const sibling = createItem({ title: "already in office", lane: "office" });
    const [sub] = getWorkspaceItem(parent.id)!.subtasks!;

    const result = promoteSubtask(parent.id, sub!.id);
    expect(result).not.toBeNull();
    const { parent: nextParent, promoted } = result!;

    expect(nextParent.subtasks).toEqual([]);
    expect(promoted.title).toBe("spin this out");
    expect(promoted.promotedFrom).toBe(parent.id);
    expect(promoted.project).toBe("aurora"); // inherits the parent's project
    expect(promoted.provenance).toContain(parent.title);
    // NOT built like create_item's output — a human click is neither "the
    // master asking a question" nor a session filing something.
    expect(promoted.desk).toBeUndefined();
    expect(promoted.unplaced).toBeUndefined();
    expect(promoted.timeline).toEqual([{ at: promoted.captured, actor: "you", text: expect.stringContaining(parent.title) }]);

    // Lands at the BOTTOM of the parent's real stack — after the sibling that
    // was already there, not wherever parent.lane's stale hint would imply.
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([parent.id, sibling.id, promoted.id]);
    expect(getWorkspaceItem(parent.id)!.subtasks).toEqual([]);
  });

  test("promoteSubtask leaves the promoted sibling unfiled — not desk, not adopted into a lane nobody chose — when the parent itself has no stack", () => {
    ensureWorkspace();
    const parent = createItem({ title: "homeless parent" });
    addSubtask(parent.id, "spin this out too");
    // Hand-edit: wipe every lane row, so the parent is in no stack at all —
    // arm 3, "lane gone" — the same resting state a retired lane leaves behind.
    writeLanes([]);
    const [sub] = getWorkspaceItem(parent.id)!.subtasks!;

    const { promoted } = promoteSubtask(parent.id, sub!.id)!;
    expect(promoted.desk).toBeUndefined();
    expect(promoted.unplaced).toBeUndefined();
    expect(readLanes()).toEqual([]); // no lane row exists to receive it, and none was created
    expect(queueSlice(readLanes(), listItems().items).map((r) => r.item.id)).not.toContain(promoted.id);
  });

  test("promoteSubtask returns null, and writes nothing, for an unknown parent or an unknown sub-task id", () => {
    ensureWorkspace();
    expect(promoteSubtask("i-does-not-exist", "st-1")).toBeNull();
    const parent = createItem({ title: "parent" });
    const before = hashOf(packetPath(parent.id));
    expect(promoteSubtask(parent.id, "st-not-real")).toBeNull();
    expect(hashOf(packetPath(parent.id))).toBe(before);
  });
});

describe("5.2 agentsAddedCount — the queue footer's \"agents added N\"", () => {
  test("agentsAddedCount is zero over a fresh workspace, and becomes one after an agent files through create_item", () => {
    ensureWorkspace();
    expect(agentsAddedCount(listItems().items)).toBe(0);
    createItem({ title: "filed by a session" }); // stamps provenance: "session" server-side
    expect(agentsAddedCount(listItems().items)).toBe(1);
  });

  test("agentsAddedCount does not count an item with a different provenance, even a human-authored one that happens to mention a session", () => {
    const item = Item.parse({ id: "i-x", title: "x", provenance: "pasted transcript", captured: "Tue 16:42" });
    expect(agentsAddedCount([item])).toBe(0);
  });
});

// ── 5.5 the weave stamp — CAP-11's "the row stays in the queue" ──────────────
//
// The whole point of this group is what trackLoom does NOT do. Two of the four
// arms below assert a file was not rewritten (lanes.yaml) rather than that a
// field was written, because "the rows leave at weave time" is the failure this
// store has to make impossible, not merely avoid today.

describe("5.5 trackLoom — the only writer of Item.tracking", () => {
  test("stamps every member's packet and leaves lanes.yaml BYTE-IDENTICAL — the rows stay in the queue", () => {
    ensureWorkspace();
    createLane({ label: "Office", window: "work hours" });
    const a = createItem({ title: "exports: csv", lane: "office" });
    const b = createItem({ title: "exports: pdf", lane: "office" });
    const untouched = createItem({ title: "not in the batch", lane: "office" });
    const lanesBefore = hashOf(lanesPath());
    const untouchedBefore = hashOf(packetPath(untouched.id));

    const result = trackLoom([a.id, b.id], { loomId: "loom-abc", label: "exports series" });

    expect(result.tracked.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(result.missing).toEqual([]);
    expect(result.alreadyTracking).toEqual([]);
    expect(getWorkspaceItem(a.id)!.tracking).toEqual({ loomId: "loom-abc", label: "exports series" });
    expect(getWorkspaceItem(b.id)!.tracking).toEqual({ loomId: "loom-abc", label: "exports series" });

    // THE ASSERTION THIS GROUP EXISTS FOR. A weave that removed the woven ids
    // from their stacks would be the "leave at weave time" behaviour CAP-11
    // forbids AND a deletion path that never calls rmSync.
    expect(hashOf(lanesPath())).toBe(lanesBefore);
    expect(readLanes().find((l) => l.key === "office")!.items).toEqual([a.id, b.id, untouched.id]);
    // The rows are still ranked exactly where they were.
    expect(queueSlice(readLanes(), listItems().items).map((r) => [r.lane, r.rank, r.item.id])).toEqual([
      ["office", 1, a.id],
      ["office", 2, b.id],
      ["office", 3, untouched.id],
    ]);
    // A non-member's packet was not rewritten either.
    expect(hashOf(packetPath(untouched.id))).toBe(untouchedBefore);
  });

  test("re-stamping the SAME loom is idempotent, and re-pointing at a DIFFERENT one writes nothing and is reported", () => {
    ensureWorkspace();
    const item = createItem({ title: "already woven" });
    trackLoom([item.id], { loomId: "loom-first" });
    const after = hashOf(packetPath(item.id));

    // Same loom twice — a retried approval, a route replayed. No churn.
    const again = trackLoom([item.id], { loomId: "loom-first" });
    expect(again.tracked.map((i) => i.id)).toEqual([item.id]);
    expect(getWorkspaceItem(item.id)!.tracking!.loomId).toBe("loom-first");

    // A SECOND loom would silently orphan the first loom's membership: it is
    // still weaving on a premise built from this packet.
    const repoint = trackLoom([item.id], { loomId: "loom-second" });
    expect(repoint.tracked).toEqual([]);
    expect(repoint.alreadyTracking).toEqual([{ id: item.id, loomId: "loom-first" }]);
    expect(getWorkspaceItem(item.id)!.tracking!.loomId).toBe("loom-first");
    expect(hashOf(packetPath(item.id))).toBe(after);
  });

  test("an id that resolves to no readable packet is REPORTED, never thrown, and the readable members are still stamped", () => {
    ensureWorkspace();
    const real = createItem({ title: "real" });
    const result = trackLoom(["i-does-not-exist", real.id, real.id], { loomId: "loom-x" });
    expect(result.missing).toEqual(["i-does-not-exist"]);
    // De-duplicated: the same id passed twice writes one packet, once.
    expect(result.tracked.map((i) => i.id)).toEqual([real.id]);
    expect(getWorkspaceItem(real.id)!.tracking!.loomId).toBe("loom-x");
  });

  test("tracking is STILL unreachable through updateItem — the patch path throws, so trackLoom is the only door", () => {
    ensureWorkspace();
    const item = createItem({ title: "guarded" });
    expect(() =>
      // The type forbids this; the cast is the runtime half of "enforced twice".
      updateItem(item.id, { tracking: { loomId: "loom-sneaky" } } as unknown as ItemPatch),
    ).toThrow("tracking");
    expect(getWorkspaceItem(item.id)!.tracking).toBeUndefined();
  });

  test("`replacing` is the ONE exit from the re-point refusal, and it is per-id, not per-batch", () => {
    // THE OTHER HALF OF THE REFUSAL ABOVE, and the reason that refusal is not a
    // life sentence: a loom the human cancelled can never land and can never be
    // accepted, so without this its members could neither leave the queue nor be
    // woven again, and the only repair would be hand-editing packet.yaml.
    //
    // The caller decides deadness (this module cannot see looms at all — AD-5
    // gives it the workspace subtree and nothing else), so the test drives the
    // parameter rather than a loom state.
    ensureWorkspace();
    const freed = createItem({ title: "its loom was cancelled" });
    const held = createItem({ title: "its loom is still weaving" });
    trackLoom([freed.id, held.id], { loomId: "loom-dead", label: "the first one" });

    const result = trackLoom([freed.id, held.id], { loomId: "loom-new", label: "the second one" }, {
      replacing: [freed.id],
    });

    // NAMED → re-pointed, label and all.
    expect(result.tracked.map((i) => i.id)).toEqual([freed.id]);
    expect(getWorkspaceItem(freed.id)!.tracking).toEqual({
      loomId: "loom-new",
      label: "the second one",
    });
    // NOT NAMED → still refused, in the SAME call. An exception that leaked to
    // the whole batch would let one dead loom free every row beside it.
    expect(result.alreadyTracking).toEqual([{ id: held.id, loomId: "loom-dead" }]);
    expect(getWorkspaceItem(held.id)!.tracking).toEqual({
      loomId: "loom-dead",
      label: "the first one",
    });
    // And an id in `replacing` that is NOT already tracked is simply an ordinary
    // stamp — the list lifts a refusal, it never becomes a second write path.
    const fresh = createItem({ title: "never woven" });
    expect(trackLoom([fresh.id], { loomId: "loom-new" }, { replacing: [fresh.id] }).tracked).toHaveLength(1);
  });

  test("the stamp survives a round-trip through the packet's own schema, unknown keys included", () => {
    ensureWorkspace();
    const item = createItem({ title: "round trip", raw: "the user's own words" });

    // THE UNKNOWN KEY IS HAND-WRITTEN INTO packet.yaml, because nothing this
    // store's own API can produce one — and without it the "unknown keys
    // included" half of this title asserted nothing at all (the fixture was a
    // plain createItem item, so the only field checked below was a declared one
    // and z.looseObject's whole reason for being went unproved).
    //
    // WHY IT MATTERS: item-model.md's forward-compatibility rule is that a
    // packet written by a NEWER Telar must survive a write by an older one. The
    // weave stamp is a full read-modify-write of packet.yaml, so it is exactly
    // the write that would drop such a field.
    const raw = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8"));
    fs.writeFileSync(
      packetPath(item.id),
      YAML.stringify({ ...raw, futureField: { shape: "not in this schema", n: 7 } }),
    );

    trackLoom([item.id], { loomId: "loom-round", label: "round" });

    const onDisk = YAML.parse(fs.readFileSync(packetPath(item.id), "utf8"));
    expect(onDisk.tracking).toEqual({ loomId: "loom-round", label: "round" });
    // NEVER OVERWRITTEN BY ANY WRITE PATH (AC9) — the weave is not an exception.
    expect(onDisk.raw).toBe("the user's own words");
    // THE ACTUAL looseObject CLAIM: the key this store has never heard of came
    // back out of the write untouched.
    expect(onDisk.futureField).toEqual({ shape: "not in this schema", n: 7 });
    const parsed = Item.parse(onDisk) as unknown as Record<string, unknown>;
    expect(parsed.futureField).toEqual({ shape: "not in this schema", n: 7 });
    expect(Item.parse(onDisk).tracking!.loomId).toBe("loom-round");
  });
});
