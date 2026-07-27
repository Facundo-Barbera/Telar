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
// one other importer (servers.ts), while EIGHT files under packages/core/src
// inline the same mkdir+tmp+rename idiom instead — watches.ts, accounts.ts,
// looms.ts, ultra/storage.ts, ultra/wake.ts, runner/lease.ts, secrets.ts and
// mcp-oauth.ts (measured: files matching both `renameSync` and `.tmp`;
// sessions.ts renames a DIRECTORY and is not one of them). Three of the eight
// have a stated reason (runner/lease.ts's DI seam; the 0o600 + chmodSync in
// secrets.ts and mcp-oauth.ts); this store has none, so it takes the import — a
// reader who greps the neighbours will find eight counter-examples and should
// find this sentence first. `telarDir` is NOT
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

// The lanes filename, as a value, for the same reason PACKET_FILE below is one:
// the writer, the reader and every diagnostic that NAMES the file to a human
// have to agree about it.
const LANES_FILE = "lanes.yaml";
const lanesFile = () => path.join(workspaceDir(), LANES_FILE);
const packetsRoot = () => path.join(workspaceDir(), "packets");

// The traversal guard, copied from looms.ts's loomDir — the REGEX PLUS the
// containment re-check, which is strictly stronger than ultra/journal.ts's
// runDir (regex only), and MEASURED to be rather than asserted: with the regex
// deleted, `../escaped` still throws on the re-check and the containment test
// stays green; with BOTH deleted, that test turns red and a readable packet
// planted outside packets/ is reachable by id. So the re-check cannot FIRE while
// the regex stands — and it is the half that holds if the regex ever goes.
// This is the one place an item id reaches the filesystem,
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

// [] when the file is absent or unreadable — never a throw. AD-7's tolerant
// reader, and the reason loadManifest (this repo's one deliberate
// throw-on-absent) is explicitly NOT the model here: a workspace that has never
// been written is the ordinary first-run state, not an error.
export function readLanes(): WorkspaceLane[] {
  return readLanesReport().lanes;
}

// TOLERANCE IS PER ROW, NOT PER FILE, and the difference is the whole of AD-6's
// premise. `WorkspaceLane.array().safeParse` — the obvious spelling, and the one
// this file shipped with — is ALL-OR-NOTHING: a human who hand-edits lanes.yaml
// and drops `window:` from ONE of five rows gets `[]` back, which means their
// entire lane structure disappears from every read and every subsequent
// create_item silently accumulates in no stack at all. Hand-editability is the
// premise (AD-6), so the store's response to an IMPERFECT hand-edit cannot be to
// discard the file; AD-7's tolerant reader keeps every row it can make sense of
// and REPORTS the ones it cannot.
//
// THE REPORT IS THE OTHER HALF, and without it "tolerant" would be
// indistinguishable from "silently lossy". listItems folds `malformed` into its
// `unreadable` channel, which the MCP server already surfaces to the model — so
// the human is told which row is wrong instead of watching a lane vanish.
//
// `entries` IS THE THIRD HALF, AND IT IS THE ONE THAT MAKES TOLERANCE SAFE. A
// partial READ that is then written back is a partial DELETE: `createItem` and
// `updateItem` rewrite the whole file, so handing them `lanes` — which excludes
// the skipped row — would permanently erase that row and every item id in it on
// the very next capture, silently, and the report would then go quiet because
// there is nothing left to report. That is strictly worse than the
// all-or-nothing read it replaced. So the writers take `entries`, which carries
// EVERY row in file order — the ones this build understood and the raw bytes of
// the ones it did not — and they write those RAW rows back. A row this build
// cannot parse is preserved verbatim; unknown keys on rows it CAN parse survive
// too, because the raw row is what is written, not the parsed projection.
export type LaneEntry = { row: unknown; lane: WorkspaceLane | null };

export function readLanesReport(): {
  lanes: WorkspaceLane[];
  malformed: UnreadableItem[];
  entries: LaneEntry[];
} {
  let raw: string;
  try {
    raw = fs.readFileSync(lanesFile(), "utf8");
  } catch {
    return { lanes: [], malformed: [], entries: [] }; // absent is the ordinary first-run state
  }
  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (e) {
    return {
      lanes: [],
      entries: [],
      malformed: [
        {
          id: LANES_FILE,
          reason: `${LANES_FILE} is not valid YAML (${e instanceof Error ? e.message : String(e)}), so no lane could be read from it. Every item keeps its packet; nothing was rewritten. Fix the file by hand.`,
        },
      ],
    };
  }
  // An empty file parses to null and is the same state as an absent one.
  if (data === null || data === undefined) return { lanes: [], malformed: [], entries: [] };
  if (!Array.isArray(data)) {
    return {
      lanes: [],
      entries: [],
      malformed: [
        {
          id: LANES_FILE,
          reason: `${LANES_FILE} must be a YAML sequence of lanes, got ${typeof data === "object" ? "a mapping" : typeof data}. No lane could be read from it; nothing was rewritten.`,
        },
      ],
    };
  }

  const lanes: WorkspaceLane[] = [];
  const malformed: UnreadableItem[] = [];
  const entries: LaneEntry[] = [];
  data.forEach((row, i) => {
    const parsed = WorkspaceLane.safeParse(row);
    if (parsed.success) {
      lanes.push(parsed.data);
      entries.push({ row, lane: parsed.data });
      return;
    }
    entries.push({ row, lane: null });
    // The row's own `key` when it still has a readable one, so the human is told
    // WHICH lane rather than which array index.
    const key =
      row !== null && typeof row === "object" && typeof (row as { key?: unknown }).key === "string"
        ? (row as { key: string }).key
        : `${LANES_FILE}[${i}]`;
    malformed.push({
      id: key,
      reason: `lane row ${i} in ${LANES_FILE} could not be read (${parsed.error.issues.map((s) => `${s.path.join(".") || "<row>"}: ${s.message}`).join("; ")}); it is SKIPPED and every other lane is unaffected. Its items are in no stack until the row is fixed — nothing was deleted and nothing was rewritten.`,
    });
  });
  return { lanes, malformed, entries };
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
      `AD-7: packet.yaml's \`schemaVersion\` must be a finite number, got ${Number.isNaN(stamped) ? "NaN" : stamped === Infinity || stamped === -Infinity ? String(stamped) : JSON.stringify(stamped)}. ` +
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
//
// `id` IS AN ADDRESS, NOT ALWAYS AN ITEM ID. The channel also carries the lane
// rows readLanesReport had to skip, addressed by the row's own `key` when it
// still has a readable one and by `lanes.yaml[<index>]` when it does not — a
// broken lane row has no item id to give, and inventing one would be worse than
// naming the file. The type is not renamed because the reader of the MCP payload
// is a model reading English, and "unreadable" is the true word for both.
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
    // DIRECTORIES ONLY, through the house `withFileTypes` form (bundle.ts,
    // spec-lint.ts, readPacketAttachments below). AN ITEM IS A DIRECTORY: a
    // stray FILE in packets/ — `.DS_Store`, a `.tmp` from an interrupted write,
    // a note someone dropped there — is not a malformed item, and reporting it
    // to the model as an unreadable ITEM told the user one of their tasks was
    // corrupt when nothing of theirs was involved.
    ids = fs
      .readdirSync(packetsRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
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

  // The two structural faults, reported here and dropped by queueSlice — plus
  // any lane ROW the tolerant reader had to skip, which is the diagnostic
  // channel that keeps readLanesReport's per-row tolerance from being silently
  // lossy. A lane the human broke is exactly as reportable as a packet they
  // broke, and this is the one place either gets said out loud.
  const laneRead = readLanesReport();
  unreadable.push(...laneRead.malformed);
  const readable = new Set(items.map((i) => i.id));
  // id → the lane whose stack claimed it FIRST, so the reason text can tell a
  // duplicate ACROSS two lanes from a line pasted twice inside ONE. The old text
  // asserted "more than one lane stack" for both, which sent a human looking for
  // a second lane that does not exist.
  const placed = new Map<string, string>();
  for (const lane of laneRead.lanes) {
    for (const id of lane.items) {
      const first = placed.get(id);
      if (first !== undefined) {
        unreadable.push({
          id,
          reason:
            first === lane.key
              ? `listed TWICE in lane "${lane.key}" — one id, two lines in the same stack, not two lanes; the FIRST line wins and this one is ignored`
              : `listed in more than one lane stack (first in "${first}", again in "${lane.key}"); the FIRST stack in lanes.yaml order wins and this occurrence is ignored`,
        });
        continue;
      }
      placed.set(id, lane.key);
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
// THE WRITERS ARE writeLanes, createItem AND updateItem — all three, and the
// third is not optional. lanes.yaml owning membership, reconciliation being
// projection-only, and `lane` being patchable cannot all stand with a
// packet-only updateItem: the tool would report the new lane, every read would
// keep reporting the old one, and the stale hint would sit in the packet as a
// LATENT RELOCATION — remove the id from every stack later (a hand-edit, or a
// lane retired) and arm 1 would adopt the item into a lane no write ever placed
// it in. So a lane change moves the id in lanes.yaml too, in the order below.
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

// Put `id` in the stack at `targetIndex` and NOWHERE ELSE, returning the rows to
// write. Operates on the RAW rows so a row this build could not parse survives
// the write byte-for-byte (see readLanesReport's `entries`).
//
// THE FIRST ROW WITH THE TARGET KEY WINS, and appending to every matching row
// would be the store MANUFACTURING the duplicate-id fault arm 4 exists to report
// — a hand-edited lanes.yaml with two rows keyed `office` would otherwise make
// createItem write the same id into both stacks and then blame the human for it.
// Every other row has the id REMOVED, which is the half that makes a move a move
// rather than a copy, AND is the half that dedupes a hand-edited paste.
//
// THE TARGET ROW KEEPS ITS ORDER IF IT ALREADY HOLDS THE ID. Removing and
// re-appending would send the item to the BOTTOM of the lane it is already in —
// a queue-position change nobody asked for, and one that a duplicate elsewhere
// in the file would otherwise trigger on a call meant to be a no-op.
//
// A NEGATIVE targetIndex means no row carries the target key: the id is removed
// from every stack and added to none, so the item is unfiled (arm 3), a resting
// state. NO LANE IS CREATED — NFR-OW-10 reserves lane structure to the human,
// and a store that invented a row here would hand every agent a lane-creation
// path by side effect. `updateItem` never asks for that case; only createItem's
// brand-new id can reach it, and a brand-new id is in no stack to be evicted
// from.
const rowItems = (row: unknown): unknown[] | null => {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const items = (row as { items?: unknown }).items;
  return Array.isArray(items) ? items : null;
};

function placeIdInRows(entries: LaneEntry[], id: string, targetIndex: number): unknown[] {
  return entries.map(({ row }, i) => {
    const items = rowItems(row);
    if (i === targetIndex) {
      if (items === null) return row; // cannot append to a row with no stack
      return items.includes(id) ? row : { ...(row as object), items: [...items, id] };
    }
    // The id is removed even from a row this build could not fully parse, as
    // long as its `items` is a list — the row keeps every one of its own keys,
    // including the broken or unknown ones, so the human's file is repaired by
    // them and never by this.
    if (items === null || !items.includes(id)) return row;
    return { ...(row as object), items: items.filter((x) => x !== id) };
  });
}

// Writes the RAW rows — see placeIdInRows. Separate from writeLanes below, which
// takes parsed lanes and is the hand-edit/caller-supplied path.
function writeLaneRows(rows: unknown[]): void {
  atomicWrite(lanesFile(), YAML.stringify(rows));
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
  const read = readLanesReport();
  const lanes = read.lanes;
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
  // If the seed lane was retired there is no row to receive the id and the item
  // is simply unfiled (arm 3). No lane is created to receive it — that would be
  // the agent lane-structure change NFR-OW-10 forbids, and no write happens at
  // all, so a file full of rows this build cannot read is not rewritten either.
  const targetIndex = read.entries.findIndex((e) => e.lane?.key === lane);
  if (targetIndex >= 0) writeLaneRows(placeIdInRows(read.entries, item.id, targetIndex));
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

  // THE ADDRESS IS THE DIRECTORY, NEVER THE CONTENT. writePacket resolves its
  // path from the item's own `id`, so a hand-edited packet.yaml whose `id` no
  // longer matches the directory it sits in would make this write to a DIFFERENT
  // item's directory and report success — clobbering a second item the caller
  // never named. AD-6 invites the hand-edit, so the mismatch has to be diagnosed
  // rather than assumed away. It THROWS: the surface turns it into an actionable
  // sentence, where a silent null would read as "no such item".
  if (current.id !== id) {
    throw new Error(
      `AD-6: packets/${id}/${PACKET_FILE} carries \`id: ${JSON.stringify(current.id)}\`, which is not the directory it sits in. ` +
        `A packet's ADDRESS is its directory; writing this update would rewrite packets/${current.id}/${PACKET_FILE} instead, ` +
        `clobbering an item nobody named. Nothing was written. Fix the \`id:\` line by hand, or move the directory.`,
    );
  }

  // A LANE CHANGE IS A TWO-FILE MOVE, and lanes.yaml is the half that decides.
  // D9 gives lanes.yaml authority over membership and order; packet.lane is the
  // recovery hint. A packet-only write would therefore be a PERMANENT SILENT
  // NO-OP dressed as success — the tool would report the new lane, every read
  // would keep reporting the old one, and the stale hint would sit there as a
  // latent relocation waiting for the id to leave its stack.
  //
  // AN UNRESOLVABLE LANE KEY NEVER MOVES THE ITEM, and this is where update
  // deliberately DIVERGES from create. A create has no home yet, so an unknown
  // key has to resolve somewhere and the seed lane is that somewhere. An update
  // has a home. Redirecting a typo'd `laneKey` into the seed lane would EVICT an
  // already-filed item from the user's queue on a model's spelling mistake — and
  // where the seed lane has been retired it would evict the item into NO stack
  // at all, where it appears in no queue, on no desk, and in no report. So the
  // item stays exactly where it is, `unplaced` marks it for the user, and the
  // surface says which key did not exist.
  //
  // A SUCCESSFUL move CLEARS `unplaced`, unless the caller named it in the same
  // patch. item-model.md's meaning is "the master could not file it and is
  // asking"; once it IS filed, leaving the flag on would keep the desk asking a
  // question that has been answered — and deskSlice's hint chain puts `unplaced`
  // first, so it would mask the item's deadline forever.
  const read = readLanesReport();
  const targetIndex =
    patch.lane === undefined ? -1 : read.entries.findIndex((e) => e.lane?.key === patch.lane);
  const resolved = patch.lane !== undefined && targetIndex >= 0;
  const unresolvable = patch.lane !== undefined && targetIndex < 0;

  // Spread order matters: `current` first, so every field the patch does not
  // name — including every UNKNOWN key z.looseObject preserved off disk —
  // survives the rewrite untouched.
  const next = Item.parse({
    ...current,
    ...patch,
    ...(unresolvable
      ? {
          // Stay put. The hint is re-pinned to the stack that actually holds the
          // item, so the packet and lanes.yaml still agree at this commit point.
          lane: read.lanes.find((l) => l.items.includes(id))?.key ?? current.lane,
          unplaced: true,
        }
      : {}),
    ...(resolved ? { lane: patch.lane, unplaced: patch.unplaced ?? false } : {}),
    schemaVersion: ITEM_SCHEMA_VERSION,
  });

  // PACKET FIRST, LANES SECOND — the order D9 pins, and the reason a torn write
  // is safe: the id is still in its old stack, the orphan arm does not fire, and
  // the move simply did not happen.
  writePacket(next);
  if (resolved) {
    const moved = placeIdInRows(read.entries, id, targetIndex);
    // NOTHING IS REWRITTEN WHEN NOTHING MOVED. placeIdInRows returns the SAME row
    // reference for a row it did not touch — including the target row when it
    // already holds the id — so this is an exact "did any stack change" test,
    // and a move to the lane the item is already in leaves the user's
    // hand-formatted lanes.yaml byte-identical rather than re-ranking it.
    if (moved.some((row, i) => row !== read.entries[i]!.row)) writeLaneRows(moved);
  }
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
// item: every STACKED item first, in lane order then stack order, and THEN every
// adopted orphan, appended after all of them and ordered by id.
//
// SO THE ROWS ARE NOT GLOBALLY IN LANE ORDER whenever an orphan is adopted — an
// orphan bound for the first lane still comes after the last lane's stacked
// rows. The RANKS are correct either way, because ranking runs last and per
// lane; it is the row SEQUENCE that is two concatenated passes. Said plainly
// because the previous sentence here promised one order and delivered another,
// and a caller rendering rows in array order would have got it wrong.
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
// 5.1 SHIPS THIS PROJECTION AND NO RAIL. The rail is 5.3's.
//
// DISMISSAL IS updateItem({desk: false}) AND update_item DOES EXPOSE IT — a
// DISCLOSED WIDENING, corrected here because this comment previously claimed the
// opposite while the tool's own input shape and description said otherwise, and
// a false negative in a comment is worse than the widening it hides. It is
// harmless in the way that matters: dismissal DRAINS THE ITEM TO THE QUEUE and
// deletes nothing (SPEC.md's "No deletion path" is untouched), the item keeps
// its lane and its rank, and 5.3's rail needs the verb to exist. What 5.1 does
// not ship is the RAIL that calls it.
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
// NOT AN ATTACHMENT: this store's OWN crash residue, and the operating system's.
// atomicWrite writes `<file>.tmp` and renames; a crash between the two leaves the
// .tmp behind, and the tally would then report the user's own failed write back
// to them as "1 file". `.DS_Store` is Finder's, and a user who opened the packet
// directory once should not be told they attached something.
const isNotAnAttachment = (name: string): boolean =>
  name === PACKET_FILE || name === ".DS_Store" || name.endsWith(".tmp");

export function attachmentTally(names: string[]): { files: number; mockups: number } {
  let files = 0;
  let mockups = 0;
  for (const name of names) {
    if (isNotAnAttachment(name)) continue;
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
      .filter((n) => !isNotAnAttachment(n))
      .sort();
  } catch {
    return [];
  }
}
