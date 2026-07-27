// The workspace store: the ONE owning module for TELAR_HOME/workspace (AD-5,
// NFR-X-4), and the only thing in the tree that reads or writes it.
//
// ── WHY THIS IS A PORT AND NOT A DIRECTORY SESSIONS CAN REACH ────────────────
// SPEC-organization-workspace's CAP-12 says items "are not the Workspace
// surface's private data" — every session anywhere in Telar must be able to
// read and file them. brownfield.md explains why file access cannot be how:
// "Codex's sandbox workspace-write boundary is purely path-based — working root
// + --add-dir. A project session's root is its own repo, so TELAR_HOME/workspace
// is outside it... Granting every project session an --add-dir onto the
// workspace store would widen each session's write boundary across all
// projects' items — the opposite of the isolation the rest of the system
// maintains." So the store is reached through an in-process MCP server
// (apps/web/lib/workspace-mcp.ts) and through nothing else. AC7 is not a
// restriction bolted onto the design; it is the reason the design exists.
//
// ── THREE THINGS HERE ARE NEW TO THIS REPO, AND EACH IS COMMENTED WHERE IT SITS
//   1. A TWO-FILE WRITE WITH A RECONCILE RULE INSTEAD OF A TRANSACTION. There is
//      no multi-file-transaction precedent in this repo to copy. See
//      "the reconcile rule" below.
//   2. THE FIRST MIGRATE-ON-READ. grep for `version ===` / `!==` / `>` / `>=`
//      across packages/core/src, apps/web/lib and apps/web/app returned ZERO
//      before this file: eight stores carry a `version` field and all eight
//      record it and never consult it. See migratePacket.
//   3. THE FIRST LOOSE ZOD SCHEMA (schema.ts's Item). See that file's header.
//
// ── WHAT THIS MODULE DELIBERATELY IMPORTS RATHER THAN RE-DERIVES ─────────────
// `telarDir` and `atomicWrite` both come from manifest.ts. Taking the
// atomicWrite IMPORT is the minority choice and is deliberate: it has exactly
// one other importer (servers.ts) while watches.ts, accounts.ts, looms.ts,
// ultra/storage.ts and ultra/wake.ts all inline the same mkdir+tmp+rename idiom
// instead. Two of those have a stated reason (runner/lease.ts's DI seam; the
// 0o600 + chmodSync in secrets.ts and mcp-oauth.ts); this store has neither, so
// it takes the import — a reader who greps the neighbours will find seven
// counter-examples and should find this sentence first. `telarDir` is NOT
// optional: INV-3e allows exactly five files to derive the state root from
// scratch and a sixth fails it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { atomicWrite, telarDir } from "../manifest";
import {
  ITEM_SCHEMA_VERSION,
  Item,
  WorkspaceLane,
  type Deadline,
  type ItemVerdict,
} from "./schema";

// ── the layout ───────────────────────────────────────────────────────────────

// The one expression in the tree that composes the workspace root.
//
// THE SECOND ARGUMENT IS A BARE QUOTED LITERAL ON PURPOSE, AND A CONST WOULD BE
// A SILENT REGRESSION RATHER THAN A TIDY-UP. packages/core/test/invariants.
// test.ts's `rootCompositionSites` matches `path.join(<resolver>(), "<quoted
// literal>")` and nothing else — `path.join(telarDir(), WORKSPACE_DIR)` with a
// const produces ZERO sites, and INV-3a's site inventory, INV-3b's owner map and
// INV-3d's "workspace is owned" assertion all stay green while the subtree is
// real on disk. The literal is a deliberate concession to a static scanner, not
// a claim that the const would be worse code. Do not "improve" it.
export function workspaceDir(): string {
  return path.join(telarDir(), "workspace");
}

// The master session's dedicated cwd (AD-9). EXPORTED BECAUSE
// packages/core/src/session-profile.ts's header instructs it to be: "AD-9's
// project-less master profile needs `cwd: <TELAR_HOME>/workspace/home`, so that
// story adds an optional `cwd` to the SPEC — and it must reach that subtree
// through the owning module's exported port, never by composing a path here."
// This module is the owner; story 5.3 calls this instead of composing.
//
// It holds NO store files, and ensureWorkspace asserts that by construction:
// lanes.yaml and packets/ are siblings of home/, never children. That is what
// makes SPEC.md's "the store above it stays outside the master's path-based
// write boundary" structurally true rather than merely intended — a master
// session rooted here can write freely without reaching one item.
//
// Composed off workspaceDir() rather than off telarDir(), so it contributes no
// second root-composition site.
export function workspaceHomeDir(): string {
  return path.join(workspaceDir(), "home");
}

const lanesFile = () => path.join(workspaceDir(), "lanes.yaml");
const packetsRoot = () => path.join(workspaceDir(), "packets");

// The traversal guard, copied from looms.ts's loomDir — the REGEX PLUS the
// containment re-check, which is strictly stronger than ultra/journal.ts's
// runDir (regex only). This is the one place an item id reaches the filesystem,
// so it is the one place the id needs guarding against `../../etc` relocating a
// packet off-disk. It THROWS; every reader below catches and treats a bad id as
// not-found, never as a 500 (getUltraManifest's stated idiom).
function packetDir(id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid workspace item id: ${JSON.stringify(id)}`);
  }
  const base = packetsRoot();
  const dir = path.join(base, id);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!dir.startsWith(withSep)) {
    throw new Error(`invalid workspace item id: ${JSON.stringify(id)}`);
  }
  return dir;
}

const packetFile = (id: string) => path.join(packetDir(id), "packet.yaml");

// The packet filename, as a value, because three places need to agree about it:
// the writer, the reader, and attachmentTally's exclusion.
const PACKET_FILE = "packet.yaml";

// ultra/executor.ts's newUltraRunId shape (`u-` + 6 random bytes), with this
// store's own prefix. MINTED, NEVER DERIVED FROM POSITION: an id derived from a
// lane index or a count breaks the moment the stack is reordered, and reordering
// is the one operation this store exists to make cheap.
const newItemId = () => `i-${crypto.randomBytes(6).toString("hex")}`;

// ── the seed lane ────────────────────────────────────────────────────────────

// AC5 needs "the right lane" to file into; AC8 proof 4 forbids any TOOL creating
// one; NFR-OW-10 reserves lane-structure changes to the human; and no spec
// source supplies a default set (SPEC.md: "lanes are data, never an enum"). The
// resolution is that the STORE's ensure step seeds exactly one ordinary lane
// row — and the store is not a tool. That distinction is the whole of what makes
// it legal.
//
// IT CARRIES NO SPECIAL BEHAVIOUR IN CODE. It is renameable and retireable like
// any other row, and nothing re-creates it. `resolveLane` below uses this key
// only as a FALLBACK TARGET; if the user renames the row, the fallback finds no
// such lane and the item comes to rest UNFILED — the same resting state, reached
// by the same arm, with no lane resurrected behind the user's back.
//
// The fixtures' aurora/office/school/free are one user's life, not a default
// set; they are deliberately not seeded.
const SEED_LANE_KEY = "unfiled";

const seedLane = (): WorkspaceLane => ({
  key: SEED_LANE_KEY,
  label: "Unfiled",
  window: "whenever",
  note: "created by the workspace store on first use — rename, split or retire it like any other lane",
  items: [],
});

// ── display labels: the one place a clock is read, and why it is not a clock ──

// NFR-OW-11 bans clocks and scheduling: "Order is stack position. `captured` is
// a display label; `deadline.label` is coarse human text, never a date to
// compare. If you import anything time-shaped for a DECISION, stop."
//
// This store makes no decision on time. It never parses, compares, sorts or
// buckets any of these strings — queue order is stack position, the desk is a
// boolean, and there is no scheduler. What it does need is a human-readable
// label for "when this entered", because item-model.md requires the field and
// the design-source fixtures render it ("Tue 16:42"). Reading the wall clock
// ONCE to produce that text is the honest implementation; refusing to would mean
// writing a label that is permanently wrong.
//
// The formatting is pulled out as a pure function of an instant, which is the
// project's Design Law applied as closely as the pinned createItem signature
// permits: deterministic control flow in code, the one non-deterministic read on
// its own line. It is deliberately NOT toLocaleString — that would make the
// stored bytes depend on the host's locale and timezone database.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const two = (n: number) => String(n).padStart(2, "0");
function capturedLabel(at: Date): string {
  return `${WEEKDAYS[at.getDay()]} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

// ── ensure ───────────────────────────────────────────────────────────────────

// Idempotent and safe to re-enter (AD-15). Creates the subtree, creates the
// master's dedicated home/, and seeds the one lane IF AND ONLY IF lanes.yaml
// does not exist — so a user who retires the seed lane does not get it back on
// the next write.
export function ensureWorkspace(): void {
  fs.mkdirSync(workspaceHomeDir(), { recursive: true });
  fs.mkdirSync(packetsRoot(), { recursive: true });
  if (!fs.existsSync(lanesFile())) writeLanes([seedLane()]);
}

// ── lanes.yaml ───────────────────────────────────────────────────────────────

// [] when the file is absent, unreadable or malformed — never a throw. AD-7's
// tolerant reader, and the reason loadManifest (this repo's one deliberate
// throw-on-absent) is explicitly NOT the model here: a workspace that has never
// been written is the ordinary first-run state, not an error.
export function readLanes(): WorkspaceLane[] {
  let raw: string;
  try {
    raw = fs.readFileSync(lanesFile(), "utf8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch {
    return [];
  }
  const parsed = WorkspaceLane.array().safeParse(data);
  return parsed.success ? parsed.data : [];
}

// Writes the STORED stacks, never a reconciled projection — see "the reconcile
// rule" below for why that distinction is load-bearing rather than pedantic.
export function writeLanes(lanes: WorkspaceLane[]): void {
  atomicWrite(lanesFile(), YAML.stringify(lanes));
}

// ── migrate-on-read ──────────────────────────────────────────────────────────

// AD-7 puts a schema version and a real migrate-on-read ONLY on stores holding
// unrecoverable human input, naming workspace/packets/<id>/packet.yaml "above
// all". This is that mechanism, authored from scratch: nothing in this repo
// consults a version field, so there was nothing to copy.
//
// PURE, EXPORTED AND DISK-FREE so the five behaviours below can be tested
// without a filesystem. It runs BEFORE Item.parse.
//
// THE FIVE BEHAVIOURS, each its own test:
//   absent    → normalised to 1 BEFORE any comparison. The common case for a
//               hand-authored packet.yaml, which AD-6 explicitly invites.
//               Treating it as malformed would make every hand-written packet
//               unreadable.
//   lower     → migrated up the ladder, then parsed.
//   equal     → RETURNED UNTOUCHED. This is the discriminator: without it, a
//               migratePacket that rewrites everything on every read passes
//               every other test.
//   higher    → THROWS. Never migrated down, never defaulted. The file was
//               written by a newer Telar and holds `raw` verbatim, which has no
//               source to be rebuilt from — guessing at it is exactly how the
//               field AD-7 protects gets destroyed.
//   malformed → throws, same shape.
//
// THE REPORT CHANNEL, pinned because "reported" has two readings and one is
// forbidden: this THROWS; getWorkspaceItem catches and returns null (its
// never-throw contract, getUltraManifest's idiom); and listItems surfaces the
// reason through its `unreadable` array, so one bad packet never blanks the
// other ninety-nine.
export function migratePacket(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `AD-7: a packet.yaml must be a YAML mapping, got ${raw === null ? "null" : Array.isArray(raw) ? "a sequence" : typeof raw}. ` +
        `A packet that is not a mapping cannot carry the \`raw\` fragment this store exists to preserve, so reading it would ` +
        `silently substitute an empty item for the user's own words. Fix the file by hand, or move it aside — it is never rewritten for you.`,
    );
  }
  const obj = raw as Record<string, unknown>;

  // ABSENT NORMALISES FIRST, before any comparison. A hand-authored file with no
  // schemaVersion is a current-shape file, which is the only reading that keeps
  // AD-6's "a human can edit this" claim true.
  const stamped = obj.schemaVersion;
  const absent = stamped === undefined || stamped === null;
  const version = absent ? ITEM_SCHEMA_VERSION : stamped;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new Error(
      `AD-7: packet.yaml's \`schemaVersion\` must be a number, got ${JSON.stringify(stamped)}. ` +
        `The version is what decides whether this build may read the file at all, so an unreadable version means the ` +
        `read cannot be made safe. Set it to ${ITEM_SCHEMA_VERSION} if the file matches this build's shape, or remove the key entirely.`,
    );
  }

  if (version > ITEM_SCHEMA_VERSION) {
    throw new Error(
      `AD-7: packet.yaml is at schemaVersion ${version}; this build of Telar understands ${ITEM_SCHEMA_VERSION}. ` +
        `A packet written by a newer Telar holds \`raw\` and \`rawSource\` verbatim and has no source to be rebuilt from, so ` +
        `reading it under an older shape and rewriting it would destroy fields this build cannot see. ` +
        `Upgrade Telar to open this item — the file is left exactly as it is.`,
    );
  }

  // EQUAL IS THE IDENTITY — but only when the version was EXPLICITLY equal.
  // Returning the same reference is what makes "migration did not touch it"
  // observable in a test rather than merely intended, and it is the discriminator
  // that fails a migratePacket which rebuilds everything on every read.
  //
  // The ABSENT case is deliberately NOT the identity: normalisation has to be
  // visible in the returned shape, or "normalised to 1 before any comparison" is
  // a claim nothing can check. It is the one branch that copies without
  // migrating.
  if (version === ITEM_SCHEMA_VERSION) return absent ? { ...obj, schemaVersion: ITEM_SCHEMA_VERSION } : raw;

  // ── the ladder ──
  // One rung long today, and written as a ladder anyway: a migration authored
  // under pressure later, against a mechanism that has never run, is how `raw`
  // gets destroyed. Each rung takes the shape at version N and returns the shape
  // at N+1, and the loop below walks every rung between the file's version and
  // this build's.
  //
  // THE 0 → 1 RUNG IS REAL, not a placeholder. Version 0 is the shape the
  // design-source fixtures describe (apps/web/lib/demo-gallery/workspace/
  // fixtures.ts's WsItem.subtasks is `{title, done?}[]` with NO id), so a human
  // transcribing a packet from the mockups writes exactly that. Version 1 adds
  // the sub-task id, because `promotedFrom` names a parent item and a title is
  // not an address — a rename or a duplicate breaks the reference. The rung
  // mints the missing ids.
  //
  // The minted id is DERIVED FROM CONTENT, not from position: a sha1 over
  // [itemId, title, occurrence], where `occurrence` disambiguates two sub-tasks
  // that genuinely share a title. It is minted ONCE, here, and then persisted —
  // after which reordering never re-derives it, which is the property maxim 4
  // ("a key must name the event, not the slot it landed in") is protecting.
  let shape: Record<string, unknown> = { ...obj, schemaVersion: version };
  for (let v = version; v < ITEM_SCHEMA_VERSION; v++) {
    const rung = LADDER[v];
    if (!rung) {
      throw new Error(
        `AD-7: packet.yaml is at schemaVersion ${v}, and this build has no migration from ${v} to ${v + 1}. ` +
          `Migrating past a gap would mean guessing at a shape nobody wrote down, against a file holding \`raw\` verbatim. ` +
          `The file is left exactly as it is; the missing rung belongs in packages/core/src/workspace/store.ts's LADDER.`,
      );
    }
    shape = { ...rung(shape), schemaVersion: v + 1 };
  }
  return shape;
}

const LADDER: Record<number, (o: Record<string, unknown>) => Record<string, unknown>> = {
  // 0 → 1: sub-tasks gain an id (see migratePacket's ladder comment).
  0: (o) => {
    const subtasks = o.subtasks;
    if (!Array.isArray(subtasks)) return o;
    const seen = new Map<string, number>();
    const itemId = typeof o.id === "string" ? o.id : "";
    return {
      ...o,
      subtasks: subtasks.map((st) => {
        if (st === null || typeof st !== "object" || Array.isArray(st)) return st;
        const sub = st as Record<string, unknown>;
        if (typeof sub.id === "string" && sub.id.length > 0) return sub;
        const title = typeof sub.title === "string" ? sub.title : "";
        const occurrence = (seen.get(title) ?? 0) + 1;
        seen.set(title, occurrence);
        const digest = crypto
          .createHash("sha1")
          .update(JSON.stringify([itemId, title, occurrence]))
          .digest("hex")
          .slice(0, 8);
        return { ...sub, id: `st-${digest}` };
      }),
    };
  },
};

// ── reading items ────────────────────────────────────────────────────────────

// null on absent, on a malformed/traversal id, and on an unreadable or
// version-ahead packet. NEVER THROWS — getUltraManifest's stated contract:
// "treat as not-found, never a 500 (looms.ts idiom)". A caller that needs the
// REASON reads listItems' `unreadable` channel instead.
//
// MIGRATE-ON-READ WRITES NOTHING BACK. A read that writes is precisely the
// hazard INV-7 exists to police, and it would also make a version-ahead file
// unrecoverable on the very read that was supposed to protect it. The migrated
// shape lands on the next legitimate write, and workspace-store.test.ts asserts
// the file's CONTENT HASH is unchanged across a read.
export function getWorkspaceItem(id: string): Item | null {
  let file: string;
  try {
    file = packetFile(id);
  } catch {
    return null;
  }
  try {
    const parsed = Item.parse(migratePacket(YAML.parse(fs.readFileSync(file, "utf8"))));
    return parsed;
  } catch {
    return null;
  }
}

// Why the reason is a string and not an enum: it is human-facing diagnosis
// surfaced through the MCP server's own okResult text, and the set of ways a
// hand-edited YAML file can be wrong is not enumerable.
export type UnreadableItem = { id: string; reason: string };

// Every readable packet, plus everything the store could not make sense of.
//
// TWO CHANNELS, ONE CALL, because a caller that only got `items` would have no
// way to tell "the user has three items" from "the user has three items and two
// unreadable ones". listUltraRuns is the listing shape this follows (readdirSync
// in a try that returns [], a tolerant per-id read, then a deterministic sort);
// the second channel is what this store adds, because a workspace item is the
// user's own words and losing one silently is the failure mode AD-7 exists to
// prevent.
//
// It also reads lanes.yaml, which a pure item lister would not need — that is
// what makes the two structural faults (a stack id with no readable packet; the
// same id pasted into two stacks) reportable at all. queueSlice DROPS both from
// the projection; this is where a human is told they happened.
export function listItems(): { items: Item[]; unreadable: UnreadableItem[] } {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(packetsRoot());
  } catch {
    return { items: [], unreadable: [] }; // no store yet
  }

  const items: Item[] = [];
  const unreadable: UnreadableItem[] = [];
  for (const id of ids.slice().sort()) {
    let file: string;
    try {
      file = packetFile(id);
    } catch {
      unreadable.push({ id, reason: "not a valid item id (a packet directory name must be [A-Za-z0-9_-]+)" });
      continue;
    }
    if (!fs.existsSync(file)) continue; // a directory with no packet.yaml is not an item
    try {
      items.push(Item.parse(migratePacket(YAML.parse(fs.readFileSync(file, "utf8")))));
    } catch (e) {
      unreadable.push({ id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // The two structural faults, reported here and dropped by queueSlice.
  const readable = new Set(items.map((i) => i.id));
  const placed = new Set<string>();
  for (const lane of readLanes()) {
    for (const id of lane.items) {
      if (placed.has(id)) {
        unreadable.push({
          id,
          reason: `listed in more than one lane stack (again in "${lane.key}"); the FIRST stack in lanes.yaml order wins and this occurrence is ignored`,
        });
        continue;
      }
      placed.add(id);
      if (!readable.has(id)) {
        unreadable.push({
          id,
          reason: `listed in lane "${lane.key}" but has no readable packet; it is shown nowhere until the packet is readable again, and its id is NEVER removed from lanes.yaml`,
        });
      }
    }
  }

  return { items, unreadable };
}

// ── writing items ────────────────────────────────────────────────────────────

// The creation input. This is §5.5-D19's pinned shape plus ONE disclosed field.
//
// `creationNote` IS THE DISCLOSED ADDITION, and it is what makes the pinned
// design implementable at all. §5.5-D7 rules that no `sessionId` field is added
// to the item and that "the session's identity is carried by the creation
// TimelineEvent's `text`"; the tool surface is required to compose that text
// server-side. With no channel for it, the ruling has nowhere to land — the
// pinned NewItem has no timeline field and ItemPatch deliberately excludes
// `timeline`, so a caller could not supply it afterwards either. The field
// carries TEXT ONLY: the store owns the TimelineEvent's `at` and `actor`, so a
// caller cannot forge an actor or backdate an entry.
export type NewItem = {
  title: string;
  project?: string;
  lane?: string;
  raw?: string;
  rawSource?: string;
  creationNote?: string;
};

// What an update may change. THE EXCLUSIONS ARE THE CONTRACT, not an oversight:
// `id`, `raw`, `rawSource`, `schemaVersion`, `promotedFrom`, `tracking`,
// `subtasks`, `timeline`, `provenance` and `captured` cannot be named here.
//   - raw/rawSource: AC9. item-model.md — "never overwritten"; it is what lets
//     the user check the expert did not drift from what they meant.
//   - promotedFrom: NFR-OW-15, "Agents have no promotion path, proposed or
//     otherwise." The field exists on the item; nothing can write it.
//   - tracking, subtasks, timeline: stories 5.5, 5.2 and 5.4 own those writes.
//   - schemaVersion: the store decides what version it wrote.
export type ItemPatch = Partial<
  Pick<Item, "title" | "lane" | "project" | "desk" | "unplaced" | "mirrored"> & {
    deadline: Deadline;
    verdict: ItemVerdict;
  }
>;

const PATCHABLE = [
  "title",
  "lane",
  "project",
  "desk",
  "unplaced",
  "mirrored",
  "deadline",
  "verdict",
] as const;

// ── the reconcile rule (AD-15's "reconcile on read", applied to a two-file
//    write, because this repo has no multi-file transaction to copy) ──────────
//
// AUTHORITY. lanes.yaml's stacks decide membership AND order. packet.yaml's
// `lane` is a RECOVERY HINT, consulted only when the id appears in NO stack.
// Three things follow, and all three are the reason for the asymmetry:
//   - a hand-edit WINS (AD-6's human-editability claim is exercised by the dev
//     proof: reorder two ids, move one between lanes, and both take effect);
//   - reconcile is idempotent by construction, because it derives from a file
//     nothing but an explicit write changes;
//   - a TORN LANE MOVE IS SAFE. If updateItem writes the packet and dies before
//     writeLanes, the id is still in its old stack, the orphan arm does not
//     fire, and the move simply did not happen. No duplicate, no ambiguity.
//
// WRITE ORDER: packets/<id>/packet.yaml FIRST, lanes.yaml SECOND. A crash in the
// gap leaves the content intact (NFR-OW-4's "capture raw" is what must survive)
// with the id not yet in a stack — which the orphan arm then adopts. Written the
// other way round, the crash gap would leave lanes.yaml naming an item whose
// words were never saved.
//
// THE FOUR ARMS (queueSlice below implements them):
//   1. ORPHAN     — id in no stack → placed in the stack named by packet.lane.
//   2. TOMBSTONE  — stack id with no readable packet → dropped from the
//                   projection, never thrown (AD-8's weak-reference law applied
//                   inside this subtree).
//   3. LANE GONE  — packet.lane names a lane absent from lanes.yaml, or is
//                   absent entirely → the item is UNFILED: returned by
//                   listItems and deskSlice, excluded from queueSlice, rankOf
//                   returns null. Creating the lane would violate AC8 proof 4;
//                   dropping the item would be a silent deletion; throwing would
//                   break the never-throw contract. A fourth resting state
//                   beside floating is the only reading consistent with the rest.
//   4. DUPLICATE  — the same id in two stacks (a hand-edited paste) → the FIRST
//                   stack in lanes.yaml order wins; the later occurrence is
//                   dropped from the projection and reported by listItems.
//
// PROJECTION-ONLY, AND THIS IS THE LOAD-BEARING HALF. Reconciliation NEVER
// writes back. writeLanes writes the STORED stacks plus the current mutation,
// never the reconciled projection. Otherwise one transiently unreadable packet
// directory (EACCES, an interrupted mkdirSync, a half-finished renameSync) would
// permanently drop that id from lanes.yaml on the very next create_item — a
// DELETION PATH THAT NEVER CALLS rmSync, so a scan of the handlers for
// rmSync/unlinkSync would pass straight over it. SPEC.md's non-goals say "No
// deletion path"; this is the arm of that rule a naming check cannot reach.

// Which lane a new item comes to rest in.
//
// A REQUESTED LANE THAT DOES NOT EXIST IS NEVER CREATED. NFR-OW-10 reserves lane
// structure to the human, so an agent naming an unknown lane would otherwise be
// making a lane-structure change by side effect. Instead the item files into the
// seed lane and is marked `unplaced`, so the desk ASKS — which is exactly what
// item-model.md says unplaced is for: "the master could not file it and is
// asking... renders as a question, not a failure."
function resolveLane(lanes: WorkspaceLane[], requested?: string): { lane: string; unplaced: boolean } {
  if (requested && lanes.some((l) => l.key === requested)) return { lane: requested, unplaced: false };
  return { lane: SEED_LANE_KEY, unplaced: true };
}

// Create an item. Two files, in the order the reconcile rule above pins.
//
// `provenance` IS WRITTEN SERVER-SIDE AND IS NEVER READ FROM CALLER INPUT — the
// same rule loom-mcp.ts's start_loom states for `by` ("the chat's own
// server-resolved identity, never a value read from tool input"). It is the
// free-form label NFR-OW-12 requires and is deliberately NOT narrowed to a
// union: "provenance is a free-form label, not a channel type" — a union is
// precisely what that constraint forbids. "session" is the honest label for
// every write this story can produce, because the store's only writer today is
// an in-process MCP server running inside a chat session. A later story writing
// from somewhere else (5.4's brain dump, 5.5's mirror sync) widens NewItem here.
export function createItem(input: NewItem): Item {
  ensureWorkspace();
  const lanes = readLanes();
  const { lane, unplaced } = resolveLane(lanes, input.lane);
  const at = capturedLabel(new Date());

  const item: Item = Item.parse({
    id: newItemId(),
    title: input.title,
    provenance: "session",
    captured: at,
    schemaVersion: ITEM_SCHEMA_VERSION,
    lane,
    // "Places it on the desk" (AC5). A boolean on the item, because
    // item-model.md calls the Desk item "a projection of an item the agents just
    // touched, NOT a separate store".
    desk: true,
    ...(unplaced ? { unplaced: true } : {}),
    ...(input.project ? { project: input.project } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
    ...(input.rawSource ? { rawSource: input.rawSource } : {}),
    timeline: [
      {
        at,
        // The widened member (schema.ts's PacketActor). A project session's
        // agent is not `you`, not the per-project `expert` and not `bed`.
        actor: "session",
        text: input.creationNote ?? "captured from a session",
      },
    ],
  });

  // PACKET FIRST.
  writePacket(item);
  // LANES SECOND — the stored stacks plus this one mutation, never a projection.
  const target = lanes.find((l) => l.key === lane);
  if (target) {
    writeLanes(lanes.map((l) => (l.key === lane ? { ...l, items: [...l.items, item.id] } : l)));
  }
  // If the seed lane was retired the item is simply unfiled (arm 3). No lane is
  // created to receive it — that would be the agent lane-structure change
  // NFR-OW-10 forbids.
  return item;
}

// Apply a patch. null when the item does not exist or cannot be read.
//
// A FORBIDDEN KEY THROWS RATHER THAN BEING SILENTLY DROPPED, and that is AC9's
// "reported rather than silently ignored". The TYPE already forbids naming one;
// this is the runtime half, which is the same "enforced twice" doctrine
// resolveSessionProfile states for tool grants — a cast, a JSON.parse or a
// future deserialization boundary cannot get past a check the type alone makes.
// Silently dropping `raw` from a patch would look identical, from the outside,
// to honouring it — and the difference is whether the user's own words survived.
export function updateItem(id: string, patch: ItemPatch): Item | null {
  const forbidden = Object.keys(patch).filter(
    (k) => !(PATCHABLE as readonly string[]).includes(k),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `AC9/NFR-OW-19: updateItem cannot write ${forbidden.map((f) => `\`${f}\``).join(", ")}. ` +
        `\`raw\`/\`rawSource\` are the user's own words kept verbatim so they can check an expert did not drift from what they ` +
        `meant, \`promotedFrom\` has no agent path by NFR-OW-15, and \`subtasks\`/\`timeline\`/\`tracking\` belong to later stories. ` +
        `Silently dropping them would be indistinguishable from honouring them. Patch only: ${PATCHABLE.join(", ")}.`,
    );
  }

  const current = getWorkspaceItem(id);
  if (!current) return null;

  // Spread order matters: `current` first, so every field the patch does not
  // name — including every UNKNOWN key z.looseObject preserved off disk —
  // survives the rewrite untouched.
  const next = Item.parse({ ...current, ...patch, schemaVersion: ITEM_SCHEMA_VERSION });
  writePacket(next);
  return next;
}

function writePacket(item: Item): void {
  atomicWrite(packetFile(item.id), YAML.stringify(item));
}

// ── the pure projections (§5.5-D15) ──────────────────────────────────────────
//
// All four take ALREADY-READ data and touch no disk. That is what makes them
// testable without a sandbox and what keeps INV-7's reader surface honest — a
// projection is not a reader. Story 5.2's /api/workspace handler becomes a thin
// caller over these, the shape story 4.2 established with filterRunsBySession;
// apps/web/app/api/ultra/route.ts's own comment says why the logic must not live
// in the handler ("THERE IS NO ROUTE-TEST HARNESS IN THIS REPO").

// 1-BASED, because every rendering in the tree is: fixtures.ts's WS_LANES starts
// every lane at rank 1, and session.tsx renders "rank 6" for a new item in a
// 5-item lane. null when the item is in no stack — unfiled, or floating, or
// simply not there. First stack wins, matching the duplicate arm.
export function rankOf(lanes: WorkspaceLane[], itemId: string): number | null {
  for (const lane of lanes) {
    const i = lane.items.indexOf(itemId);
    if (i >= 0) return i + 1;
  }
  return null;
}

export type QueueRow = { lane: string; rank: number; item: Item };

// The reconcile rule's four arms, as a pure join. Returns one row per FILED
// item, in lane order then stack order, with orphans appended to the stack their
// packet points at.
//
// NFR-OW-3, THE CONSERVATION LAW: this returns ITEMS, never items-plus-subtasks.
// Decomposition lives inside the item, so breaking work down never grows the
// queue count, and the test asserts exactly that.
export function queueSlice(lanes: WorkspaceLane[], items: Item[]): QueueRow[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed = new Set<string>();
  const rows: QueueRow[] = [];

  for (const lane of lanes) {
    for (const id of lane.items) {
      if (placed.has(id)) continue; // arm 4 — duplicate; the first stack won
      placed.add(id);
      const item = byId.get(id);
      if (!item) continue; // arm 2 — tombstone; dropped, never thrown
      rows.push({ lane: lane.key, rank: 0, item });
    }
  }

  // Arm 1 — orphans, adopted into the stack their packet names. Sorted by id so
  // two runs over the same disk state produce the same order; the ids are minted
  // random hex, so this is a stable arbitrary order and not a meaningful one.
  // Arm 3 — an orphan whose lane is absent, or names a lane that is not in
  // lanes.yaml, is UNFILED and gets no row at all.
  const laneKeys = new Set(lanes.map((l) => l.key));
  for (const item of items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (placed.has(item.id)) continue;
    if (!item.lane || !laneKeys.has(item.lane)) continue;
    rows.push({ lane: item.lane, rank: 0, item });
  }

  // Rank last, over the projection, so an adopted orphan gets the position it
  // actually occupies rather than the one lanes.yaml would have given it.
  const nextRank = new Map<string, number>();
  return rows.map((r) => {
    const rank = (nextRank.get(r.lane) ?? 0) + 1;
    nextRank.set(r.lane, rank);
    return { ...r, rank };
  });
}

export type DeskCard = {
  id: string;
  title: string;
  tag?: string;
  hint?: string;
  unplaced?: boolean;
};

// The right rail's cards, from ITEM FIELDS ALONE — item-model.md: the Desk item
// is "a projection of an item the agents just touched, not a separate store".
// Unfiled items appear here too, which is the point: an item the master could
// not place is exactly the one the human needs to see.
//
// 5.1 SHIPS THIS PROJECTION AND NO RAIL. The rail is 5.3's; dismissal is
// updateItem({desk: false}) and NO TOOL EXPOSES IT in this story — 5.3 reaches
// dismissal through 5.2's route.
export function deskSlice(items: Item[]): DeskCard[] {
  return items
    .filter((i) => i.desk === true)
    .map((i) => {
      const hint = i.unplaced
        ? "unplaced — what is it?"
        : i.deadline
          ? `${i.deadline.label} · ${i.deadline.kind}`
          : i.mirrored
            ? `mirrored ${i.mirrored}`
            : undefined;
      return {
        id: i.id,
        title: i.title,
        ...(i.project ? { tag: i.project } : {}),
        ...(hint ? { hint } : {}),
        ...(i.unplaced ? { unplaced: true } : {}),
      };
    });
}

// Extensions that render as a picture. Everything else is a file. Coarse on
// purpose: the tally is a presence signal in the UI ("2 files · 1 mockup"), not
// a content type system.
const MOCKUP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

// The {files, mockups} tally item-model.md's Item table calls `packet` —
// DERIVED AT READ TIME AND NEVER PERSISTED. That is what makes AC2's "an item
// growing attachments needs no migration" true by construction: dropping a file
// beside packet.yaml changes the tally and rewrites nothing, and the test
// asserts the packet's CONTENT HASH is unchanged (not its mtime — macOS mtime
// resolution is coarse enough that a rewrite inside one tick would pass an mtime
// check).
//
// Takes NAMES, so it is pure and disk-free. Callers pass FILE names only —
// readPacketAttachments below uses readdirSync(dir, {withFileTypes: true}), the
// house form (bundle.ts, spec-lint.ts, deliverable-signal.ts), so subdirectories
// never reach here. packet.yaml itself is excluded here, where the name is
// known, rather than at every call site.
export function attachmentTally(names: string[]): { files: number; mockups: number } {
  let files = 0;
  let mockups = 0;
  for (const name of names) {
    if (name === PACKET_FILE) continue;
    if (MOCKUP_EXT.has(path.extname(name).toLowerCase())) mockups++;
    else files++;
  }
  return { files, mockups };
}

// The one disk read that feeds attachmentTally. Returns [] for an item with no
// attachments directory — the bare-todo case, which is the common one.
export function readPacketAttachments(id: string): string[] {
  let dir: string;
  try {
    dir = packetDir(id);
  } catch {
    return [];
  }
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((n) => n !== PACKET_FILE)
      .sort();
  } catch {
    return [];
  }
}
