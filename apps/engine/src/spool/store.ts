/**
 * The Spool store: the ONE owning module for `<engineRoot>/spool`, and the only
 * thing in the engine that reads or writes it.
 *
 * Ported from `packages/core/src/workspace/store.ts`. Three deviations from that
 * donor, each forced by where this now lives and each named in
 * `docs/spool-port.md`:
 *
 *   1. THE ROOT ARRIVES AS AN ARGUMENT. The donor resolved a global
 *      `telarDir()`; every verb here takes `SpoolPaths` first, which is the
 *      engine's own discipline (`files.ts`, `gitignore.ts`) and what lets a test
 *      drive a temp directory without touching the process environment.
 *   2. JSON, NOT YAML. The engine has one document writer and it serializes
 *      JSON; adding a YAML dependency to preserve a file extension would buy
 *      hand-editability of a store that nothing outside may reach into anyway.
 *      Every other property `item-model.md` fixes still holds exactly: structure
 *      and content separate, one shape for all items, atomic writes, nothing
 *      outside reaches in.
 *   3. THE SHAPES COME FROM THE PROTOCOL. `@telar/engine-client`'s
 *      `protocol/spool.ts` owns them, because in this architecture the persisted
 *      shape and the wire shape are one definition — the same rule `state.ts`
 *      already follows for `Session` and `Task`.
 *
 * ── WHY THIS IS A PORT AND NOT A DIRECTORY SESSIONS CAN REACH ────────────────
 * CAP-12 says items "are not the Workspace surface's private data" — every
 * session anywhere in Telar must be able to read and file them. File access
 * cannot be how: Codex's sandbox write boundary is purely path-based (working
 * root plus `--add-dir`), a project session's root is its own repo, and granting
 * every session an `--add-dir` onto this store would widen each one's write
 * boundary across all projects' items — the opposite of the isolation the rest
 * of the system maintains. So the store is reached through Telar's own MCP tool
 * surface and through nothing else. That is not a restriction bolted onto the
 * design; it is the reason the design exists.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SPOOL_DIGEST_SCHEMA_VERSION,
  SPOOL_ITEM_SCHEMA_VERSION,
  SpoolExpectation,
  SpoolExpertDigest,
  SpoolSelfMemory,
  type SpoolDigestTerm,
  type SpoolMemoryFact,
  SpoolItem,
  SpoolLane,
  type SpoolAttachmentTally,
  SpoolDeadline,
  type SpoolPin,
  type SpoolDeskCard,
  type SpoolQueueRow,
  type SpoolSubjectGroup,
  type SpoolSubjectRow,
  type SpoolUnreadable,
} from "@telar/engine-client";
import { atomicWrite } from "../atomic";

// ── the layout ──────────────────────────────────────────────────────────────

/**
 * Every path this module owns, resolved once from the engine's state root.
 *
 * A RECORD RATHER THAN FIVE RESOLVERS, matching `EngineStatePaths` next door: a
 * caller that needs to NAME one of these — the master session's cwd, or the two
 * entries a session must not be able to rewrite with a file tool — gets it from
 * here rather than composing `<root>/spool/lanes.json` of its own. A second,
 * unowned site for the layout is how the two drift.
 */
export type SpoolPaths = {
  /** `<engineRoot>/spool`. */
  root: string;
  /**
   * The master session's dedicated cwd. It holds NO store files, and
   * `ensureSpool` asserts that by construction: `lanes.json` and `packets/` are
   * siblings of `home/`, never children.
   *
   * THAT LAYOUT IS NOT THE BOUNDARY, and saying so is the correction the donor
   * had to make after a review measured it: siblings are reachable by
   * `../lanes.json`, and a write tool is one "always allow" away. The layout
   * defeats a RELATIVE-PATH ACCIDENT and nothing more. The boundary has to be a
   * MECHANISM — `storeEntries` below names what it must cover — and building it
   * is stage F of `docs/spool-port.md`, not this file's to claim.
   */
  home: string;
  /** Lane definitions and their ordered id stacks. */
  lanes: string;
  /** One directory per item, each holding `packet.json` plus attachments. */
  packets: string;
  /**
   * The per-project expert digests.
   *
   * DELIBERATELY NOT IN `storeEntries`, and that absence is a decision rather
   * than an omission: a path-protection mechanism denies READS as well as
   * writes, and the master is REQUIRED to read digests — that is the whole of
   * what "experts write, master reads" means. Protecting them would deny the one
   * access the master's design depends on. The ITEM data stays protected; the
   * expert's prose memory is readable.
   */
  experts: string;
};

export function spoolPaths(engineRoot: string): SpoolPaths {
  const root = path.join(engineRoot, "spool");
  return {
    root,
    home: path.join(root, "home"),
    lanes: path.join(root, LANES_FILE),
    packets: path.join(root, "packets"),
    experts: path.join(root, "experts"),
  };
}

/**
 * THE STORE'S OWN ENTRIES — the item data a session must not be able to rewrite
 * with a file tool, as opposed to through the tool surface where the
 * human-accept moat lives.
 *
 * `home/` is deliberately not here: it is the master's cwd, and protecting a
 * session's own working directory would deny every write it is meant to make.
 */
export function storeEntries(paths: SpoolPaths): readonly string[] {
  return [paths.lanes, paths.packets];
}

/** The filenames, as values, because the writer, the reader and every
 *  diagnostic that NAMES a file to a human have to agree about them. */
const LANES_FILE = "lanes.json";
const PACKET_FILE = "packet.json";
const DIGEST_FILE = "digest.json";

/**
 * The traversal guard. THE REGEX PLUS THE CONTAINMENT RE-CHECK, and the donor
 * measured why both: with the regex deleted, `../escaped` still throws on the
 * re-check; with BOTH deleted, a readable packet planted outside `packets/`
 * becomes reachable by id. The re-check cannot FIRE while the regex stands — and
 * it is the half that holds if the regex ever goes.
 *
 * This is the one place an item id reaches the filesystem. It THROWS; every
 * reader below catches and treats a bad id as not-found, never as a 500.
 */
function packetDir(paths: SpoolPaths, id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid spool item id: ${JSON.stringify(id)}`);
  }
  const base = paths.packets;
  const dir = path.join(base, id);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!dir.startsWith(withSep)) throw new Error(`invalid spool item id: ${JSON.stringify(id)}`);
  return dir;
}

const packetFile = (paths: SpoolPaths, id: string) => path.join(packetDir(paths, id), PACKET_FILE);

/**
 * `packetDir`'s guard applied to a project slug — the second place a
 * caller-supplied name reaches the filesystem, and it gets the same treatment
 * rather than a weaker one. A project name is a registry key the user types, so
 * `../../` in one is not hypothetical. THROWS; `readExpertDigest` catches and
 * reports "no digest", `writeExpertDigest` lets it out (a write to a name this
 * store cannot address must be loud).
 */
function expertDigestDir(paths: SpoolPaths, project: string): string {
  if (typeof project !== "string" || !/^[A-Za-z0-9_.-]+$/.test(project) || project.startsWith(".")) {
    throw new Error(`invalid project for an expert digest: ${JSON.stringify(project)}`);
  }
  const base = paths.experts;
  const dir = path.join(base, project);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!dir.startsWith(withSep)) {
    throw new Error(`invalid project for an expert digest: ${JSON.stringify(project)}`);
  }
  return dir;
}

/** Exported because a surface has to be able to SAY where a digest is, and a
 *  caller composing the path itself would be a second unowned site for a layout
 *  this module owns. */
export function expertDigestPath(paths: SpoolPaths, project: string): string {
  return path.join(expertDigestDir(paths, project), DIGEST_FILE);
}

/**
 * MINTED, NEVER DERIVED FROM POSITION: an id derived from a lane index or a
 * count breaks the moment the stack is reordered, and reordering is the one
 * operation this store exists to make cheap.
 */
const newItemId = () => `i-${crypto.randomBytes(6).toString("hex")}`;

/**
 * Same shape, different prefix. NOT the same generator as the migration
 * ladder's, which derives an id from content because it is backfilling ids for
 * sub-tasks that already existed with none. A sub-task minted here always has an
 * id already, so there is nothing to derive.
 */
const newSubtaskId = () => `st-${crypto.randomBytes(6).toString("hex")}`;

/**
 * Same generator again, for a mined time-commitment. It needs an id for the same
 * reason a sub-task does: gap detection has to be able to say WHICH commitment a
 * briefing line is about, across passes, and the text is not a stable address —
 * an expert re-reading the same capture may quote it slightly differently.
 */
const newExpectationId = () => `x-${crypto.randomBytes(6).toString("hex")}`;

// ── the seed lane ───────────────────────────────────────────────────────────

/**
 * Filing needs "the right lane" to file into; no TOOL may create one; lane
 * structure is reserved to the human; and no spec source supplies a default set
 * ("lanes are data, never an enum"). The resolution is that the STORE's ensure
 * step seeds exactly one ordinary lane row — and the store is not a tool. That
 * distinction is the whole of what makes it legal.
 *
 * RENAME CARRIES NO SPECIAL BEHAVIOUR: it is renameable like any other row, and
 * nothing re-creates it under its old label. `resolveLane` uses this KEY, never
 * the label, as its fallback target, and `renameLane` can only ever rewrite
 * `label` — so a rename can never silently redirect where an unresolvable
 * capture lands.
 *
 * RETIRE IS THE ONE PLACE THIS ROW DOES CARRY SPECIAL BEHAVIOUR. `createItem`
 * never fails to resolve SOME target, so if this row could be retired out from
 * under that fallback the very next unresolvable capture would mint an item
 * naming a row that no longer exists — invisible on the queue, present only in
 * `listItems`. That is a strictly worse resting state than "unfiled, in the
 * Unfiled lane", so retiring this one row is refused. Every OTHER lane retires
 * exactly as documented, no special case.
 */
const SEED_LANE_KEY = "unfiled";

/**
 * `note` IS STRUCTURAL PROVENANCE, and this one is shortened from the donor's
 * deliberately. The donor wrote "created by the workspace store on first use —
 * rename, split or retire it like any other lane", which is two things: a
 * provenance clause and an instruction. Rendering it proved the problem — the
 * queue's group header shouted the whole sentence and truncated it mid-word —
 * and the instruction half also breaks the tone law, which is that surfaces show
 * state and data with no suggestion-text. What is left is the true half.
 */
const seedLane = (): SpoolLane => ({
  key: SEED_LANE_KEY,
  label: "Unfiled",
  window: "whenever",
  note: "created on first use",
  items: [],
});

// ── display labels: the one place a clock is read, and why it is not a clock ──

/**
 * The module bans clocks and scheduling: order is stack position, `captured` is
 * a display label, `deadline.label` is coarse human text and never a date to
 * compare. This store makes no decision on time — it never parses, compares,
 * sorts or buckets any of these strings.
 *
 * What it does need is a human-readable label for "when this entered", because
 * the shape contract requires the field. Reading the wall clock ONCE to produce
 * that text is the honest implementation; refusing to would mean writing a label
 * that is permanently wrong. Deliberately NOT `toLocaleString` — that would make
 * the stored bytes depend on the host's locale and timezone database.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const two = (n: number) => String(n).padStart(2, "0");
export function capturedLabel(at: Date): string {
  return `${WEEKDAYS[at.getDay()]} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

// ── ensure ──────────────────────────────────────────────────────────────────

/**
 * Idempotent and safe to re-enter. Creates the subtree, creates the master's
 * dedicated `home/`, and seeds the one lane IF AND ONLY IF `lanes.json` does not
 * exist — so a user who retires the seed lane does not get it back on the next
 * write.
 */
export function ensureSpool(paths: SpoolPaths): void {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.packets, { recursive: true });
  if (!fs.existsSync(paths.lanes)) writeLanes(paths, [seedLane()]);
}

// ── lanes.json ──────────────────────────────────────────────────────────────

/** `[]` when the file is absent or unreadable — never a throw. A store that has
 *  never been written is the ordinary first-run state, not an error. */
export function readLanes(paths: SpoolPaths): SpoolLane[] {
  return readLanesReport(paths).lanes;
}

/**
 * TOLERANCE IS PER ROW, NOT PER FILE, and the difference is the whole premise.
 * `SpoolLane.array().safeParse` — the obvious spelling — is ALL-OR-NOTHING: a
 * human who hand-edits `lanes.json` and drops `window` from ONE of five rows
 * gets `[]` back, which means their entire lane structure disappears from every
 * read and every subsequent create silently accumulates in no stack at all. So
 * the reader keeps every row it can make sense of and REPORTS the ones it
 * cannot.
 *
 * THE REPORT IS THE OTHER HALF, and without it "tolerant" would be
 * indistinguishable from "silently lossy". `listItems` folds `malformed` into
 * its `unreadable` channel, so the human is told which row is wrong instead of
 * watching a lane vanish.
 *
 * `entries` IS THE THIRD HALF, AND IT IS THE ONE THAT MAKES TOLERANCE SAFE. A
 * partial READ that is then written back is a partial DELETE: the writers
 * rewrite the whole file, so handing them `lanes` — which excludes the skipped
 * row — would permanently erase that row and every item id in it on the very
 * next capture, silently, and the report would then go quiet because there is
 * nothing left to report. That is strictly worse than the all-or-nothing read it
 * replaced. So the writers take `entries`, which carries EVERY row in file order
 * — the ones this build understood and the raw shape of the ones it did not —
 * and they write those RAW rows back.
 */
export type SpoolLaneEntry = { row: unknown; lane: SpoolLane | null };

export function readLanesReport(paths: SpoolPaths): {
  lanes: SpoolLane[];
  malformed: SpoolUnreadable[];
  entries: SpoolLaneEntry[];
} {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.lanes, "utf8");
  } catch {
    return { lanes: [], malformed: [], entries: [] }; // absent is the ordinary first-run state
  }
  // An empty file is the same state as an absent one. JSON.parse("") throws,
  // where the donor's YAML.parse("") returned null — same outcome, stated here
  // because the serializer changed and this is the one place it shows.
  if (raw.trim() === "") return { lanes: [], malformed: [], entries: [] };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return {
      lanes: [],
      entries: [],
      malformed: [
        {
          id: LANES_FILE,
          reason: `${LANES_FILE} is not valid JSON (${e instanceof Error ? e.message : String(e)}), so no lane could be read from it. Every item keeps its packet; nothing was rewritten. Fix the file by hand.`,
        },
      ],
    };
  }
  if (data === null || data === undefined) return { lanes: [], malformed: [], entries: [] };
  if (!Array.isArray(data)) {
    return {
      lanes: [],
      entries: [],
      malformed: [
        {
          id: LANES_FILE,
          reason: `${LANES_FILE} must be a JSON array of lanes, got ${typeof data === "object" ? "an object" : typeof data}. No lane could be read from it; nothing was rewritten.`,
        },
      ],
    };
  }

  const lanes: SpoolLane[] = [];
  const malformed: SpoolUnreadable[] = [];
  const entries: SpoolLaneEntry[] = [];
  data.forEach((row, i) => {
    const parsed = SpoolLane.safeParse(row);
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
      reason: `lane row ${i} in ${LANES_FILE} could not be read (${parsed.error.issues
        .map((s) => `${s.path.join(".") || "<row>"}: ${s.message}`)
        .join("; ")}); it is SKIPPED and every other lane is unaffected. Its items are in no stack until the row is fixed — nothing was deleted and nothing was rewritten.`,
    });
  });
  return { lanes, malformed, entries };
}

/** Writes the STORED stacks, never a reconciled projection — see "the reconcile
 *  rule" below for why that distinction is load-bearing rather than pedantic. */
export function writeLanes(paths: SpoolPaths, lanes: SpoolLane[]): void {
  atomicWrite(paths.lanes, lanes);
}

// ── migrate-on-read ─────────────────────────────────────────────────────────

/**
 * A schema version and a real migrate-on-read belong on stores holding
 * unrecoverable human input, and a packet is that "above all" — it holds `raw`
 * verbatim.
 *
 * PURE, EXPORTED AND DISK-FREE so the five behaviours below can be tested
 * without a filesystem. It runs BEFORE `SpoolItem.parse`.
 *
 * THE FIVE BEHAVIOURS, each its own test:
 *   absent    → normalised to 1 BEFORE any comparison. The common case for a
 *               hand-authored packet; treating it as malformed would make every
 *               hand-written one unreadable.
 *   lower     → migrated up the ladder, then parsed.
 *   equal     → RETURNED UNTOUCHED. This is the discriminator: without it, a
 *               migrate that rewrites everything on every read passes every
 *               other test.
 *   higher    → THROWS. Never migrated down, never defaulted. The file was
 *               written by a newer Telar and holds `raw` verbatim, which has no
 *               source to be rebuilt from — guessing at it is exactly how the
 *               field this mechanism protects gets destroyed.
 *   malformed → throws, same shape.
 *
 * THE REPORT CHANNEL, pinned because "reported" has two readings and one is
 * forbidden: this THROWS; `getSpoolItem` catches and returns null; and
 * `listItems` surfaces the reason through its `unreadable` array, so one bad
 * packet never blanks the other ninety-nine.
 */
export function migratePacket(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `a ${PACKET_FILE} must be a JSON object, got ${raw === null ? "null" : Array.isArray(raw) ? "an array" : typeof raw}. ` +
        `A packet that is not an object cannot carry the \`raw\` fragment this store exists to preserve, so reading it would ` +
        `silently substitute an empty item for the user's own words. Fix the file by hand, or move it aside — it is never rewritten for you.`,
    );
  }
  const obj = raw as Record<string, unknown>;

  // ABSENT NORMALISES FIRST, before any comparison. A hand-authored file with no
  // schemaVersion is a current-shape file, which is the only reading that keeps
  // "a human can edit this" true.
  const stamped = obj.schemaVersion;
  const absent = stamped === undefined || stamped === null;
  const version = absent ? SPOOL_ITEM_SCHEMA_VERSION : stamped;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new Error(
      `${PACKET_FILE}'s \`schemaVersion\` must be a finite number, got ${
        Number.isNaN(stamped) ? "NaN" : stamped === Infinity || stamped === -Infinity ? String(stamped) : JSON.stringify(stamped)
      }. The version is what decides whether this build may read the file at all, so an unreadable version means the read ` +
        `cannot be made safe. Set it to ${SPOOL_ITEM_SCHEMA_VERSION} if the file matches this build's shape, or remove the key entirely.`,
    );
  }

  if (version > SPOOL_ITEM_SCHEMA_VERSION) {
    throw new Error(
      `${PACKET_FILE} is at schemaVersion ${version}; this build of Telar understands ${SPOOL_ITEM_SCHEMA_VERSION}. ` +
        `A packet written by a newer Telar holds \`raw\` and \`rawSource\` verbatim and has no source to be rebuilt from, so ` +
        `reading it under an older shape and rewriting it would destroy fields this build cannot see. ` +
        `Upgrade Telar to open this item — the file is left exactly as it is.`,
    );
  }

  // EQUAL IS THE IDENTITY — but only when the version was EXPLICITLY equal.
  // Returning the same reference is what makes "migration did not touch it"
  // observable in a test rather than merely intended.
  //
  // The ABSENT case is deliberately NOT the identity: normalisation has to be
  // visible in the returned shape, or "normalised to 1 before any comparison" is
  // a claim nothing can check.
  if (version === SPOOL_ITEM_SCHEMA_VERSION) return absent ? { ...obj, schemaVersion: SPOOL_ITEM_SCHEMA_VERSION } : raw;

  // ── the ladder ──
  // One rung long today, and written as a ladder anyway: a migration authored
  // under pressure later, against a mechanism that has never run, is how `raw`
  // gets destroyed.
  let shape: Record<string, unknown> = { ...obj, schemaVersion: version };
  for (let v = version; v < SPOOL_ITEM_SCHEMA_VERSION; v++) {
    const rung = LADDER[v];
    if (!rung) {
      throw new Error(
        `${PACKET_FILE} is at schemaVersion ${v}, and this build has no migration from ${v} to ${v + 1}. ` +
          `Migrating past a gap would mean guessing at a shape nobody wrote down, against a file holding \`raw\` verbatim. ` +
          `The file is left exactly as it is; the missing rung belongs in apps/engine/src/spool/store.ts's LADDER.`,
      );
    }
    shape = { ...rung(shape), schemaVersion: v + 1 };
  }
  return shape;
}

/**
 * 0 → 1: sub-tasks gain an id.
 *
 * THE RUNG IS REAL, not a placeholder. Version 0 is the shape the design-source
 * fixtures describe (their sub-tasks are `{title, done?}` with NO id), so a human
 * transcribing a packet from the mockups writes exactly that. Version 1 adds the
 * id, because `promotedFrom` names a parent item and a title is not an address —
 * a rename or a duplicate breaks the reference.
 *
 * The minted id is DERIVED FROM CONTENT, not from position: a sha1 over
 * `[itemId, title, occurrence]`, where `occurrence` disambiguates two sub-tasks
 * that genuinely share a title. It is minted ONCE, here, and then persisted —
 * after which reordering never re-derives it.
 */
const LADDER: Record<number, (o: Record<string, unknown>) => Record<string, unknown>> = {
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

// ── reading items ───────────────────────────────────────────────────────────

/**
 * `null` on absent, on a malformed/traversal id, and on an unreadable or
 * version-ahead packet. NEVER THROWS — a caller that needs the REASON reads
 * `listItems`' `unreadable` channel instead.
 *
 * MIGRATE-ON-READ WRITES NOTHING BACK. A read that writes would make a
 * version-ahead file unrecoverable on the very read that was supposed to protect
 * it. The migrated shape lands on the next legitimate write, and the test
 * asserts the file's CONTENT HASH is unchanged across a read.
 */
export function getSpoolItem(paths: SpoolPaths, id: string): SpoolItem | null {
  let file: string;
  try {
    file = packetFile(paths, id);
  } catch {
    return null;
  }
  try {
    return SpoolItem.parse(migratePacket(JSON.parse(fs.readFileSync(file, "utf8"))));
  } catch {
    return null;
  }
}

/**
 * Every readable packet, plus everything the store could not make sense of.
 *
 * TWO CHANNELS, ONE CALL, because a caller that only got `items` would have no
 * way to tell "the user has three items" from "the user has three items and two
 * unreadable ones". A spool item is the user's own words and losing one silently
 * is the failure mode the version mechanism exists to prevent.
 *
 * It also reads `lanes.json`, which a pure item lister would not need — that is
 * what makes the two structural faults (a stack id with no readable packet; the
 * same id pasted into two stacks) reportable at all. `queueSlice` DROPS both from
 * the projection; this is where a human is told they happened.
 */
export function listItems(paths: SpoolPaths): { items: SpoolItem[]; unreadable: SpoolUnreadable[] } {
  let ids: string[] = [];
  try {
    // DIRECTORIES ONLY. AN ITEM IS A DIRECTORY: a stray FILE in `packets/` — a
    // `.DS_Store`, a `.tmp` from an interrupted write, a note someone dropped
    // there — is not a malformed item, and reporting it as an unreadable ITEM
    // told the user one of their tasks was corrupt when nothing of theirs was
    // involved.
    ids = fs
      .readdirSync(paths.packets, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { items: [], unreadable: [] }; // no store yet
  }

  const items: SpoolItem[] = [];
  const unreadable: SpoolUnreadable[] = [];
  for (const id of ids.slice().sort()) {
    let file: string;
    try {
      file = packetFile(paths, id);
    } catch {
      unreadable.push({ id, reason: "not a valid item id (a packet directory name must be [A-Za-z0-9_-]+)" });
      continue;
    }
    if (!fs.existsSync(file)) continue; // a directory with no packet.json is not an item
    try {
      items.push(SpoolItem.parse(migratePacket(JSON.parse(fs.readFileSync(file, "utf8")))));
    } catch (e) {
      unreadable.push({ id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // The two structural faults, reported here and dropped by queueSlice — plus
  // any lane ROW the tolerant reader had to skip, which is the diagnostic
  // channel that keeps per-row tolerance from being silently lossy. A lane the
  // human broke is exactly as reportable as a packet they broke, and this is the
  // one place either gets said out loud.
  const laneRead = readLanesReport(paths);
  unreadable.push(...laneRead.malformed);
  const readable = new Set(items.map((i) => i.id));
  // id → the lane whose stack claimed it FIRST, so the reason text can tell a
  // duplicate ACROSS two lanes from a line pasted twice inside ONE.
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
              : `listed in more than one lane stack (first in "${first}", again in "${lane.key}"); the FIRST stack in ${LANES_FILE} order wins and this occurrence is ignored`,
        });
        continue;
      }
      placed.set(id, lane.key);
      if (!readable.has(id)) {
        unreadable.push({
          id,
          reason: `listed in lane "${lane.key}" but has no readable packet; it is shown nowhere until the packet is readable again, and its id is NEVER removed from ${LANES_FILE}`,
        });
      }
    }
  }

  return { items, unreadable };
}

// ── writing items ───────────────────────────────────────────────────────────

/**
 * The creation input.
 *
 * `creationNote` IS A DISCLOSED ADDITION, and it is what makes the pinned design
 * implementable at all. No `sessionId` field is added to the item — "the
 * session's identity is carried by the creation timeline event's `text`", and
 * the tool surface composes that text server-side. With no channel for it the
 * ruling has nowhere to land. The field carries TEXT ONLY: the store owns the
 * event's `at` and `actor`, so a caller cannot forge an actor or backdate an
 * entry.
 */
export type NewSpoolItem = {
  title: string;
  project?: string;
  lane?: string;
  raw?: string;
  rawSource?: string;
  creationNote?: string;
  /**
   * WHOSE HAND FILED IT — the workbench correction. `provenance` stays written
   * server-side and free-form, but its one stamp ("session") became a LIE the
   * day the human API grew a form: a hand-made item was counted into the
   * footer's "agents added N". This field is which of the two known stamps the
   * server writes, decided by the CALLING SURFACE (the daemon's human route
   * defaults it to "you"; the tool wall declares "session") — never by a
   * model's input, whose tool shape cannot name it. Absent means "session",
   * which keeps every direct store caller and every existing packet exactly
   * as it was: the 13 items filed before this field existed WERE agent-filed,
   * and they keep counting.
   */
  source?: "session" | "you";
  /** Legal at creation under §3.2's quoting law: the label is a QUOTE from a
   *  source — an issue's milestone date, the user's own words — never a value
   *  a clock resolved. The tool surface restates this where a model reads it. */
  deadline?: SpoolDeadline;
  /** The user's own day for it — human-owned under §3.2 as amended (the
   *  calendar belongs to the human). `assertPin` refuses anything that is not
   *  a strict, real `YYYY-MM-DD`. */
  pinned?: SpoolPin;
  /** Free-text labels in the user's own words — see `SpoolItem.tags`. Gated by
   *  `assertTags`, shared with update and the shelf so the sentence cannot
   *  drift. */
  tags?: string[];
};

/**
 * What an update may change. THE EXCLUSIONS ARE THE CONTRACT, not an oversight:
 * `id`, `raw`, `rawSource`, `schemaVersion`, `promotedFrom`, `tracking`,
 * `subtasks`, `timeline`, `provenance` and `captured` cannot be named here.
 *   - raw/rawSource: "never overwritten"; it is what lets the user check the
 *     expert did not drift from what they meant.
 *   - promotedFrom: "agents have no promotion path, proposed or otherwise". The
 *     field exists on the item; nothing can write it.
 *   - tracking, subtasks, timeline: separate named verbs own those writes.
 *   - schemaVersion: the store decides what version it wrote.
 */
export type SpoolItemPatch = Partial<
  Pick<SpoolItem, "title" | "lane" | "project" | "desk" | "unplaced" | "mirrored"> & {
    deadline: SpoolDeadline;
    /** `{day}` sets, an EXPLICIT `null` clears. A clear removes the PIN and
     *  nothing else — the item stays, so "no deletion path" is untouched. */
    pinned: SpoolPin | null;
    /** The WHOLE list, replaced — `[]` clears to absence. Tags are identity
     *  the user states, so a patch carries their current statement whole
     *  rather than diffing it. */
    tags: string[];
  }
>;

const PATCHABLE = ["title", "lane", "project", "desk", "unplaced", "mirrored", "deadline", "pinned", "tags"] as const;

/**
 * THE TAGS' ONE GATE, shared by item create, item update and the shelf, so the
 * sentence cannot drift between the three writers. Trims, refuses anything that
 * is not a non-empty string, and drops exact duplicates in the user's own
 * order. `[]` in, `[]` out — the CALLER decides that an empty list means
 * absence, because "no tags" is spelled by the missing key, exactly like a pin.
 */
export function assertTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new Error(
      'Tags are a list of short labels in the user\'s own words — `tags: ["facturación", "no tocar"]`. ' +
        "Pass an array of strings; `[]` clears them.",
    );
  }
  const out: string[] = [];
  for (const tag of tags as string[]) {
    const trimmed = tag.trim();
    if (!trimmed) {
      throw new Error("A tag is a word or two, not an empty string. Leave it out instead of passing a blank.");
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * THE PIN'S ONE GATE, shared by create and update so the sentence cannot drift.
 *
 * STRICT `YYYY-MM-DD` AND A REAL CALENDAR DAY, refused loudly otherwise. The
 * strictness is not pedantry — "Friday", "next week", "tomorrow" and epoch
 * numbers are exactly what a model writes the moment it starts RESOLVING dates
 * instead of quoting them, and §3.2 as amended allows the system to hold the
 * user's own dates precisely because it never manufactures one. The round-trip
 * check (parse, then re-format) is what catches "2026-02-30": a UTC Date
 * happily normalises it to March 2nd, and storing the normalised day would be
 * the store rewriting a date the user never said.
 *
 * NOTHING HERE READS A CLOCK. The day is validated as a shape and stored as a
 * quote; no comparison against "today" exists anywhere in this module.
 */
function assertPin(pinned: unknown): SpoolPin {
  const refuse = (got: string): never => {
    throw new Error(
      `A pin is the user's own day, written out: \`pinned: {day: "YYYY-MM-DD"}\` — for example {day: "2026-08-19"}. ` +
        `Got ${got}. The Spool stores the date the user stated and never resolves one, so "Friday", "tomorrow" or a ` +
        `timestamp cannot be a pin — write the actual date, or clear the pin with \`pinned: null\`.`,
    );
  };
  if (pinned === null || typeof pinned !== "object" || Array.isArray(pinned)) return refuse(JSON.stringify(pinned));
  const day = (pinned as { day?: unknown }).day;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return refuse(JSON.stringify(day));
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(
      `"${day}" is not a day on the calendar — there is no such date. A pin is drawn on the day the user named, ` +
        `so a day that does not exist has nowhere to be drawn. Check the month and day, and write the date out as YYYY-MM-DD.`,
    );
  }
  return { day };
}

/**
 * THE ADDRESS IS THE DIRECTORY, NEVER THE CONTENT. Shared by every writer that
 * resolves a packet by id and then writes back to that same id's directory, so
 * every one of them needs the same guard against a hand-edited packet whose `id`
 * no longer matches the directory it sits in. Extracted rather than duplicated,
 * because a guard copied five times is a guard four of those places can drift
 * out of.
 */
function assertPacketAddressMatches(id: string, current: SpoolItem): void {
  if (current.id !== id) {
    throw new Error(
      `packets/${id}/${PACKET_FILE} carries \`id: ${JSON.stringify(current.id)}\`, which is not the directory it sits in. ` +
        `A packet's ADDRESS is its directory; writing this update would rewrite packets/${current.id}/${PACKET_FILE} instead, ` +
        `clobbering an item nobody named. Nothing was written. Fix the \`id\` field by hand, or move the directory.`,
    );
  }
}

// ── the reconcile rule ──────────────────────────────────────────────────────
//
// A TWO-FILE WRITE WITH A RECONCILE RULE INSTEAD OF A TRANSACTION, because
// there is no multi-file transaction here to copy.
//
// AUTHORITY. `lanes.json`'s stacks decide membership AND order. A packet's
// `lane` is a RECOVERY HINT, consulted only when the id appears in NO stack.
// Three things follow, and all three are the reason for the asymmetry:
//   - a hand-edit WINS;
//   - reconcile is idempotent by construction, because it derives from a file
//     nothing but an explicit write changes;
//   - a TORN LANE MOVE IS SAFE. If a writer writes the packet and dies before
//     the lanes write, the id is still in its old stack, the orphan arm does not
//     fire, and the move simply did not happen. No duplicate, no ambiguity.
//
// THE WRITERS ARE writeLanes, createItem AND updateItem — all three, and the
// third is not optional. `lanes.json` owning membership, reconciliation being
// projection-only, and `lane` being patchable cannot all stand with a
// packet-only update: the tool would report the new lane, every read would keep
// reporting the old one, and the stale hint would sit in the packet as a LATENT
// RELOCATION — remove the id from every stack later and arm 1 would adopt the
// item into a lane no write ever placed it in.
//
// WRITE ORDER: the packet FIRST, `lanes.json` SECOND. A crash in the gap leaves
// the content intact (the raw capture is what must survive) with the id not yet
// in a stack — which the orphan arm then adopts. Written the other way round,
// the crash gap would leave `lanes.json` naming an item whose words were never
// saved.
//
// THE FOUR ARMS (queueSlice implements them):
//   1. ORPHAN     — id in no stack → placed in the stack named by packet.lane.
//   2. TOMBSTONE  — stack id with no readable packet → dropped from the
//                   projection, never thrown.
//   3. LANE GONE  — packet.lane names a lane absent from lanes.json, or is
//                   absent entirely → the item is UNFILED: returned by
//                   listItems and deskSlice, excluded from queueSlice, rankOf
//                   returns null. Creating the lane would be an agent making a
//                   lane-structure change; dropping the item would be a silent
//                   deletion; throwing would break the never-throw contract.
//   4. DUPLICATE  — the same id in two stacks (a hand-edited paste) → the FIRST
//                   stack in file order wins; the later occurrence is dropped
//                   from the projection and reported by listItems.
//
// PROJECTION-ONLY, AND THIS IS THE LOAD-BEARING HALF. Reconciliation NEVER
// writes back. The writers write the STORED stacks plus the current mutation,
// never the reconciled projection. Otherwise one transiently unreadable packet
// directory would permanently drop that id from `lanes.json` on the very next
// create — A DELETION PATH THAT NEVER CALLS rmSync, so a scan of the handlers
// for rmSync/unlinkSync would pass straight over it. "No deletion path" is the
// rule; this is the arm of it a naming check cannot reach.

/**
 * Which lane a new item comes to rest in.
 *
 * A REQUESTED LANE THAT DOES NOT EXIST IS NEVER CREATED. Lane structure is
 * reserved to the human, so an agent naming an unknown lane would otherwise be
 * making a lane-structure change by side effect. Instead the item files into the
 * seed lane and is marked `unplaced`, so the desk ASKS — which is exactly what
 * unplaced is for: "the master could not file it and is asking… renders as a
 * question, not a failure."
 */
function resolveLane(lanes: SpoolLane[], requested?: string): { lane: string; unplaced: boolean } {
  if (requested && lanes.some((l) => l.key === requested)) return { lane: requested, unplaced: false };
  return { lane: SEED_LANE_KEY, unplaced: true };
}

const rowItems = (row: unknown): unknown[] | null => {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const items = (row as { items?: unknown }).items;
  return Array.isArray(items) ? items : null;
};

/** A raw row's own `key`, when it still has a readable one — shared by
 *  `createLane` (dedupe) and `retireLane` (addressing a row this build cannot
 *  parse) rather than re-derived in each. */
const rawKeyOf = (row: unknown): string | undefined => {
  if (row !== null && typeof row === "object" && typeof (row as { key?: unknown }).key === "string") {
    return (row as { key: string }).key;
  }
  return undefined;
};

/**
 * Put `id` in the stack at `targetIndex` and NOWHERE ELSE, returning the rows to
 * write. Operates on the RAW rows so a row this build could not parse survives
 * the write intact.
 *
 * THE FIRST ROW WITH THE TARGET KEY WINS, and appending to every matching row
 * would be the store MANUFACTURING the duplicate-id fault arm 4 exists to report
 * — a hand-edited file with two rows keyed `office` would otherwise make create
 * write the same id into both stacks and then blame the human for it. Every
 * other row has the id REMOVED, which is the half that makes a move a move
 * rather than a copy, AND the half that dedupes a hand-edited paste.
 *
 * THE TARGET ROW KEEPS ITS ORDER IF IT ALREADY HOLDS THE ID. Removing and
 * re-appending would send the item to the BOTTOM of the lane it is already in —
 * a queue-position change nobody asked for.
 *
 * A NEGATIVE `targetIndex` means no row carries the target key: the id is
 * removed from every stack and added to none, so the item is unfiled (arm 3), a
 * resting state. NO LANE IS CREATED.
 */
function placeIdInRows(entries: SpoolLaneEntry[], id: string, targetIndex: number): unknown[] {
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

/** Writes the RAW rows — see `placeIdInRows`. Separate from `writeLanes`, which
 *  takes parsed lanes and is the hand-edit/caller-supplied path. */
function writeLaneRows(paths: SpoolPaths, rows: unknown[]): void {
  atomicWrite(paths.lanes, rows);
}

/**
 * Create an item. Two files, in the order the reconcile rule pins.
 *
 * `provenance` IS WRITTEN SERVER-SIDE AND IS NEVER READ FROM CALLER INPUT. It is
 * the free-form label the contract requires and is deliberately NOT narrowed to
 * a union: "provenance is a free-form label, not a channel type" — a union is
 * precisely what that constraint forbids. "session" was the honest label when
 * the store's only writer was a tool running inside a session; the workbench
 * added a second hand, so `source` (see `NewSpoolItem`) now picks between the
 * two stamps the server knows — "you" for the human API's own form, "session"
 * for everything through the tool wall. A later caller writing from somewhere
 * else — a brain dump, a mirror sync — still widens `NewSpoolItem` here.
 */
export function createItem(paths: SpoolPaths, input: NewSpoolItem): SpoolItem {
  ensureSpool(paths);
  const read = readLanesReport(paths);
  const { lane, unplaced } = resolveLane(read.lanes, input.lane);
  const at = capturedLabel(new Date());
  const byHand = input.source === "you";

  const item: SpoolItem = SpoolItem.parse({
    id: newItemId(),
    title: input.title,
    provenance: byHand ? "you" : "session",
    captured: at,
    schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
    lane,
    // "Places it on the desk". A boolean on the item, because the desk item is
    // "a projection of an item the agents just touched, NOT a separate store".
    desk: true,
    ...(unplaced ? { unplaced: true } : {}),
    ...(input.project ? { project: input.project } : {}),
    ...(input.deadline ? { deadline: SpoolDeadline.parse(input.deadline) } : {}),
    ...(input.pinned !== undefined ? { pinned: assertPin(input.pinned) } : {}),
    // Through the one gate, and an empty list is spelled by absence — the
    // schema's only reading of "no tags", same as the pin's.
    ...(input.tags !== undefined && assertTags(input.tags).length > 0 ? { tags: assertTags(input.tags) } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
    ...(input.rawSource ? { rawSource: input.rawSource } : {}),
    timeline: [
      {
        at,
        // The widened actor. A project session's agent is not `you`, not the
        // per-project `expert` and not `bed` — and the workbench's own form is
        // exactly `you`, the actor the enum always had for the human.
        actor: byHand ? "you" : "session",
        text: input.creationNote ?? (byHand ? "captured by hand" : "captured from a session"),
      },
    ],
  });

  // PACKET FIRST.
  writePacket(paths, item);
  // LANES SECOND — the stored stacks plus this one mutation, never a projection.
  // If the seed lane was retired there is no row to receive the id and the item
  // is simply unfiled (arm 3). No lane is created to receive it, and no write
  // happens at all, so a file full of rows this build cannot read is not
  // rewritten either.
  const targetIndex = read.entries.findIndex((e) => e.lane?.key === lane);
  if (targetIndex >= 0) writeLaneRows(paths, placeIdInRows(read.entries, item.id, targetIndex));
  return item;
}

/**
 * Apply a patch. `null` when the item does not exist or cannot be read.
 *
 * A FORBIDDEN KEY THROWS RATHER THAN BEING SILENTLY DROPPED. The TYPE already
 * forbids naming one; this is the runtime half, because a cast, a `JSON.parse`
 * or a future deserialization boundary cannot get past a check the type alone
 * makes. Silently dropping `raw` from a patch would look identical, from the
 * outside, to honouring it — and the difference is whether the user's own words
 * survived.
 */
export function updateItem(paths: SpoolPaths, id: string, patch: SpoolItemPatch): SpoolItem | null {
  const forbidden = Object.keys(patch).filter((k) => !(PATCHABLE as readonly string[]).includes(k));
  if (forbidden.length > 0) {
    throw new Error(
      `updateItem cannot write ${forbidden.map((f) => `\`${f}\``).join(", ")}. ` +
        `\`raw\`/\`rawSource\` are the user's own words kept verbatim so they can check an expert did not drift from what they ` +
        `meant, \`promotedFrom\` has no agent path at all, \`closed\` is the user's own checkbox and only the dedicated ` +
        `close/reopen verbs write it, and \`subtasks\`/\`timeline\`/\`tracking\` have their own named verbs. ` +
        `Silently dropping them would be indistinguishable from honouring them. Patch only: ${PATCHABLE.join(", ")}.`,
    );
  }

  const current = getSpoolItem(paths, id);
  if (!current) return null;

  // THE DURABLE-OVERRIDE GUARD BELONGS HERE, and it went out with the verdict:
  // `verdict` was patchable, so without a check the generic update verb was the
  // way round the override an expert pass honours. Restoring the verdict means
  // restoring this too — it is not optional decoration, it is the half that
  // makes "a human override is durable" true against an AGENT tool.

  assertPacketAddressMatches(id, current);

  // A LANE CHANGE IS A TWO-FILE MOVE, and `lanes.json` is the half that decides.
  //
  // AN UNRESOLVABLE LANE KEY NEVER MOVES THE ITEM, and this is where update
  // deliberately DIVERGES from create. A create has no home yet, so an unknown
  // key has to resolve somewhere and the seed lane is that somewhere. An update
  // has a home. Redirecting a typo'd lane key into the seed lane would EVICT an
  // already-filed item from the user's queue on a model's spelling mistake — and
  // where the seed lane has been retired it would evict the item into NO stack
  // at all, where it appears in no queue, on no desk, and in no report. So the
  // item stays exactly where it is, `unplaced` marks it for the user, and the
  // surface says which key did not exist.
  //
  // A SUCCESSFUL move CLEARS `unplaced`, unless the caller named it in the same
  // patch: the flag means "the master could not file it and is asking", and once
  // it IS filed, leaving it on would keep the desk asking a question that has
  // been answered — and the desk's hint chain puts `unplaced` first, so it would
  // mask the item's deadline forever.
  const read = readLanesReport(paths);
  const targetIndex = patch.lane === undefined ? -1 : read.entries.findIndex((e) => e.lane?.key === patch.lane);
  const resolved = patch.lane !== undefined && targetIndex >= 0;
  const unresolvable = patch.lane !== undefined && targetIndex < 0;

  // THE PIN'S THREE READINGS, decided before the merge: absent leaves it
  // alone, `{day}` goes through the one gate create uses, and an EXPLICIT
  // `null` clears — which must REMOVE the key rather than store `null`,
  // because the schema (rightly) has no way to spell "a pin that is not
  // there" other than absence.
  if (patch.pinned !== undefined && patch.pinned !== null) assertPin(patch.pinned);

  // THE TAGS' TWO READINGS: absent leaves them alone; a list replaces them
  // whole through the one gate, and a list that gates down to nothing clears —
  // absence is the schema's only spelling of "no tags", same as the pin's.
  const tags = patch.tags === undefined ? undefined : assertTags(patch.tags);

  // Spread order matters: `current` first, so every field the patch does not
  // name — including every UNKNOWN key the loose schema preserved off disk —
  // survives the rewrite untouched.
  const merged: Record<string, unknown> = {
    ...current,
    ...patch,
    ...(unresolvable
      ? {
          // Stay put. The hint is re-pinned to the stack that actually holds the
          // item, so the packet and lanes.json still agree at this commit point.
          lane: read.lanes.find((l) => l.items.includes(id))?.key ?? current.lane,
          unplaced: true,
        }
      : {}),
    ...(resolved ? { lane: patch.lane, unplaced: patch.unplaced ?? false } : {}),
    ...(tags !== undefined ? { tags } : {}),
    schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
  };
  if (patch.pinned === null) delete merged.pinned;
  if (tags !== undefined && tags.length === 0) delete merged.tags;
  const next = SpoolItem.parse(merged);

  // PACKET FIRST, LANES SECOND — and the reason a torn write is safe: the id is
  // still in its old stack, the orphan arm does not fire, and the move simply
  // did not happen.
  writePacket(paths, next);
  if (resolved) {
    const moved = placeIdInRows(read.entries, id, targetIndex);
    // NOTHING IS REWRITTEN WHEN NOTHING MOVED. `placeIdInRows` returns the SAME
    // row reference for a row it did not touch — including the target row when
    // it already holds the id — so this is an exact "did any stack change" test,
    // and a move to the lane the item is already in leaves the user's file
    // byte-identical rather than re-ranking it.
    if (moved.some((row, i) => row !== read.entries[i]!.row)) writeLaneRows(paths, moved);
  }
  return next;
}

/**
 * RECORD THE ANSWER TO ONE OF AN ITEM'S OPEN QUESTIONS — the reduction verb.
 *
 * ── WHY THIS IS LEGAL UNDER COMPRESS-NEVER-MULTIPLY ─────────────────────────
 * `openQuestions` is agent-authored ("what the draft could not answer alone",
 * written only by `applyDraft`), so removing an entry retracts an agent's
 * question once it has an answer — open state REDUCES, which is the direction
 * the law wants, and nothing of the user's is touched. The answer is not
 * discarded with it: it lands on the timeline as a packet event, marked
 * `proposal` because it arrived through an agent's hands and nobody has looked
 * — the provenance law applied to an answer instead of a draft.
 *
 * ── A QUESTION THAT IS NOT ON THE ITEM IS A LOUD REFUSAL ────────────────────
 * Matching is whitespace/case-tolerant (the same standard `sameQuestion`
 * applies to threads), but a miss throws the list of what IS open rather than
 * appending an answer to a question nobody asked — a silent mismatch would
 * write an orphan answer and leave the question standing, which is the exact
 * opposite of what the caller believes happened.
 */
export function answerOpenQuestion(
  paths: SpoolPaths,
  id: string,
  question: string,
  answer: string,
  at: Date = new Date(),
): SpoolItem | null {
  const trimmedAnswer = answer.trim();
  if (!trimmedAnswer) {
    throw new Error(
      "Answering a question records WHAT THE ANSWER IS. An empty answer would just delete the question, and this " +
        "store has no deletion path — write the answer, or leave the question open.",
    );
  }
  const current = getSpoolItem(paths, id);
  if (!current) return null;
  assertPacketAddressMatches(id, current);

  const open = current.openQuestions ?? [];
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "");
  const index = open.findIndex((q) => norm(q) === norm(question));
  if (index < 0) {
    throw new Error(
      open.length === 0
        ? `"${current.title}" has no open questions to answer.`
        : `"${current.title}" has no open question matching that. Still open: ${open.map((q) => `"${q}"`).join(" · ")}`,
    );
  }

  const remaining = open.filter((_, i) => i !== index);
  const next = SpoolItem.parse({
    ...current,
    ...(remaining.length > 0 ? { openQuestions: remaining } : { openQuestions: undefined }),
    timeline: [
      ...(current.timeline ?? []),
      {
        at: capturedLabel(at),
        actor: "session",
        text: `Answered "${open[index]}": ${trimmedAnswer}`,
        proposal: true,
      },
    ],
  });
  writePacket(paths, next);
  return next;
}

function writePacket(paths: SpoolPaths, item: SpoolItem): void {
  atomicWrite(packetFile(paths, item.id), item);
}

/**
 * REWRITE AN ITEM'S TAGS DIRECTLY — the one deliberate way around `updateItem`
 * (2026-08-18, `spool/tags.ts`'s tag rename). `updateItem`'s guards protect the
 * item's WORDS and STATE: `raw`/`rawSource` are what the user actually said,
 * `closed` is the user's own checkbox, `verdict` is a durable human override.
 * A tag is none of those — it is index metadata that happens to be stored ON
 * the record, not content of the record. Renaming "urgente" to "cliente" does
 * not rewrite what the item says or what the user decided about it; it
 * relabels how the item is FOUND. So this bypasses every one of `updateItem`'s
 * content/state guards on purpose, including the one that would otherwise be
 * irrelevant but still in the way: a CLOSED item is eligible too, because
 * closing drains an item from view (§9.3) without freezing what indexes it —
 * an index entry does not become immutable just because the row it points at
 * is done.
 */
export function rewriteItemTags(paths: SpoolPaths, id: string, tags: string[]): void {
  const current = getSpoolItem(paths, id);
  if (!current) return;
  const merged: Record<string, unknown> = { ...current, tags, schemaVersion: SPOOL_ITEM_SCHEMA_VERSION };
  if (tags.length === 0) delete merged.tags;
  writePacket(paths, SpoolItem.parse(merged));
}

// ── the checkbox — docs/spool-loops.md §9 ───────────────────────────────────
//
// THESE TWO FUNCTIONS ARE THE ONLY WRITERS OF `closed`, and neither is reachable
// from a tool. They are called straight from the daemon's dedicated
// `/v2/spool/items/:id/close` and `/reopen` handlers — the same construction
// that makes lane structure human-only. `closed` is not in `PATCHABLE`, so the
// generic update path (the one the tool wall CAN reach) refuses it by name.
// That is what makes the attribution in the schema comment true: a value in
// `closed` can only mean the user's own hand.

/**
 * TICK THE BOX. Stamps `closed` with the store's label idiom and records the
 * moment on the ripening timeline as the human's own act (`actor: "you"`, no
 * proposal mark — nothing here awaits a look; the look already happened, it was
 * the click).
 *
 * IDEMPOTENT, WITH AN HONEST NOTE: closing a closed item changes nothing and
 * says so, rather than re-stamping the label and quietly rewriting when the
 * hand actually moved.
 *
 * THE CASCADE (settling the item's open threads) is composed one level up, in
 * `state.ts` — threads live in `threads.ts`, which imports this file, so the
 * store cannot reach them without a cycle. This function owns only the field.
 */
export function closeItem(
  paths: SpoolPaths,
  id: string,
  at: Date = new Date(),
): { item: SpoolItem; alreadyClosed: boolean } | null {
  const current = getSpoolItem(paths, id);
  if (!current) return null;
  assertPacketAddressMatches(id, current);
  if (current.closed) return { item: current, alreadyClosed: true };

  const label = capturedLabel(at);
  const next = SpoolItem.parse({
    ...current,
    closed: { label, at: at.getTime() },
    timeline: [...(current.timeline ?? []), { at: label, actor: "you", text: "closed by hand" }],
  });
  writePacket(paths, next);
  return { item: next, alreadyClosed: false };
}

/**
 * UNTICK THE BOX. Removes `closed` — absence is open — and appends the reopen
 * to the same timeline, so the record reads "closed by hand … reopened by
 * hand" rather than pretending the close never happened. Drain, never delete:
 * nothing else on the item is touched.
 *
 * REOPENING DOES NOT RESURRECT CASCADE-SETTLED THREADS. A settled thread is
 * never removed and stays settled — its answer ("the user closed the task") is
 * a true record of what happened. The user opens a NEW question if one is
 * still open; un-settling would rewrite history in a store built on not doing
 * that.
 */
export function reopenItem(
  paths: SpoolPaths,
  id: string,
  at: Date = new Date(),
): { item: SpoolItem; alreadyOpen: boolean } | null {
  const current = getSpoolItem(paths, id);
  if (!current) return null;
  assertPacketAddressMatches(id, current);
  if (!current.closed) return { item: current, alreadyOpen: true };

  const merged: Record<string, unknown> = {
    ...current,
    timeline: [...(current.timeline ?? []), { at: capturedLabel(at), actor: "you", text: "reopened by hand" }],
  };
  // Absence is the schema's only spelling of "open" — see `SpoolItem.closed`.
  delete merged.closed;
  const next = SpoolItem.parse(merged);
  writePacket(paths, next);
  return { item: next, alreadyOpen: false };
}

// ── lane structure changes ──────────────────────────────────────────────────
//
// THESE FOUR FUNCTIONS ARE THE ONLY WAY LANE STRUCTURE EVER CHANGES, and none of
// them is reachable from a tool. They are called straight from the daemon's
// `/v2/spool/lanes/**` handlers. That is what makes "human-only" true by
// construction rather than by a permission check: nothing in the agent-facing
// tool surface names any of these.
//
// THE SEED-LANE-RENAME HAZARD, RESOLVED: `resolveLane`'s fallback target is the
// STORED KEY, not the row's label — so the hazard was never "renaming changes
// routing", it was "changing the KEY changes routing", and the fix is to make
// the key immutable after creation FOR EVERY LANE, not just the seed. There is
// no function anywhere in this file that can change a `key` once a lane exists.

/** Turns a lane label into a stack-safe key. `existingKeys` is read from the RAW
 *  rows, not just the parsed ones, so a new lane can never collide with a row
 *  this build cannot fully read either. */
function slugifyLaneKey(label: string, existingKeys: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lane";
  if (!existingKeys.has(base)) return base;
  let n = 2;
  while (existingKeys.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Mint a lane. The key is minted ONCE, here, from the label — never supplied by
 * a caller, so there is no path by which two lanes could be asked to share one.
 * APPENDS ONLY: every other row is written back exactly as read.
 */
export function createLane(paths: SpoolPaths, input: { label: string; window: string; note?: string }): SpoolLane {
  ensureSpool(paths);
  const read = readLanesReport(paths);
  const existingKeys = new Set(read.entries.map(({ row }) => rawKeyOf(row)).filter((k): k is string => k !== undefined));
  const newLane: SpoolLane = SpoolLane.parse({
    key: slugifyLaneKey(input.label, existingKeys),
    label: input.label,
    window: input.window,
    ...(input.note ? { note: input.note } : {}),
    items: [],
  });
  writeLaneRows(paths, [...read.entries.map((e) => e.row), newLane]);
  return newLane;
}

/**
 * Rewrites `label` and NOTHING else. Returns `null` (writes nothing) when no row
 * carries the key — an honest "fix it by hand" outcome for a key so malformed
 * even its own row cannot be found, rather than a crash. Spreads over the RAW
 * row, so unknown or hand-added keys on that row survive.
 */
export function renameLane(paths: SpoolPaths, key: string, label: string): SpoolLane | null {
  const read = readLanesReport(paths);
  const idx = read.entries.findIndex((e) => rawKeyOf(e.row) === key);
  if (idx < 0) return null;
  const nextRow = { ...(read.entries[idx]!.row as object), label };
  writeLaneRows(
    paths,
    read.entries.map((e, i) => (i === idx ? nextRow : e.row)),
  );
  // The row that was just written is, by construction, the one this function
  // built — parsed here rather than re-read from disk so the return value cannot
  // silently diverge from what was actually written.
  return SpoolLane.parse(nextRow);
}

/**
 * Refuses, never partially applies, unless the lane's STORED `items` array is
 * empty — never the rendered queue, which drops tombstones and adopts orphans. A
 * lane whose only members are unreadable ids still counts as non-empty on
 * purpose: dropping those ids to let the retirement through would be a second
 * silent deletion path of exactly the shape the "projection-only, never writes
 * back" rule exists to forbid.
 */
export function retireLane(paths: SpoolPaths, key: string): { ok: true } | { ok: false; reason: string } {
  // THE ONE SPECIAL CASE — retiring create's only fallback target would not
  // remove that behaviour, it would make the next unplaceable capture land in a
  // lane that no longer exists. Renaming this row's label is unrestricted; only
  // retiring the row by this key is refused.
  if (key === SEED_LANE_KEY) {
    return {
      ok: false,
      reason:
        `"${SEED_LANE_KEY}" is where a new item goes when it cannot be placed — retiring it would not remove ` +
        `that behaviour, it would make the next unplaceable capture land in a lane that no longer exists, invisible ` +
        `on the queue. Rename its label instead if "Unfiled" is the wrong word for it; the row itself has to stay ` +
        `until the fallback can point somewhere else.`,
    };
  }
  const read = readLanesReport(paths);
  const idx = read.entries.findIndex((e) => rawKeyOf(e.row) === key);
  if (idx < 0) return { ok: false, reason: `No lane named "${key}" exists.` };
  const entry = read.entries[idx]!;
  if (!entry.lane) {
    return {
      ok: false,
      reason: `Lane "${key}"'s own row in ${LANES_FILE} could not be read as a lane, so its item count cannot be confirmed. Fix the row by hand, then retire it.`,
    };
  }
  if (entry.lane.items.length > 0) {
    return {
      ok: false,
      reason: `Lane "${key}" still holds ${entry.lane.items.length} item${
        entry.lane.items.length === 1 ? "" : "s"
      } in its stored stack. Move or clear them first — retiring never evicts an item on the human's behalf.`,
    };
  }
  // AN ADOPTED ORPHAN IS AN ITEM IN THIS LANE TOO. `queueSlice`'s arm 1 files an
  // item whose packet names a lane into that lane even when the stored stack has
  // forgotten it — the human sees it under this group header, ranked,
  // indistinguishable from a stacked one. The stored-stack check above cannot see
  // it, so retiring here would leave that packet naming a key no row carries: arm
  // 3 then gives it NO ROW AT ALL and it vanishes from the queue, while the desk
  // rail is still promising, in words, that dismissing a card "sends it here".
  const adopted = listItems(paths).items.filter((i) => i.lane === key);
  if (adopted.length > 0) {
    return {
      ok: false,
      reason: `Lane "${key}"'s stored stack is empty, but ${adopted.length} item${adopted.length === 1 ? "" : "s"} still name${
        adopted.length === 1 ? "s" : ""
      } it (${adopted
        .slice(0, 3)
        .map((i) => i.id)
        .join(", ")}${adopted.length > 3 ? ", …" : ""}) and the queue renders ${
        adopted.length === 1 ? "it" : "them"
      } under this lane. Move ${
        adopted.length === 1 ? "it" : "them"
      } to another lane first — retiring never evicts an item on the human's behalf, and an item naming a retired lane would fall off the queue entirely.`,
    };
  }
  writeLaneRows(
    paths,
    read.entries.filter((_, i) => i !== idx).map((e) => e.row),
  );
  return { ok: true };
}

/**
 * "This lane's stack becomes exactly these ids, in this order." Generalized
 * beyond a same-lane shuffle: any id already sitting in a DIFFERENT lane's stack
 * is removed from that row and adopted into this one, which is what lets one
 * action serve both an in-lane reorder and a cross-lane drag — and what lets a
 * lane containing an ADOPTED ORPHAN still be reordered as the human sees it
 * rendered, rather than rejecting the call because the permutation does not match
 * the stored stack.
 *
 * EVERY ID MUST RESOLVE TO A READABLE PACKET, OR THIS THROWS AND WRITES NOTHING.
 * Silently accepting a fabricated or tombstoned id would plant a new dangling
 * stack reference — exactly the fault arm 2 exists to drop at READ time; a WRITE
 * gets no such leniency.
 */
export function reorderLane(paths: SpoolPaths, key: string, orderedItemIds: string[]): SpoolLane {
  const read = readLanesReport(paths);
  const targetIndex = read.entries.findIndex((e) => e.lane?.key === key);
  if (targetIndex < 0) {
    throw new Error(`No lane named "${key}" exists — list the lanes before reordering one.`);
  }
  const unresolved = orderedItemIds.filter((id) => !getSpoolItem(paths, id));
  if (unresolved.length > 0) {
    throw new Error(
      `Cannot reorder lane "${key}": ${unresolved.map((id) => JSON.stringify(id)).join(", ")} ` +
        `${unresolved.length === 1 ? "does" : "do"} not resolve to a readable packet. Nothing was written.`,
    );
  }
  const rows = read.entries.map(({ row }, i) => {
    if (i === targetIndex) return { ...(row as object), items: [...orderedItemIds] };
    const items = rowItems(row);
    if (items === null) return row;
    const filtered = items.filter((x) => !orderedItemIds.includes(x as string));
    return filtered.length === items.length ? row : { ...(row as object), items: filtered };
  });
  writeLaneRows(paths, rows);
  return SpoolLane.parse(rows[targetIndex]);
}

// ── sub-task mutation and promotion ─────────────────────────────────────────
//
// THE CONSERVATION VALVE: decomposition lives INSIDE the item, so `addSubtask`
// and `setSubtaskDone` never touch `lanes.json` and never change `queueSlice`'s
// row count — the parent item's own `subtasks` array is the only thing that
// grows.
//
// "Agents have no promotion path, proposed or otherwise." Like the lane
// functions above, `promoteSubtask` is called only from a thin daemon handler —
// not from anything a tool surface can reach — and it is one of only two places
// in this store that stamps `actor: "you"` itself, which is only honest because
// only a human click reaches it.

/** Appends one sub-task with a minted id (never a caller-supplied one). `null`,
 *  writes nothing, when `itemId` does not resolve to a readable packet. */
export function addSubtask(paths: SpoolPaths, itemId: string, title: string): SpoolItem | null {
  const current = getSpoolItem(paths, itemId);
  if (!current) return null;
  assertPacketAddressMatches(itemId, current);
  const next = SpoolItem.parse({
    ...current,
    subtasks: [...(current.subtasks ?? []), { id: newSubtaskId(), title, done: false }],
    schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
  });
  writePacket(paths, next);
  return next;
}

/** Toggles exactly the named sub-task's `done`; every other field of every other
 *  sub-task is untouched. `null`, writes nothing, when the item or the sub-task
 *  id does not resolve. */
export function setSubtaskDone(
  paths: SpoolPaths,
  itemId: string,
  subtaskId: string,
  done: boolean,
): SpoolItem | null {
  const current = getSpoolItem(paths, itemId);
  if (!current) return null;
  assertPacketAddressMatches(itemId, current);
  const subtasks = current.subtasks ?? [];
  if (!subtasks.some((s) => s.id === subtaskId)) return null;
  const next = SpoolItem.parse({
    ...current,
    subtasks: subtasks.map((s) => (s.id === subtaskId ? { ...s, done } : s)),
    schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
  });
  writePacket(paths, next);
  return next;
}

/**
 * THE ONLY PROMOTION PATH IN THE WHOLE CODEBASE. `null`, nothing written on
 * either side, when the parent or the named sub-task does not resolve.
 *
 * The promoted item is deliberately NOT built like a created item:
 *   - `provenance` is free text naming the parent, never the literal "session" —
 *     so a promoted item is distinguishable in provenance data itself from
 *     anything an agent filed.
 *   - `desk` is left UNSET. The desk boolean means "the master just touched this
 *     and is asking a question"; a human's own promotion click is neither.
 *   - `unplaced` is left UNSET even when the parent has no stack — that flag
 *     means "the master could not file it", and nothing here is the master
 *     failing to file anything.
 */
export function promoteSubtask(
  paths: SpoolPaths,
  itemId: string,
  subtaskId: string,
): { parent: SpoolItem; promoted: SpoolItem } | null {
  const parent = getSpoolItem(paths, itemId);
  if (!parent) return null;
  assertPacketAddressMatches(itemId, parent);
  const subtasks = parent.subtasks ?? [];
  const subtask = subtasks.find((s) => s.id === subtaskId);
  if (!subtask) return null;

  const nextParent = SpoolItem.parse({
    ...parent,
    subtasks: subtasks.filter((s) => s.id !== subtaskId),
    schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
  });
  const at = capturedLabel(new Date());
  const promoted: SpoolItem = SpoolItem.parse({
    id: newItemId(),
    title: subtask.title,
    provenance: `promoted from "${parent.title}"`,
    captured: at,
    schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
    promotedFrom: parent.id,
    ...(parent.project ? { project: parent.project } : {}),
    timeline: [{ at, actor: "you", text: `promoted out of "${parent.title}"` }],
  });

  // PACKETS FIRST, LANES SECOND — a crash in the gap leaves both packets intact
  // with the promoted id in no stack yet, which the orphan arm cannot adopt (it
  // has no `lane` hint) — so the worst case is "unfiled", never a dangling
  // reference.
  writePacket(paths, nextParent);
  writePacket(paths, promoted);

  // Land at the BOTTOM of the parent's ACTUAL current stack — read off
  // `lanes.json`, never off the packet's recovery hint. If the parent itself has
  // no stack (unfiled, or a lane retired out from under it), the promoted sibling
  // is simply left unfiled too, not adopted into a lane nobody chose for it.
  const read = readLanesReport(paths);
  const parentLaneIndex = read.entries.findIndex((e) => e.lane?.items.includes(parent.id));
  if (parentLaneIndex >= 0) {
    writeLaneRows(
      paths,
      read.entries.map(({ row }, i) => {
        if (i !== parentLaneIndex) return row;
        const items = rowItems(row);
        return items === null ? row : { ...(row as object), items: [...items, promoted.id] };
      }),
    );
  }
  return { parent: nextParent, promoted };
}

// ── the weave stamp: REMOVED WITH LOOMS ─────────────────────────────────────
//
// `trackLoom` lived here — the only writer of an item's `tracking` field, and
// the executable half of CAP-11's sharpest sentence: "member rows STAY in the
// queue marked as tracking the loom and leave only when it lands AND the human
// accepts — never at weave time."
//
// WHAT MADE IT SUBTLE IS WORTH KEEPING WRITTEN DOWN, because whoever restores it
// has to restore the reasoning and not just the function:
//
//   · IT TOUCHED NO LANE FILE. Not "did not need to" — MUST NOT. Removing woven
//     ids from their stacks is exactly the leave-at-weave-time behaviour CAP-11
//     forbids, and it would be a deletion path reached without ever calling
//     rmSync, which a scan for delete verbs would pass straight over.
//   · THERE WAS NO UN-TRACK PATH. A row leaves when the loom LANDS and a HUMAN
//     ACCEPTS, and this module may observe neither. A `clearTracking` would have
//     been a spool-side way to pretend a loom finished.
//   · RE-POINTING AN ALREADY-TRACKED ITEM WROTE NOTHING and was reported
//     instead, because overwriting silently orphans the first loom's membership
//     while that loom is still weaving on a premise built from this packet. The
//     one exit was an explicit `replacing` list, so "that loom is dead" was
//     always a decision someone made with it in front of them.
//
// It is gone because nothing in this app can weave, land or accept a loom, and a
// stamp with no writer is dead weight. `packages/core/src/workspace/store.ts`
// still holds the original; issue #93 tracks bringing it back.

// ── the expert digests ──────────────────────────────────────────────────────
//
// "Experts produce durable state digests on disk; the master is a thin reader —
// receptionist, not manager. State lives on disk, not in the conversation; this
// is what removes the context-window ceiling." Two functions, and the DIRECTION
// between them is the whole design: the expert pass is the only caller of the
// writer, and every other reader in the app takes the reader.

/**
 * `null` when there is no digest, when the project name cannot be addressed, and
 * when the file cannot be read or parsed. NEVER THROWS, and the reading of
 * "null" is the one CAP-9 requires: a COLD EXPERT WITH NOTHING TO REHYDRATE
 * FROM. A first pass on a brand-new project is exactly that case, so it must not
 * be an error.
 *
 * NO MIGRATE-ON-READ, unlike a packet, and the asymmetry is the point: a packet
 * holds the user's own words with no source to rebuild them from, so a
 * version-ahead packet is refused rather than guessed at. A digest is the
 * expert's own compression and the next pass rewrites it, so degrading to "no
 * digest" costs one cold pass and loses nothing a human authored.
 */
export function readExpertDigest(paths: SpoolPaths, project: string): SpoolExpertDigest | null {
  let file: string;
  try {
    file = expertDigestPath(paths, project);
  } catch {
    return null;
  }
  try {
    return liftLegacyNotes(SpoolExpertDigest.parse(JSON.parse(fs.readFileSync(file, "utf8"))));
  } catch {
    return null;
  }
}

/**
 * `notes: string[]` → `facts`, AT READ TIME — the one-way lift for a digest
 * written before memory was addressable.
 *
 * ── WHY THIS EXISTS, AND WHY DRIVING IT IS WHAT FOUND IT ─────────────────────
 * `SpoolExpertDigest` is a `looseObject`, so an old digest parses CLEANLY: the
 * unknown `notes` key survives untouched and `facts` takes its `[]` default.
 * The result is not an unreadable digest — which this module already degrades to
 * "no digest" — but a readable one that is silently EMPTY. ozom-gv's ten notes
 * and aurora's five were still on disk with nothing reading them, and the whole
 * suite was green: every test seeds its own digest in the new shape, so none of
 * them could see it.
 *
 * ── AT READ TIME, LIKE THE PACKET LADDER'S NORMALISATION ─────────────────────
 * Not a migration script, for the reason the digest header already gives: a
 * digest is re-derivable and has no version ladder. Lifting on read means an
 * old file is understood the first time it is opened, by whatever opens it, and
 * a store nobody has read is never left half-migrated.
 *
 * ── EVERY LIFTED NOTE IS `howItWorks`, AND THAT IS A CHOICE ──────────────────
 * The old shape had no kinds, so any assignment is a guess. `howItWorks` is the
 * SAFE guess rather than the common one: it is the kind an agent is allowed to
 * retire, and `person` is the kind it is not. Guessing "person" would make a
 * wrong note permanent unless a human found it; guessing "howItWorks" leaves
 * every lifted note correctable from both doors. They are left unreviewed,
 * which is honest — nobody has confirmed them.
 */
function liftLegacyNotes(digest: SpoolExpertDigest): SpoolExpertDigest {
  if (digest.facts.length > 0) return digest;
  const legacy = (digest as { notes?: unknown }).notes;
  if (!Array.isArray(legacy)) return digest;
  const facts = legacy
    .filter((note): note is string => typeof note === "string" && note.trim() !== "")
    .map((note, index) => ({
      // DERIVED FROM POSITION, not minted, so the same file lifts to the same
      // ids on every read — an id that changed per read could not be retired.
      id: `f-legacy-${index}`,
      text: note.trim(),
      kind: "howItWorks" as const,
      // The pass that last wrote the old digest is the honest provenance: it is
      // the most recent thing known to have touched any of them.
      source: { pass: digest.updated },
    }));
  return facts.length > 0 ? { ...digest, facts } : digest;
}

/**
 * Atomic, like every write in this module. `project` is taken from the digest
 * itself rather than as a second argument, so the file's address and its content
 * cannot disagree the way a hand-edited packet's `id` can.
 *
 * THROWS on a project name this store cannot address — a write is loud where a
 * read is tolerant.
 */
export function writeExpertDigest(paths: SpoolPaths, digest: SpoolExpertDigest): SpoolExpertDigest {
  const parsed = SpoolExpertDigest.parse({ ...digest, schemaVersion: SPOOL_DIGEST_SCHEMA_VERSION });
  atomicWrite(expertDigestPath(paths, parsed.project), parsed);
  return parsed;
}

const newFactId = () => `f-${crypto.randomBytes(6).toString("hex")}`;

/** Two facts are the same fact if they say the same thing. Coarse on purpose:
 *  this exists to stop a pass restating what it was already told, not to detect
 *  paraphrase. */
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A PASS'S MEMORY, FOLDED INTO WHAT WAS ALREADY THERE — the audited verb that
 * replaced a wholesale overwrite.
 *
 * ── WHAT WAS WRONG WITH THE OLD WRITE ────────────────────────────────────────
 * `runExpertPass` handed `writeExpertDigest` a completely fresh object built
 * from the model's answer, so the digest was rebuilt from scratch by whichever
 * item happened to be read. Anything the current item did not touch evaporated;
 * nothing carried provenance; and a wrong fact could only be removed by hoping
 * a later model chose not to restate it. The aurora digest's "no locally
 * reachable codebase — searched thoroughly this time" is the case that forced
 * this: a cache entry with no expiry, telling every future pass not to look.
 *
 * ── WHAT MERGES AND WHAT REPLACES, AND WHY EACH ──────────────────────────────
 *   · `summary`/`methodology` REPLACE. An overview is exactly the thing that is
 *     correct to regenerate, and the model is handed the old one.
 *   · `glossary` MERGES BY TERM. A definition survives a pass that did not
 *     restate it. Redefinition is allowed — vocabulary drifts — but removal is
 *     not, this round: a term nobody says any more is harmless, and a term
 *     silently dropped is the loss this whole change exists to end.
 *   · `facts` APPEND, and retire by id. A pass adds what it learned and may
 *     propose retirements; it can no longer replace the set.
 */
// ── memory.json — the front door's own ──────────────────────────────────────

const SELF_MEMORY_FILE = "memory.json";

export function selfMemoryPath(paths: SpoolPaths): string {
  return path.join(paths.root, SELF_MEMORY_FILE);
}

/**
 * WHAT THE PROJECT-LESS CHAT REMEMBERS — and until now, it remembered nothing.
 *
 * Every subject had a digest; the master chat had no memory at all. So every
 * cross-subject fact, every preference and every decision that is not about one
 * project had nowhere to live, which is why "ask where I stopped" is a
 * tool-calling expedition each time rather than a read. Same conceptual error
 * the night had before it got a surface: asking a model instead of holding a
 * record.
 *
 * AT THE STORE ROOT, not `experts/_self/`. Under the store's own naming rule
 * `_self` is a legal subject key, so a subject could collide with it.
 *
 * Tolerant like every other read here — never written is the ordinary
 * first-run state, not an error.
 */
export function readSelfMemory(paths: SpoolPaths): SpoolSelfMemory | null {
  try {
    return SpoolSelfMemory.parse(JSON.parse(fs.readFileSync(selfMemoryPath(paths), "utf8")));
  } catch {
    return null;
  }
}

export function writeSelfMemory(paths: SpoolPaths, memory: SpoolSelfMemory): SpoolSelfMemory {
  const parsed = SpoolSelfMemory.parse({ ...memory, schemaVersion: SPOOL_DIGEST_SCHEMA_VERSION });
  atomicWrite(selfMemoryPath(paths), parsed);
  return parsed;
}

/** The same fold the subject digests get, over the same shape. There is no
 *  `summary` here on purpose: an overview of everything is the thing the chat
 *  itself is for, and a second one written by an agent would be a surface
 *  competing with the conversation. */
export function mergeSelfMemory(paths: SpoolPaths, changes: FactChanges): SpoolSelfMemory {
  return writeSelfMemory(paths, {
    schemaVersion: SPOOL_DIGEST_SCHEMA_VERSION,
    updated: changes.at,
    facts: foldFacts(readSelfMemory(paths)?.facts ?? [], changes),
  });
}

/**
 * WHICH FACTS A SUBJECT HAS NOT CHECKED AGAINST THIS COMMIT — the `verify` job's
 * predicate, and the reason that job terminates.
 *
 * PURE, and separated from the job that acts on it so the SELECTION is provable
 * without a provider, exactly as `needsRipening` and `needsDrafting` are.
 *
 * ── ONLY `howItWorks`, AND ONLY UN-RETIRED ──────────────────────────────────
 * A `person` fact is not checkable against a tree and is not an agent's to
 * judge. A `decision` is a record of what was decided, which no file can
 * contradict. An `environment` fact is a CACHE whose truth is the machine's
 * right now, not the repository's — it needs an expiry, not a diff. Only "how
 * this works" is a claim a checkout can settle.
 */
export function factsNeedingVerification(digest: SpoolExpertDigest | null, head: string): SpoolMemoryFact[] {
  if (!digest || !head) return [];
  return digest.facts.filter((fact) => !fact.retired && fact.kind === "howItWorks" && fact.verifiedAt !== head);
}

/**
 * THE `verify` JOB'S WRITE — stamp what still holds, drain what does not.
 *
 * ── WHY THIS IS THE VERB THAT MAKES THE JOB TERMINAL ────────────────────────
 * Every fact named here comes back carrying `verifiedAt: head`, so
 * `factsNeedingVerification` returns fewer next time and nothing on an unchanged
 * tree. That is not a convention — it is the property that lets a maintenance
 * job be a NIGHT job at all, next to `needsRipening` (falsified by writing
 * `fixed`) and `needsDrafting` (falsified by writing `draft`).
 *
 * ── A FACT THAT NO LONGER HOLDS IS DRAINED, NOT CORRECTED ───────────────────
 * The job may retire; it may not rewrite. A pass that could edit a stored fact
 * in place would let an agent quietly change what the project believes with no
 * record of the change — and the record IS the point. Writing the replacement is
 * the next ordinary pass's business, through `foldFacts`.
 */
export function applyVerification(
  paths: SpoolPaths,
  project: string,
  input: { at: string; head: string; checked: Array<{ id: string; holds: boolean; why?: string }> },
): { verified: number; retired: number } | null {
  const digest = readExpertDigest(paths, project);
  if (!digest) return null;

  const verdicts = new Map(input.checked.map((c) => [c.id, c]));
  /**
   * EVERYTHING THIS JOB LOOKED AT — recomputed here rather than trusted from the
   * caller, so the set that gets stamped is exactly the set the predicate
   * selected.
   *
   * ── AND THIS IS WHAT MAKES THE JOB TERMINAL, which it was not ───────────────
   * The first live run stamped only the facts the model NAMED: 6 of 10, with 1
   * drained and 3 left unreported. The prompt asks for exactly that — "if you
   * simply could not find what it refers to, leave that fact out" — so those 3
   * would have stayed selected forever, and every night would have re-run this
   * job, re-read the repository and re-spent the money to learn nothing. That is
   * the "keeps digging" failure the runner's header says is removed at three
   * levels, reintroduced by a fourth.
   *
   * The tests did not catch it because every fixture reported on every fact,
   * which is the one case that does not happen.
   *
   * `verifiedAt` therefore means EXAMINED AT THIS COMMIT AND NOT CONTRADICTED —
   * not "proven true". A fact nothing could be found against has been examined,
   * and re-examining it at the SAME commit would reach the same answer. When the
   * tree moves it is selected again, which is the whole point.
   */
  const selected = new Set(factsNeedingVerification(digest, input.head).map((fact) => fact.id));
  let verified = 0;
  let retired = 0;

  const facts = digest.facts.map((fact) => {
    // Only what this job actually selected. A verdict naming a `person` fact —
    // or one already drained — is ignored rather than honoured, because the job
    // had no business checking it.
    if (!selected.has(fact.id)) return fact;
    const verdict = verdicts.get(fact.id);
    if (verdict && !verdict.holds) {
      retired += 1;
      return {
        ...fact,
        retired: { at: input.at, why: verdict.why?.trim() || "no longer true of this checkout" },
      };
    }
    verified += 1;
    return { ...fact, verifiedAt: input.head };
  });

  writeExpertDigest(paths, { ...digest, facts, updated: input.at });
  return { verified, retired };
}

/**
 * A HUMAN'S OWN VERDICT ON ONE REMEMBERED FACT — the verb that makes memory
 * correctable rather than a ratchet.
 *
 * ── WHY IT IS A SEPARATE, NAMED VERB ─────────────────────────────────────────
 * The same reason `applyDraft` and the departed `setItemVerdict` are: the caller
 * has to MEAN it. A patch type that could reach `retired` would let any tool
 * drain a fact, and the point of this one is that a person did.
 *
 * ── AND WHY A HUMAN MAY RETIRE WHAT AN AGENT MAY NOT ─────────────────────────
 * `foldFacts` refuses to let a pass retire a `person` fact, because nobody but
 * the user can confirm who is involved and how. This verb has no such rule —
 * it IS the user. That asymmetry is the whole design: an agent proposes, a human
 * decides, and the two go through different doors.
 *
 * `subject` ABSENT MEANS THE FRONT DOOR'S OWN MEMORY. Returns null when nothing
 * goes by that id, so a caller can say so rather than reporting a silent
 * success.
 */
export function judgeFact(
  paths: SpoolPaths,
  input: {
    /** The subject whose memory holds it; absent for `memory.json`. */
    subject?: string;
    id: string;
    at: string;
    /** Drain it, with the reason recorded beside it forever. */
    retire?: { why: string };
    /** Confirm it: an agent asserted this and a human has now looked. */
    reviewed?: boolean;
  },
): SpoolMemoryFact | null {
  const stored = input.subject ? readExpertDigest(paths, input.subject) : readSelfMemory(paths);
  if (!stored) return null;
  const found = stored.facts.find((fact) => fact.id === input.id);
  if (!found) return null;

  const next: SpoolMemoryFact = {
    ...found,
    // A HUMAN RE-RETIRING KEEPS THE FIRST REASON TOO. Not because an agent
    // wrote it, but because the reason a thing stopped being true is a fact of
    // its own, and the second telling is never the better one.
    ...(input.retire && !found.retired ? { retired: { at: input.at, why: input.retire.why } } : {}),
    ...(input.reviewed !== undefined ? { reviewed: input.reviewed } : {}),
  };
  const facts = stored.facts.map((fact) => (fact.id === input.id ? next : fact));

  if (input.subject) writeExpertDigest(paths, { ...stored, facts } as SpoolExpertDigest);
  else writeSelfMemory(paths, { ...stored, facts } as SpoolSelfMemory);
  return next;
}

/** What a pass may change about a set of remembered facts: add, and propose
 *  retiring. Never replace — see `foldFacts`. */
export type FactChanges = {
  /** The pass's own label — the same one its timeline events carry, so a fact
   *  traces back to the consultation that produced it. */
  at: string;
  facts: Array<{ text: string; kind: SpoolMemoryFact["kind"] }>;
  retire: Array<{ id: string; why: string }>;
};

/**
 * ONE FOLD, SHARED BY EVERY MEMORY IN THE MODULE — a subject's digest and the
 * front door's own. PURE, so the whole contract is readable in a test with no
 * disk and no provider.
 *
 * The rules it enforces, none of which a schema description could:
 *   · ADD AND RETIRE, NEVER REPLACE. A fact the pass did not mention survives.
 *   · A `person` FACT IS NOT AN AGENT'S TO RETIRE. Nobody but the user can
 *     confirm who is involved and how, so an agent draining one is an agent
 *     settling a human question.
 *   · AN ALREADY-RETIRED FACT KEEPS ITS FIRST REASON. Re-retiring would
 *     overwrite the true one with whatever a later pass happened to say.
 *   · A RESTATED FACT ADDS NOTHING, or a model echoing what it was just told
 *     grows memory every night — the one failure the old wholesale rewrite did
 *     not have, so the fix must not introduce it.
 */
export function foldFacts(stored: SpoolMemoryFact[], changes: FactChanges): SpoolMemoryFact[] {
  const retiring = new Map(changes.retire.map((r) => [r.id, r.why]));
  const facts: SpoolMemoryFact[] = stored.map((fact) => {
    const why = retiring.get(fact.id);
    if (why === undefined || fact.retired || fact.kind === "person") return fact;
    return { ...fact, retired: { at: changes.at, why } };
  });

  for (const proposed of changes.facts) {
    if (!proposed.text.trim()) continue;
    if (facts.some((fact) => sameText(fact.text, proposed.text))) continue;
    facts.push({
      id: newFactId(),
      text: proposed.text.trim(),
      kind: proposed.kind,
      source: { pass: changes.at },
    });
  }
  return facts;
}

export function mergeExpertDigest(
  paths: SpoolPaths,
  project: string,
  pass: FactChanges & {
    summary: string;
    methodology: string;
    glossary: SpoolDigestTerm[];
  },
): SpoolExpertDigest {
  const current = readExpertDigest(paths, project);
  const facts = foldFacts(current?.facts ?? [], pass);

  // MERGED BY TERM, stored order first so a definition keeps its place.
  const glossary: SpoolDigestTerm[] = (current?.glossary ?? []).map((term) => {
    const restated = pass.glossary.find((t) => sameText(t.term, term.term));
    return restated ? { ...term, means: restated.means } : term;
  });
  for (const term of pass.glossary) {
    if (!glossary.some((t) => sameText(t.term, term.term))) glossary.push(term);
  }

  return writeExpertDigest(paths, {
    project,
    schemaVersion: SPOOL_DIGEST_SCHEMA_VERSION,
    updated: pass.at,
    summary: pass.summary,
    methodology: pass.methodology,
    glossary,
    facts,
  });
}

/**
 * Which projects have a digest at all — the master's "where each project was
 * left" band needs to know what it can read before it reads it, and a readdir
 * here beats every surface guessing project names. Tolerant: `[]` when the tree
 * does not exist yet, and a directory holding no readable digest is skipped
 * rather than reported as a project.
 */
export function listExpertDigests(paths: SpoolPaths): SpoolExpertDigest[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.experts);
  } catch {
    return [];
  }
  return names
    .map((n) => readExpertDigest(paths, n))
    .filter((d): d is SpoolExpertDigest => d !== null)
    .sort((a, b) => a.project.localeCompare(b.project));
}

// ── the enrichment pass's write ─────────────────────────────────────────────
//
// THE ONLY WRITER OF `fixed`, `acceptance`, `commitments` AND THE EXPERT'S
// TIMELINE EVENTS. The patch type cannot name any of them, which is what makes
// "the expert's output arrives through one audited verb" true by construction
// rather than by review.
//
// WHAT IT WILL NOT DO, each for a stated law:
//   - IT NEVER TOUCHES `raw`/`rawSource`. `fixed` lands BESIDE the original,
//     which is what lets the user check the expert did not drift.
//   - IT NEVER TOUCHES `lanes.json`. Enrichment is a packet-only write; routing
//     is a different verb, and a pass that could re-file items would be an agent
//     making queue-structure changes as a side effect.
//   - IT NEVER WRITES A STATUS. There is no field to write, and "prepare, never
//     commit" is why.
//   - IT NEVER RE-FLIPS A HUMAN OVERRIDE.
//
// EVERY TIMELINE EVENT IT APPENDS IS `proposal: true`, because that is what
// "agent output awaiting a human look" means on screen.

export type ExpertPass = {
  /** The brief that replaces the shorthand. Optional: a pass may have nothing to
   *  add to a brief that is already right, and rewriting it anyway would churn
   *  the packet and the timeline for no change. */
  fixed?: string;
  acceptance?: string[];
  // `verdict` and its `reasoning` belonged here — the expert's session-or-loom
  // triage. Both went out with looms; see protocol/spool.ts's absence note.
  /** What the pass did to the brief, in the expert's own words — the timeline
   *  line for the enrichment itself, distinct from the verdict's reasoning. */
  note?: string;
  /** Time-commitments mined from THIS item's capture. Text plus coarse label
   *  only; the store mints the ids and the mined-at label, so a caller cannot
   *  backdate one. */
  commitments?: Array<{ text: string; when: string }>;
};

export type ExpertPassResult = {
  item: SpoolItem;
  /** How many timeline events this pass appended. */
  events: number;
  commitments: number;
  /** THE PASS'S OWN LABEL, minted by this function's clock and reported rather
   *  than left to be re-derived, so the digest and the timeline events of one
   *  pass carry the same label. */
  at: string;
};

/** `null` when the item does not exist or cannot be read — not a throw. */
export function applyExpertPass(paths: SpoolPaths, itemId: string, pass: ExpertPass): ExpertPassResult | null {
  const current = getSpoolItem(paths, itemId);
  if (!current) return null;
  assertPacketAddressMatches(itemId, current);

  const at = capturedLabel(new Date());
  const timeline = [...(current.timeline ?? [])];

  // THE OVERRIDE GATE STOOD HERE, and it was the whole of what "advisory" meant:
  // a human's verdict was recorded but never re-flipped by a later pass, while
  // the expert's disagreeing reading still landed on the timeline so the user
  // could see a fresh look had disagreed. Restoring the verdict restores this.
  if (pass.note) timeline.push({ at, actor: "expert", text: pass.note, proposal: true });

  const mined = (pass.commitments ?? []).map((c) =>
    SpoolExpectation.parse({ id: newExpectationId(), text: c.text, when: c.when, itemId, mined: at }),
  );
  if (mined.length > 0) {
    timeline.push({
      at,
      actor: "expert",
      // Named as what it is, so the ripening history reads honestly: the expert
      // heard a promise in the user's own capture. It does NOT create an item —
      // gap detection reads expectations only and never creates an item on its
      // own, and the conservation law says the same thing from the queue's side.
      text: `mined ${mined.length} time-commitment${mined.length === 1 ? "" : "s"} from the capture`,
      proposal: true,
    });
  }

  const next = SpoolItem.parse({
    ...current,
    ...(pass.fixed !== undefined ? { fixed: pass.fixed } : {}),
    ...(pass.acceptance !== undefined ? { acceptance: pass.acceptance } : {}),
    // APPENDED, never replaced: a second pass over a capture that mentions the
    // same sync must not delete the first pass's reading of it, and the user's
    // packet is the audit trail.
    ...(mined.length > 0 ? { commitments: [...(current.commitments ?? []), ...mined] } : {}),
    ...(timeline.length > 0 ? { timeline } : {}),
    schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
  });
  // PACKET ONLY.
  writePacket(paths, next);
  return {
    item: next,
    events: timeline.length - (current.timeline?.length ?? 0),
    commitments: mined.length,
    at,
  };
}

/**
 * WRITE A PROPOSED APPROACH ONTO AN ITEM — the night's only write path.
 *
 * A SEPARATE AUDITED VERB RATHER THAN A WIDENING OF `updateItem`, and the
 * reason is the one already written into `SpoolItemPatch`: the patch type
 * deliberately cannot express a change to `raw`, `fixed`, `acceptance`,
 * `commitments` or `timeline`, because those are the ripening record and a
 * general-purpose patch reaching them would let any caller rewrite what an
 * agent proposed as though a human had. `draft` belongs to that family.
 *
 * WHAT IT WILL NOT DO, each for a stated law:
 *   - IT NEVER TOUCHES `raw`, `fixed` OR `acceptance`. A draft is one opinion
 *     about HOW; the brief is what the work IS. Overwriting the brief with an
 *     approach would make an agent's guess indistinguishable from the thing the
 *     user agreed to.
 *   - IT NEVER TOUCHES `lanes.json`. Drafting is a packet-only write.
 *   - IT NEVER WRITES A STATUS. There is no field, and "prepare, never commit"
 *     is why.
 *
 * ITS TIMELINE EVENT IS ALWAYS `proposal: true` and always `actor: "bed"`, so
 * the ripening history says plainly that this arrived overnight and nobody has
 * looked at it.
 *
 * REPLACES RATHER THAN APPENDS. Unlike a mined commitment — which is part of
 * the audit trail and must never be lost — a draft is a current opinion, and
 * two of them on one packet would be two answers to one question with nothing
 * to choose between them.
 */
export function applyDraft(
  paths: SpoolPaths,
  itemId: string,
  draft: { approach: string; note: string; openQuestions?: string[] },
): { item: SpoolItem; at: string } | null {
  const current = getSpoolItem(paths, itemId);
  if (!current) return null;
  assertPacketAddressMatches(itemId, current);

  const at = capturedLabel(new Date());
  const next = SpoolItem.parse({
    ...current,
    draft: draft.approach,
    /**
     * KEPT AS A LIST, NOT FOLDED INTO THE PROSE. The night used to compose
     * these into `approach` under a "What it would need to know first" heading,
     * which made them unreachable to anything but a reader — and the morning
     * report has to be able to lead with "here is what it could not answer
     * alone", which is a projection over data, not a search through a paragraph.
     *
     * AN EMPTY LIST IS ABSENT rather than `[]`: "asked nothing" and "was never
     * asked" render the same and neither needs a key on disk.
     */
    ...(draft.openQuestions?.length ? { openQuestions: draft.openQuestions } : {}),
    timeline: [...(current.timeline ?? []), { at, actor: "bed", text: draft.note, proposal: true }],
    schemaVersion: SPOOL_ITEM_SCHEMA_VERSION,
  });
  writePacket(paths, next);
  return { item: next, at };
}

/**
 * THE HUMAN'S OWN VERDICT: REMOVED WITH LOOMS.
 *
 * `setItemVerdict` lived here — the only writer of `verdictOverride`, and a
 * SEPARATE NAMED VERB rather than a widening of the patch type, for the reason
 * `promoteSubtask` is one: the caller has to MEAN it. The flag was not patchable,
 * so a tool reaching `updateItem` could never set it, and a verdict written
 * without it is one the next expert pass silently overwrites — a worse lie than
 * refusing. Its timeline event carried `actor: "you"` with NO proposal marker,
 * which was honest only because a human click was the sole way in.
 *
 * It is gone because the verdict it wrote was the question "session or loom?",
 * and half of that answer names a thing this app cannot do. See
 * `protocol/spool.ts`'s absence note, and issue #93.
 */

// ── the pure projections ────────────────────────────────────────────────────
//
// All of these take ALREADY-READ data and touch no disk. That is what makes them
// testable without a sandbox and what keeps the reader surface honest — a
// projection is not a reader. The daemon's handlers are thin callers over them.

/**
 * 1-BASED, because every rendering in the tree is. `null` when the item is in no
 * stack — unfiled, or floating, or simply not there. First stack wins, matching
 * the duplicate arm.
 */
export function rankOf(lanes: SpoolLane[], itemId: string): number | null {
  for (const lane of lanes) {
    const i = lane.items.indexOf(itemId);
    if (i >= 0) return i + 1;
  }
  return null;
}

/**
 * The reconcile rule's four arms, as a pure join. Returns one row per FILED
 * item: every STACKED item first, in lane order then stack order, and THEN every
 * adopted orphan, appended after all of them and ordered by id.
 *
 * SO THE ROWS ARE NOT GLOBALLY IN LANE ORDER whenever an orphan is adopted — an
 * orphan bound for the first lane still comes after the last lane's stacked
 * rows. The RANKS are correct either way, because ranking runs last and per
 * lane; it is the row SEQUENCE that is two concatenated passes. Said plainly
 * because a caller rendering rows in array order would otherwise get it wrong.
 *
 * THE CONSERVATION LAW: this returns ITEMS, never items-plus-subtasks.
 * Decomposition lives inside the item, so breaking work down never grows the
 * queue count.
 */
export function queueSlice(lanes: SpoolLane[], items: SpoolItem[]): SpoolQueueRow[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed = new Set<string>();
  const rows: SpoolQueueRow[] = [];

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
  // lanes.json, is UNFILED and gets no row at all.
  const laneKeys = new Set(lanes.map((l) => l.key));
  for (const item of items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (placed.has(item.id)) continue;
    if (!item.lane || !laneKeys.has(item.lane)) continue;
    rows.push({ lane: item.lane, rank: 0, item });
  }

  // Rank last, over the projection, so an adopted orphan gets the position it
  // actually occupies rather than the one lanes.json would have given it.
  const nextRank = new Map<string, number>();
  return rows.map((r) => {
    const rank = (nextRank.get(r.lane) ?? 0) + 1;
    nextRank.set(r.lane, rank);
    return { ...r, rank };
  });
}

/**
 * SUBJECT ORDER: alphabetical, case-insensitive, and with no clock in it.
 *
 * ALPHABETICAL BECAUSE IT IS THE ONE ORDER THAT COSTS NOTHING TO PREDICT. "Most
 * recently touched" would be a clock deciding what a surface draws, which is the
 * single thing §3.2 of `docs/spool-definition.md` still forbids outright after
 * the redefinition let clocks drive agents; "most items" would make the list
 * jump every time a capture landed. A stable order means a subject stays where
 * the user's hand learned it is.
 *
 * `toLowerCase`, NOT `localeCompare`, and not `toLocaleLowerCase`. Collation is
 * locale- and ICU-dependent, so the same store would order differently on
 * another machine and this order is a contract the suite pins. The two-stage
 * compare exists because folding is LOSSY: "Aurora" and "aurora" are two
 * subjects — the key is the item's own string, verbatim — and comparing only the
 * folded form would leave their relative order down to Map insertion, i.e. down
 * to which one a lane stack happened to mention first.
 */
const compareSubjects = (a: string, b: string): number => {
  const fa = a.toLowerCase();
  const fb = b.toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * THE SUBJECT AXIS — the same readable items, grouped by what they are ABOUT.
 *
 * WHY IT SITS BESIDE `queueSlice` RATHER THAN REPLACING IT. A lane answers "when
 * and where would I do this": it is a GTD context, and the spec's own examples
 * are "Office / work hours" and "Evenings". Real work is not divided that way —
 * `ozom-gv`'s four months are cut by milestone, category and dependency, so all
 * 29 of its open issues would land in one lane called Office and the lane axis
 * would carry no information. The subject leads; the lane rides on the row.
 * Nothing here is a migration: same `lanes.json`, same stacks, same reconcile
 * rule, and `rows` still ships from the same read.
 *
 * THE ORDER INSIDE A GROUP IS INHERITED, NEVER INVENTED. `queueSlice` is CALLED
 * rather than re-walked, so a row's lane, its rank and its position are the ones
 * the queue itself would show: the two views cannot drift about where an item
 * sits, and the reconcile rule's four arms are applied once, in the one place
 * that owns them. What the user expressed by ordering a stack is what orders the
 * subject — this projection adds no opinion of its own to it.
 *
 * THEN THE ITEMS THE QUEUE CANNOT SHOW. `queueSlice` drops the unfiled — no lane,
 * or a lane that is gone — because a queue has nowhere to draw a row that belongs
 * to no stack. The subject view has somewhere: its subject. Those rows are
 * appended after every stacked row of the same subject, in input order, carrying
 * NO lane and NO rank, because inventing either would render an item as filed
 * when it is not.
 *
 * CONSERVATION IS A LAW HERE, the same one the queue footer states: every
 * readable item appears in EXACTLY ONE group, and the rows across all groups
 * total the item count. Not "most items" — a subject view that quietly omitted
 * the floating ones would be a delete path that never calls `rmSync`, which is
 * the arm of "no deletion path" a naming check cannot reach.
 *
 * FLOATING IS A GROUP, NOT AN ERROR, and it sorts last so the named subjects read
 * first. It is emitted only when something is in it: an empty trailing group is a
 * heading with nothing under it.
 */
export function subjectSlice(lanes: SpoolLane[], items: SpoolItem[]): SpoolSubjectGroup[] {
  // TWO BUCKETS, NOT ONE MAP WITH A SENTINEL KEY. Lanes are data and so are
  // subjects: any readable string a sentinel could use — "floating", "none",
  // "unfiled" — is a project name someone may type, and the day they do, their
  // subject and the floating pile silently become one group.
  //
  // AN EMPTY PROJECT STRING IS FLOATING, not a subject of its own. A group whose
  // heading has no name is one the user cannot address or file anything into, so
  // "" is the absence it plainly is, not a subject rendered with a blank name.
  const named = new Map<string, SpoolSubjectRow[]>();
  const floating: SpoolSubjectRow[] = [];

  const file = (row: SpoolSubjectRow): void => {
    const project = row.item.project;
    if (!project) {
      floating.push(row);
      return;
    }
    const rows = named.get(project);
    if (rows) rows.push(row);
    else named.set(project, [row]);
  };

  // Pass 1 — everything the lane join placed, in the order it placed it.
  const filed = new Set<string>();
  for (const row of queueSlice(lanes, items)) {
    filed.add(row.item.id);
    file({ item: row.item, lane: row.lane, rank: row.rank });
  }

  // Pass 2 — the remainder, which is precisely the unfiled: arm 3's item with no
  // readable lane. Input order is `listItems`' order, which is the packet
  // directory sorted by id, so two reads of the same disk state agree.
  for (const item of items) {
    if (filed.has(item.id)) continue;
    file({ item });
  }

  const groups: SpoolSubjectGroup[] = [...named.entries()]
    .sort(([a], [b]) => compareSubjects(a, b))
    .map(([project, rows]) => ({ project, rows }));
  if (floating.length > 0) groups.push({ rows: floating });
  return groups;
}

/**
 * The queue footer's "agents added N" count. `createItem` stamps
 * `provenance: "session"` for every write that came through the tool wall and
 * `"you"` for the human API's own form (`NewSpoolItem.source`), so counting
 * items with the EXACT string "session" is counting items an agent filed — as
 * distinct from a note, a pasted transcript, a chat capture, a mirror sync, or
 * a workbench form the human drove by hand. A live drive caught the lie this
 * distinction repairs: a hand-made item was counted into "agents added", and
 * the conservation line claimed an agent did what the user did. Every packet
 * from before `source` existed carries "session" and keeps counting, which is
 * the historical truth: they WERE agent-filed.
 */
export function agentsAddedCount(items: SpoolItem[]): number {
  return items.filter((i) => i.provenance === "session").length;
}

/**
 * Every time-commitment the expert has mined, flattened out of the items that
 * hold them.
 *
 * IT RETURNS EXPECTATIONS AND NOTHING ELSE — no "is it overdue", no bucketing,
 * no comparison against a clock. Gap detection's success condition is a line in
 * a briefing the human ARRIVES at, not a trigger. Ordered by the item they came
 * from, then by mining order within it, so two reads of the same disk state
 * produce the same list.
 */
export function minedCommitments(items: SpoolItem[]): SpoolExpectation[] {
  return items
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((i) => i.commitments ?? []);
}

/**
 * The right rail's cards, from ITEM FIELDS ALONE — the desk item is "a
 * projection of an item the agents just touched, not a separate store". Unfiled
 * items appear here too, which is the point: an item the master could not place
 * is exactly the one the human needs to see.
 *
 * DISMISSAL IS `updateItem({desk: false})`, and it DRAINS THE ITEM TO THE QUEUE
 * rather than deleting anything: the item keeps its lane and its rank. "No
 * deletion path" is untouched.
 */
export function deskSlice(items: SpoolItem[]): SpoolDeskCard[] {
  return items
    .filter((i) => i.desk === true)
    .map((i) => {
      const subtasks = i.subtasks ?? [];
      /**
       * READ OFF THE PACKET, never stored. `captured` is the user's words
       * alone; `briefed` means an expert has been over it; `drafted` means an
       * approach is waiting too. Three readings, no status field, so this can
       * never become the accept path the module refuses.
       */
      const stage = i.draft ? "drafted" : i.fixed ? "briefed" : "captured";
      /**
       * THE ONE THING ONLY THE HUMAN CAN DO, and absent when the answer is
       * "nothing, it is the agents' turn". Ordered by what blocks the most: an
       * item with no subject cannot be ripened at all, so it is asked for first.
       *
       * IT INSTRUCTS RATHER THAN INTERROGATES. This field replaces the string
       * "unplaced — what is it?", which put the assistant in the position of
       * questioning the user about their own capture.
       *
       * AND IT EXPLAINS NOTHING ABOUT THE PAST. It read "Place it in a lane —
       * the one it named does not exist", which is TRUE (the flag is set exactly
       * when a create names a missing lane) and useless: it names no lane, so
       * the reader cannot tell which one was meant, and it accounts for an
       * internal event they did not cause and cannot check. Rendered three times
       * down a desk it was the same defect as an unexplained "Ana is waiting" —
       * the system reporting something nobody can understand by reading it. An
       * instruction is the whole job of this field, so it is only that.
       */
      // A CLOSED ITEM ASKS FOR NOTHING. The user has closed it; instructing
      // them to place or file it would be the tracker outliving the task.
      const needsYou = i.closed
        ? undefined
        : !i.project
          ? "Give it a subject so an expert can read it"
          : i.unplaced
            ? "Say which lane this belongs in"
            : undefined;
      return {
        id: i.id,
        title: i.title,
        stage: stage as SpoolDeskCard["stage"],
        ...(i.project ? { project: i.project } : {}),
        ...(i.mirrored ? { mirrored: i.mirrored } : {}),
        ...(i.deadline ? { deadline: i.deadline } : {}),
        // The user's own day rides to the desk like every other chip — drawn,
        // never compared against a clock here or anywhere downstream.
        ...(i.pinned ? { pinned: i.pinned } : {}),
        ...(needsYou ? { needsYou } : {}),
        /**
         * WHAT A DRAFT COULD NOT ANSWER ALONE, carried onto the card.
         *
         * `docs/spool-definition.md` §8 asks the morning to show "the question
         * it could not answer alone" IN ONE SCREEN. A count would only tell the
         * user there is somewhere else to go, so the questions travel whole —
         * the desk is the handful of items an agent just touched, not the
         * queue, so this is a few strings and not a payload.
         */
        ...(i.openQuestions?.length ? { openQuestions: i.openQuestions } : {}),
        ...(i.unplaced ? { unplaced: true } : {}),
        /**
         * THE DONE SHELF RIDES IN THE SAME PAYLOAD. A closed card is not
         * dropped — that would be a delete path wearing a filter's name, and
         * `totalItems` would disagree with what is drawable. The web excludes
         * closed cards from the active slices and renders them on the shelf.
         */
        ...(i.closed ? { closed: i.closed } : {}),
        ...(subtasks.length > 0
          ? { subtasks: { done: subtasks.filter((s) => s.done).length, total: subtasks.length } }
          : {}),
      };
    });
}

/** Extensions that render as a picture. Everything else is a file. Coarse on
 *  purpose: the tally is a presence signal in the UI ("2 files · 1 mockup"), not
 *  a content type system. */
const MOCKUP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

/**
 * NOT AN ATTACHMENT: this store's OWN crash residue, and the operating system's.
 * The atomic writer writes a unique `.tmp-…` and renames; a crash between the two
 * leaves it behind, and the tally would then report the user's own failed write
 * back to them as "1 file". `.DS_Store` is Finder's, and a user who opened the
 * packet directory once should not be told they attached something.
 */
const isNotAnAttachment = (name: string): boolean =>
  name === PACKET_FILE || name === ".DS_Store" || name.includes(".tmp-");

/**
 * The `{files, mockups}` tally — DERIVED AT READ TIME AND NEVER PERSISTED. That
 * is what makes "an item growing attachments needs no migration" true by
 * construction: dropping a file beside the packet changes the tally and rewrites
 * nothing.
 *
 * Takes NAMES, so it is pure and disk-free. Callers pass FILE names only. The
 * packet itself is excluded here, where the name is known, rather than at every
 * call site.
 */
export function attachmentTally(names: string[]): SpoolAttachmentTally {
  let files = 0;
  let mockups = 0;
  for (const name of names) {
    if (isNotAnAttachment(name)) continue;
    if (MOCKUP_EXT.has(path.extname(name).toLowerCase())) mockups++;
    else files++;
  }
  return { files, mockups };
}

// NO `packetAttachmentDir` EXPORT LIVES HERE, and its absence is load-bearing.
// The donor added one so a handoff could write "Attachments (in <abs packet
// dir>): …" into a loom's context manifest. A loom cannot follow that path: the
// spool sits outside every session's working root and no module may grant it, and
// a loom mounts no spool tools — so under Codex's purely path-based sandbox the
// pointer is unfollowable, and under Claude it would "work" only by being the
// exact leak that boundary exists to forbid. The handoff NAMES attachments
// instead and says plainly that the bytes stayed in the spool. Do not re-add this
// export; a caller that wants the bytes comes through the port like everyone else.

/** The one disk read that feeds `attachmentTally`. `[]` for an item with no
 *  attachments — the bare-todo case, which is the common one. */
export function readPacketAttachments(paths: SpoolPaths, id: string): string[] {
  let dir: string;
  try {
    dir = packetDir(paths, id);
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
