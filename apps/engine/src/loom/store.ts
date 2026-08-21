/**
 * The Loom store: the ONE owning module for `<engineRoot>/looms`, and the only
 * thing in the engine that reads or writes it.
 *
 * Modelled beat-for-beat on `apps/engine/src/spool/store.ts`, because the two
 * subtrees have the same shape of problem and a second dialect for it would be
 * a second set of rules to keep in your head. Every discipline is carried over
 * verbatim:
 *
 *   1. THE ROOT ARRIVES AS AN ARGUMENT. Every verb takes `LoomPaths` first.
 *      That is the engine's own convention (`files.ts`, `gitignore.ts`,
 *      `spool/store.ts`) and it is what lets a test drive a temp directory
 *      without touching the process environment.
 *   2. THE SHAPES COME FROM THE PROTOCOL. `@telar/engine-client`'s
 *      `protocol/loom.ts` owns them, because the persisted shape and the wire
 *      shape are one definition here.
 *   3. READS ARE TOLERANT PER ROW, WRITES ARE LOUD. One corrupt loom file must
 *      not cost the caller the other ninety-nine; a write that cannot be made
 *      valid throws a sentence naming the file and the next move.
 *   4. ID TRAVERSAL IS GUARDED TWICE — a regex AND a containment re-check — on
 *      every id that reaches the filesystem.
 *   5. EVERY DOCUMENT WRITE GOES THROUGH `atomicWrite`. The ledger is the one
 *      declared O_APPEND exception (loom-build.md §9), and it is the only one.
 *
 * ── THE LAYOUT ──────────────────────────────────────────────────────────────
 *
 *   <engineRoot>/looms/
 *     <projectId>/
 *       looms/<loomId>.json   one Loom each
 *       ledger.jsonl          append-only, one JSON object per line
 *       triage.json           the classification cache, keyed by item ref
 *       watch.json            the sentinel's runtime record + its fingerprint
 *
 * ── THE ONE FILE THAT IS NOT HERE ───────────────────────────────────────────
 * The Program lives in the PROJECT REPO at `.telar/loom.md`, not under
 * `engineRoot`, and loom-build.md §9 gives the reason: it is portable,
 * diffable, reviewable and travels with the project. A loom RECORD is a fact
 * about this machine's worktrees and belongs to this machine; the Program is a
 * statement about the project and belongs to the repo. `readProgramDoc` /
 * `writeProgramDoc` at the bottom of this file are the only two verbs that
 * reach outside `paths.root`, and they take the project's own root explicitly
 * rather than resolving it, so the containment guard has something to check
 * against.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Fingerprint,
  LedgerEntry,
  Loom,
  LoomState,
  LoomWatch,
  TriageEntry,
  type LoomProgramDoc,
  type LoomRun,
  type LoomUnreadable,
} from "@telar/engine-client";
import { atomicWrite } from "../atomic";
import { parseProgram } from "./program";

// ── the layout ──────────────────────────────────────────────────────────────

/**
 * Every path this module owns, resolved once from the engine's state root.
 *
 * ONE FIELD, AND THAT IS NOT AN OVERSIGHT. The spool's `SpoolPaths` names five
 * entries because five of them are addressed directly by callers outside the
 * store. Everything under `looms/` is addressed BY PROJECT, and a project id is
 * caller-supplied — so the per-project paths cannot be resolved once at
 * construction, they have to go through the traversal guard on every call.
 * `projectDir` and `loomFile` below are those resolvers, and they are exported
 * for the same reason `SpoolPaths` is a record: a caller that needs to NAME a
 * file to a human gets it from here rather than composing one of its own.
 */
export type LoomPaths = {
  /** `<engineRoot>/looms`. */
  root: string;
};

export function loomPaths(engineRoot: string): LoomPaths {
  return { root: path.join(engineRoot, "looms") };
}

/** The filenames, as values, because the writer, the reader and every
 *  diagnostic that NAMES a file to a human have to agree about them. */
const LOOMS_DIR = "looms";
const LEDGER_FILE = "ledger.jsonl";
const TRIAGE_FILE = "triage.json";
const WATCH_FILE = "watch.json";
/** The Program's path INSIDE the project repo — see the header. */
const PROGRAM_DIR = ".telar";
const PROGRAM_FILE = "loom.md";

/**
 * THE STORE'S OWN ENTRIES — what a session's file tools must not be able to
 * rewrite, the same channel `spool/store.ts:120` fills.
 *
 * THE WHOLE SUBTREE, not a list of leaves, and the difference is the ledger: it
 * is the append-only record of what the system did overnight, and a session
 * that could rewrite it could erase its own history. There is no readable
 * sibling here that a session legitimately needs (the Program, which sessions
 * DO read, deliberately lives in the project repo instead), so protecting the
 * root costs nothing and leaves no gap to reason about.
 */
export function storeEntries(paths: LoomPaths): readonly string[] {
  return [paths.root];
}

/**
 * The traversal guard, applied to a project id. THE REGEX PLUS THE CONTAINMENT
 * RE-CHECK, and both halves are load-bearing for the reason the spool's donor
 * measured: with the regex deleted, `../escaped` still throws on the re-check;
 * with BOTH deleted, a readable loom file planted outside the store becomes
 * reachable by id. The re-check cannot FIRE while the regex stands — and it is
 * the half that holds if the regex ever goes.
 *
 * A leading dot is refused separately from the character class, because `.` and
 * `..` both pass `[A-Za-z0-9_.-]+` and both name a directory that is not a
 * project.
 *
 * THROWS. Readers catch and report not-found or unreadable; writers let it out,
 * because a write to a name this store cannot address must be loud.
 */
export function projectDir(paths: LoomPaths, projectId: string): string {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_.-]+$/.test(projectId) || projectId.startsWith(".")) {
    throw new Error(`invalid project id for the loom store: ${JSON.stringify(projectId)}`);
  }
  const dir = path.join(paths.root, projectId);
  const withSep = paths.root.endsWith(path.sep) ? paths.root : paths.root + path.sep;
  if (!dir.startsWith(withSep)) throw new Error(`invalid project id for the loom store: ${JSON.stringify(projectId)}`);
  return dir;
}

/** Same guard, one level down, on the loom id. Separate from `projectDir`'s so
 *  the sentence names the right thing: "invalid loom id" and "invalid project
 *  id" send a human to two different files. */
export function loomFile(paths: LoomPaths, projectId: string, loomId: string): string {
  if (typeof loomId !== "string" || !/^[A-Za-z0-9_-]+$/.test(loomId)) {
    throw new Error(`invalid loom id: ${JSON.stringify(loomId)}`);
  }
  const base = path.join(projectDir(paths, projectId), LOOMS_DIR);
  const file = path.join(base, `${loomId}.json`);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!file.startsWith(withSep)) throw new Error(`invalid loom id: ${JSON.stringify(loomId)}`);
  return file;
}

/**
 * ── A MALFORMED ID AND AN ABSENT FILE ARE DIFFERENT FAILURES ────────────────
 *
 * Every reader below RESOLVES ITS PATH OUTSIDE the try that tolerates a missing
 * file, and that separation is load-bearing rather than stylistic. Composed
 * inside it, `projectDir`'s traversal throw lands in the same `catch` as ENOENT
 * and a refused id comes back as the empty first-run state — so
 * `?project=../../etc` answered 200 with an empty ledger instead of a refusal.
 * The guard was present and correct; it simply never reached the caller.
 *
 * The rule, stated once for all four readers:
 *   MALFORMED ID  → THROWS. The caller named something that cannot exist, and
 *                   an empty answer would be a claim about a project rather
 *                   than a refusal to address one. `state.ts`'s `loomWrite`
 *                   turns it into `invalid_request` with the sentence intact.
 *   ABSENT/UNREADABLE FILE → the empty or default state. A project that has
 *                   never run is the ordinary case, not an error.
 */
/** `projectDir`'s guard, applied for its throw and not for its path — the
 *  spelling a caller uses when it needs a caller-supplied id REFUSED before
 *  anything tolerant gets hold of it. Returns the id so it can be used inline. */
function assertProjectId(paths: LoomPaths, projectId: string): string {
  projectDir(paths, projectId);
  return projectId;
}

const ledgerFile = (paths: LoomPaths, projectId: string) => path.join(projectDir(paths, projectId), LEDGER_FILE);
const triageFile = (paths: LoomPaths, projectId: string) => path.join(projectDir(paths, projectId), TRIAGE_FILE);
const watchFile = (paths: LoomPaths, projectId: string) => path.join(projectDir(paths, projectId), WATCH_FILE);

// ── ensure ──────────────────────────────────────────────────────────────────

/**
 * Idempotent and safe to re-enter. Creates the root and NOTHING ELSE.
 *
 * NO SEED, unlike the spool's. A lane structure has to exist before anything
 * can be filed into it, so that store seeds one row; a loom store's empty state
 * is genuinely empty and every per-project directory is created lazily by the
 * first write into it. Seeding a project directory here would mean inventing a
 * project id, and this module has no business knowing any.
 */
export function ensureLooms(paths: LoomPaths): void {
  fs.mkdirSync(paths.root, { recursive: true });
}

/** Every project id the store has ever written for, in sorted order. Directories
 *  only: a stray file under `looms/` is not a project and is not reported as a
 *  broken one. `[]` when the store has never been written, which is the ordinary
 *  first-run state and never an error. */
export function listProjectIds(paths: LoomPaths): string[] {
  try {
    return fs
      .readdirSync(paths.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ── looms ───────────────────────────────────────────────────────────────────

/**
 * One loom, by project and id. `null` on absent, on a malformed or traversal id,
 * and on a file that will not parse — NEVER a throw. A caller that needs the
 * REASON reads `listLooms`' `unreadable` channel instead.
 *
 * THE ADDRESS CHECK IS HERE TOO, not only in `listLooms`, and it is not
 * redundant: `writeLoom` files a loom under the projectId and id the RECORD
 * carries, so handing back a record whose fields disagree with the file it was
 * read from would mean the very next write lands somewhere else and clobbers a
 * loom nobody named. A read that cannot be safely written back is not an
 * answer.
 */
export function readLoom(paths: LoomPaths, projectId: string, loomId: string): Loom | null {
  let file: string;
  try {
    file = loomFile(paths, projectId, loomId);
  } catch {
    return null;
  }
  try {
    const parsed = Loom.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) return null;
    if (parsed.data.id !== loomId || parsed.data.projectId !== projectId) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * One loom by id ALONE, without knowing its project.
 *
 * ── THE DECISION, AND WHY IT IS A SCAN ──────────────────────────────────────
 * `GET /v2/looms/:loomId`, `cancelLoom(loomId)` and `answerLoom(loomId, …)` all
 * address a loom by id and nothing else, so this lookup has to exist. The two
 * candidate implementations were:
 *
 *   (a) ENCODE THE PROJECT IN THE ID — mint `<projectId>.<random>` and split it
 *       back apart here. One `stat`, no scan.
 *   (b) SCAN THE PROJECT DIRECTORIES — `readdir` over `looms/`, try each.
 *
 * (b) WINS, and the reason is that (a) makes the id a COMPOUND KEY that has to
 * stay true. A project id appears in a loom id that is written into ledger
 * lines, branch names, session records and URLs; re-registering a project under
 * a new id — which `registerProject` allows, since the id is minted per
 * registration and keyed on root — would strand every existing loom behind an
 * id that no longer parses, and the failure would be silent (`not_found`) at
 * exactly the moment somebody is trying to cancel something. Worse, it puts a
 * caller-supplied string inside another caller-supplied string, which means the
 * traversal guard has to reason about a split rather than a whole.
 *
 * THE COST IS BOUNDED BY CONSTRUCTION: one `readdir` over a handful of project
 * directories, and the id file is `stat`ed directly inside each — there is no
 * per-loom scan. A machine with ten projects does ten `existsSync` calls.
 *
 * `Loom.projectId` is therefore the ONE authority on which project a loom
 * belongs to, and the directory it sits in must agree — `writeLoom` derives the
 * directory FROM that field, so the two cannot diverge through this module.
 */
export function getLoom(paths: LoomPaths, loomId: string): Loom | null {
  for (const projectId of listProjectIds(paths)) {
    const loom = readLoom(paths, projectId, loomId);
    if (loom) return loom;
  }
  return null;
}

/**
 * Every readable loom, plus everything the store could not make sense of.
 *
 * TWO CHANNELS, ONE CALL. A caller that only got `looms` would have no way to
 * tell "this project has three looms" from "this project has three looms and
 * two files that will not parse" — and the second reading is the one where an
 * overnight run silently stopped reconciling something that is still holding a
 * worktree.
 *
 * TOLERANCE IS PER ROW, NOT PER FILE. `Loom.array().safeParse` over a directory
 * read — the obvious spelling — is ALL-OR-NOTHING: one hand-edited or
 * half-written file and the caller's entire deck goes empty, which reads
 * exactly like "nothing is running". So each file is parsed on its own and the
 * failures are REPORTED rather than swallowed.
 *
 * `projectId` omitted means every project, in sorted order, which is what the
 * deck asks for.
 */
export function listLooms(paths: LoomPaths, projectId?: string): { looms: Loom[]; unreadable: LoomUnreadable[] } {
  const looms: Loom[] = [];
  const unreadable: LoomUnreadable[] = [];
  // AN EXPLICIT PROJECT ID IS GUARDED EAGERLY, AND IT THROWS. The caller named
  // one specific project, so a malformed name is a refusal — reporting it as an
  // `unreadable` row would be a 200 describing a project that cannot exist.
  // Ids from `listProjectIds` come off a `readdir` and cannot be malformed, so
  // the whole-store scan has nothing to refuse.
  const projects = projectId === undefined ? listProjectIds(paths) : [assertProjectId(paths, projectId)];

  for (const project of projects) {
    let dir: string;
    try {
      dir = path.join(projectDir(paths, project), LOOMS_DIR);
    } catch (e) {
      unreadable.push({ file: project, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".json"))
        .map((d) => d.name)
        .sort();
    } catch {
      continue; // a project with no looms directory has no looms; not an error
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const loomId = name.slice(0, -".json".length);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        unreadable.push({
          file,
          reason: `${name} is not valid JSON (${e instanceof Error ? e.message : String(e)}). It is SKIPPED and every other loom is unaffected; nothing was rewritten. Fix the file by hand, or move it aside.`,
        });
        continue;
      }
      const parsed = Loom.safeParse(raw);
      if (!parsed.success) {
        unreadable.push({
          file,
          reason: `${name} could not be read as a loom (${parsed.error.issues
            .map((s) => `${s.path.join(".") || "<record>"}: ${s.message}`)
            .join("; ")}). It is SKIPPED and every other loom is unaffected; nothing was rewritten.`,
        });
        continue;
      }
      // THE ADDRESS IS THE FILE, NEVER THE CONTENT — the same rule the spool's
      // `assertPacketAddressMatches` enforces on write. A hand-edited record
      // whose `id` or `projectId` disagrees with where it sits would otherwise
      // be returned under one address and rewritten under another, clobbering a
      // loom nobody named.
      if (parsed.data.id !== loomId || parsed.data.projectId !== project) {
        unreadable.push({
          file,
          reason: `${name} carries id ${JSON.stringify(parsed.data.id)} and projectId ${JSON.stringify(
            parsed.data.projectId,
          )}, which is not where it sits (${project}/${LOOMS_DIR}/${name}). A loom's ADDRESS is its file, so returning this record would hand out a loom that any write would then save somewhere else. Nothing was rewritten — fix the fields by hand, or move the file.`,
        });
        continue;
      }
      looms.push(parsed.data);
    }
  }

  return { looms, unreadable };
}

/**
 * Write one loom. `Loom.parse` — THROWING, not `safeParse` — then `atomicWrite`.
 *
 * THE LOUD WRITE IS THE POINT. A read is tolerant because the alternative is
 * losing a record the store did not create; a write is loud because the
 * alternative is persisting a loom in a state the machine cannot advance, which
 * is how a worktree ends up held open forever by a record nothing will ever
 * reconcile.
 *
 * THE DIRECTORY IS DERIVED FROM `loom.projectId`, never passed alongside it, so
 * there is no call site that can file a loom under a project it does not claim.
 */
export function writeLoom(paths: LoomPaths, loom: Loom): Loom {
  const parsed = Loom.parse(loom);
  atomicWrite(loomFile(paths, parsed.projectId, parsed.id), parsed);
  return parsed;
}

// ── the ledger ──────────────────────────────────────────────────────────────

/**
 * Append one line to `<projectId>/ledger.jsonl`.
 *
 * THE O_APPEND EXCEPTION, and the only one in this module. loom-build.md §9:
 * "The ledger appends with `O_APPEND` and one JSON object per line, so a torn
 * write costs one line, not the file." Routing this through `atomicWrite` would
 * mean read-whole-file, concatenate, write-whole-file on every tick — which
 * turns an O(1) append into an O(n) rewrite of a file that only grows, and
 * turns a torn write from "one bad line" into "the whole overnight record".
 *
 * `fs.appendFileSync` opens with `a`, which is `O_APPEND`. The entry is
 * validated first: a line that will not parse is a line the reader will skip
 * forever, so writing one would be a silent hole in the record.
 */
export function appendLedger(paths: LoomPaths, projectId: string, entry: LedgerEntry): void {
  const parsed = LedgerEntry.parse(entry);
  const dir = projectDir(paths, projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, LEDGER_FILE), `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
}

/**
 * The ledger, oldest first — NEWEST LAST, which is reading order for a
 * narrative and is what the tick's "last N entries" input wants without a
 * reverse at the call site.
 *
 * `limit` TAILS. `readLedger(paths, id, 40)` is the last forty things that
 * happened, still in reading order.
 *
 * A MALFORMED LINE IS SKIPPED, NEVER THROWN. That is the other half of the
 * O_APPEND bargain: a torn write costs one line only if the reader is willing
 * to step over it. A blank line — the trailing newline every append leaves —
 * is not a fault and is not counted as one.
 */
export function readLedger(paths: LoomPaths, projectId: string, limit?: number): LedgerEntry[] {
  const file = ledgerFile(paths, projectId); // THROWS on a malformed id — see above
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // never written is the ordinary first-run state
  }
  const entries: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // a torn line costs itself and nothing else
    }
    const parsed = LedgerEntry.safeParse(value);
    if (parsed.success) entries.push(parsed.data);
  }
  if (limit === undefined || !Number.isFinite(limit) || limit < 0) return entries;
  return entries.slice(Math.max(0, entries.length - Math.floor(limit)));
}

// ── the triage cache ────────────────────────────────────────────────────────

/**
 * THE ON-DISK SHAPE OF `triage.json`, KEYED BY THE PROJECT'S OWN ITEM REF —
 * declared here rather than on the wire, because it is not a wire shape.
 * §15.1's `loomTriage()` hands the surface `{entries: TriageEntry[]}`; the deck
 * renders a grouped list and has no use for a lookup table. What NEEDS the
 * lookup is §7's invalidation rule — "only items whose classification is stale
 * get re-read", which is an equality check on `updatedAt` per item ref — and
 * that is a store-and-runtime concern.
 *
 * A RECORD RATHER THAN AN ARRAY, so the same item cannot appear twice. An array
 * would make "re-classify this one item" a find-and-splice, and the first
 * writer to get it wrong would silently double the cache's most expensive
 * field.
 *
 * `loom/triage.ts`'s `staleItems`/`pruneCache` take exactly this shape, so the
 * store's output feeds them with no conversion.
 */
export type TriageCache = Record<string, TriageEntry>;

/**
 * The classification cache, keyed by the project's own item ref.
 *
 * TOLERANT PER ROW, like every other read here: one hand-edited entry that will
 * not parse must not cost the human every OTHER item's classification — which
 * is the expensive half (a whole comment thread distilled into `ask`) and the
 * thing the cache exists to avoid recomputing.
 *
 * `{}` when absent. Derived and rebuildable by construction, so an empty cache
 * is a cold cache and never an error.
 */
export function readTriage(paths: LoomPaths, projectId: string): TriageCache {
  const file = triageFile(paths, projectId); // THROWS on a malformed id — see above
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const cache: TriageCache = {};
  for (const [item, row] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = TriageEntry.safeParse(row);
    if (!parsed.success) continue;
    cache[item] = parsed.data;
  }
  return cache;
}

/** Loud, like every write here: an entry that will not parse throws rather than
 *  landing in a cache the reader will then silently skip forever. */
export function writeTriage(paths: LoomPaths, projectId: string, cache: TriageCache): TriageCache {
  const parsed: TriageCache = {};
  for (const [item, entry] of Object.entries(cache)) parsed[item] = TriageEntry.parse(entry);
  atomicWrite(triageFile(paths, projectId), parsed);
  return parsed;
}

// ── the sentinel's watch record ─────────────────────────────────────────────

/**
 * ONE FILE FOR THE SCHEDULE AND THE FINGERPRINT, and they are stored together
 * on purpose. loom-build.md §9 lists the fingerprint as its own document, but
 * every read of one is a read of the other — the supervisor's loop is "compare
 * the fingerprint, then decide when to look again", a single decision made from
 * a single record. Two files would be two writes per quiet probe with a window
 * between them in which the interval has backed off but the hash has not, and
 * nothing to tell a reader which half is stale.
 *
 * `fingerprint` is OPTIONAL because a project that has never probed genuinely
 * has none, and an empty-string placeholder would compare equal to a probe that
 * printed nothing — which is a real thing a `cat inbox.md`-style probe does on
 * an empty inbox.
 */
export type LoomWatchRecord = {
  watch: LoomWatch;
  fingerprint?: Fingerprint;
  /**
   * THE PROJECT'S CONVERSATIONAL ORCHESTRATOR SESSION — the room a human talks
   * to, surfaced as `LoomProjectSummary.orchestratorSessionId`.
   *
   * HERE RATHER THAN IN A FILE OF ITS OWN, for the reason the fingerprint is:
   * it is per-project supervisor state, read on the same pass as the schedule,
   * and a fifth document would be a fifth thing to keep consistent for one
   * string. ABSENT IS A STATE — nobody has run setup here yet — and the surface
   * renders the invitation rather than an empty cockpit.
   */
  orchestratorSessionId?: string;
};

/**
 * The default for a project that has never run.
 *
 * `running: false` IS THE ONLY SAFE DEFAULT. A store that has never been
 * written must not report a watch as running: the supervisor would then be a
 * second opinion about whether it is running, and the first thing anybody does
 * with a "running" watch is not start it.
 *
 * The interval defaults match `LoomWatchPolicy`'s in the Program (300s → 3600s,
 * loom-build.md §6). They are re-stated here rather than imported from a parsed
 * Program because this record must exist for a project with NO Program at all —
 * that is precisely the never-run case.
 *
 * `nextProbeAt` IS DELIBERATELY ABSENT AND MUST STAY ABSENT. Stamping one here
 * to make the record look "complete" would be this function inventing a
 * schedule for a watch that is not running — and it would destroy the one
 * signal that separates the two states in `readWatchRecord`'s note below.
 */
export function defaultWatch(projectId: string): LoomWatch {
  return { projectId, running: false, intervalSec: 300, quietChecks: 0 };
}

/**
 * The whole record, defaults included.
 *
 * DEGRADES FOR A PROJECT THAT HAS NEVER RUN AND FOR AN UNREADABLE FILE — the
 * watch is a derived scheduling fact, and refusing to answer would stop the
 * supervisor rather than degrade it.
 *
 * THROWS FOR A MALFORMED ID, which is the distinction the first cut of this
 * collapsed. Handing back `defaultWatch("../../etc")` is not a degraded answer,
 * it is a fabricated record naming a project that cannot exist — and it would
 * have been reported to a surface as a real, stopped watch.
 *
 * ── "RESUMED BUT NOT YET DUE" vs "NEVER ARMED" ──────────────────────────────
 * These two look identical in BEHAVIOUR — no probe fires under either — and a
 * route test reading this record once nearly filed a regression against this
 * module over it. They are NOT identical in the RECORD, and the difference is
 * worth knowing before reaching for a debugger:
 *
 *   never armed   → `running: false`, and `nextProbeAt` ABSENT.
 *   armed, waiting → `running: true`, and `nextProbeAt` a timestamp in the
 *                    future — up to a whole `intervalSec` away, so with the
 *                    default 300s cadence a freshly resumed daemon correctly
 *                    does nothing at all for five minutes.
 *
 * So the question "did resume work?" is answered by `running` plus the PRESENCE
 * of `nextProbeAt`, never by watching for a probe within a test's patience. A
 * test that needs to see one fires it by putting a one-second cadence in the
 * Program, not by waiting on the default.
 *
 * This is why `defaultWatch` above leaves `nextProbeAt` absent: it is the only
 * thing distinguishing the two, and a "helpful" default would collapse them.
 */
export function readWatchRecord(paths: LoomPaths, projectId: string): LoomWatchRecord {
  const file = watchFile(paths, projectId); // THROWS on a malformed id — see above
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { watch: defaultWatch(projectId) };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { watch: defaultWatch(projectId) };
  const row = raw as { watch?: unknown; fingerprint?: unknown; orchestratorSessionId?: unknown };
  const watch = LoomWatch.safeParse(row.watch);
  const fingerprint = Fingerprint.safeParse(row.fingerprint);
  const session = typeof row.orchestratorSessionId === "string" && row.orchestratorSessionId !== "" ? row.orchestratorSessionId : undefined;
  return {
    // THE PROJECT ID IS THE DIRECTORY, NOT THE FILE'S CLAIM — same address rule
    // as a loom's. A hand-edited watch.json naming another project would
    // otherwise report that project's schedule under this one's name.
    watch: watch.success ? { ...watch.data, projectId } : defaultWatch(projectId),
    ...(fingerprint.success ? { fingerprint: fingerprint.data } : {}),
    ...(session ? { orchestratorSessionId: session } : {}),
  };
}

export function writeWatchRecord(paths: LoomPaths, projectId: string, record: LoomWatchRecord): LoomWatchRecord {
  const next: LoomWatchRecord = {
    watch: LoomWatch.parse({ ...record.watch, projectId }),
    ...(record.fingerprint ? { fingerprint: Fingerprint.parse(record.fingerprint) } : {}),
    ...(record.orchestratorSessionId ? { orchestratorSessionId: record.orchestratorSessionId } : {}),
  };
  atomicWrite(watchFile(paths, projectId), next);
  return next;
}

/** The schedule alone — the §15.1 shape every surface renders. */
export function readWatch(paths: LoomPaths, projectId: string): LoomWatch {
  return readWatchRecord(paths, projectId).watch;
}

/** PRESERVES EVERY SIBLING ON THE RECORD — the fingerprint and the orchestrator
 *  session id. Starting or stopping a watch is a change to the SCHEDULE and must
 *  not silently discard the last probe's answer (which would make the very next
 *  probe report "changed" against nothing and wake an agent for free work), nor
 *  the session the human has been talking to. `{...current, watch}` is what
 *  makes that true for siblings added later, too. */
export function writeWatch(paths: LoomPaths, projectId: string, watch: LoomWatch): LoomWatch {
  const current = readWatchRecord(paths, projectId);
  return writeWatchRecord(paths, projectId, { ...current, watch }).watch;
}

/** The fingerprint alone, for the sentinel's hot path. `undefined` means never
 *  probed, which is NOT the same as "probed and printed nothing". */
export function readSentinel(paths: LoomPaths, projectId: string): Fingerprint | undefined {
  return readWatchRecord(paths, projectId).fingerprint;
}

/** PRESERVES EVERY SIBLING, the mirror of `writeWatch`. */
export function writeSentinel(paths: LoomPaths, projectId: string, fingerprint: Fingerprint): LoomWatchRecord {
  const current = readWatchRecord(paths, projectId);
  return writeWatchRecord(paths, projectId, { ...current, fingerprint });
}

// ── the Program, in the project's own repo ──────────────────────────────────

/** `<projectRoot>/.telar/loom.md`. The ONE loom file outside `engineRoot` —
 *  see the header for why. */
export function programPath(projectRoot: string): string {
  return path.join(projectRoot, PROGRAM_DIR, PROGRAM_FILE);
}

/**
 * Read the Program and parse it in one call.
 *
 * A MISSING FILE IS NOT AN ERROR, it is the state every project starts in:
 * `exists: false`, empty markdown, `program: null`. The Program tab renders
 * that as "no Program yet", and `POST /looms/setup` is what fills it.
 *
 * A file that EXISTS always yields a `program`, because the parser degrades
 * rather than failing (loom-build.md §2: "a Program with a typo degrades, it
 * does not fail"). What a typo produces is a `warnings` entry, which is what
 * the tab shows next to the block that did not parse.
 */
export function readProgramDoc(projectId: string, projectRoot: string): LoomProgramDoc {
  const file = programPath(projectRoot);
  let markdown: string;
  try {
    markdown = fs.readFileSync(file, "utf8");
  } catch {
    return { projectId, path: file, exists: false, markdown: "", program: null, warnings: [] };
  }
  try {
    const { program, warnings } = parseProgram(markdown);
    return { projectId, path: file, exists: true, markdown, program, warnings };
  } catch (e) {
    // The parser is not supposed to throw. If it ever does, the FILE still
    // exists and its text is still the user's, so it is handed back verbatim
    // with the throw as a warning rather than reported as a missing Program —
    // which would invite the caller to overwrite it.
    return {
      projectId,
      path: file,
      exists: true,
      markdown,
      program: null,
      warnings: [e instanceof Error ? e.message : String(e)],
    };
  }
}

/**
 * Write the Program back into the project repo.
 *
 * ── THE CONTAINMENT GUARD ───────────────────────────────────────────────────
 * This is the one write in the module that lands outside `paths.root`, so it
 * gets the same treatment every id-composed path gets: the resolved target is
 * re-checked against the resolved project root, and a target that escapes is
 * refused. `projectRoot` arrives from the caller (the daemon resolves it from
 * the project registry), and a registry entry is a path the user typed — so a
 * root containing a symlink that hops out of the repo is not hypothetical.
 * `realpathSync` is applied to the ROOT only: the Program file itself may not
 * exist yet, and requiring it to would make the first write impossible.
 *
 * ── WHY NOT `atomicWrite` ───────────────────────────────────────────────────
 * `atomicWrite` is the engine's one DOCUMENT writer and it serializes JSON.
 * The Program is markdown — the user's own prose, read at 2am — so passing it
 * through would store a JSON-quoted string. What matters about `atomicWrite`
 * is the DISCIPLINE, not the serializer, so the discipline is reproduced here
 * exactly: unique temp name, write, rename, unlink in a `finally`. The
 * precedent is `files.ts:260-273`, which writes repo files the same way and for
 * the same reason.
 */
export function writeProgramDoc(projectId: string, projectRoot: string, markdown: string): LoomProgramDoc {
  if (typeof markdown !== "string") {
    throw new Error("a Loom program is markdown text — pass the whole file's contents as a string.");
  }
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync.native(projectRoot);
  } catch {
    throw new Error(
      `the project root ${JSON.stringify(projectRoot)} is not a directory this machine can reach, so its .telar/loom.md has nowhere to be written. Nothing was written.`,
    );
  }
  const file = programPath(resolvedRoot);
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (!file.startsWith(withSep)) {
    throw new Error(
      `refusing to write a Loom program outside the project root: ${JSON.stringify(file)} is not inside ${JSON.stringify(resolvedRoot)}. Nothing was written.`,
    );
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, markdown, { mode: 0o644 });
    fs.renameSync(temporary, file);
  } finally {
    // Never leave the scratch file behind: it sits in the user's repo, so it
    // would show up in `git status` and in the next person's diff.
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return readProgramDoc(projectId, resolvedRoot);
}

// ── the runtime seam ────────────────────────────────────────────────────────

/**
 * WHAT THE STORE CANNOT ANSWER — the half of §15.1 that needs a process, a
 * worktree, a shell or a model, declared here so `EngineStore` can hold it as
 * one optional field instead of nine.
 *
 * DECLARED IN THE STORE, IMPLEMENTED IN `loom/supervisor.ts`. The direction is
 * deliberate: the store is the module with no dependencies, so an interface
 * here can be imported by `state.ts` AND by the runtime without either of them
 * importing the other. Putting it in the runtime would make `state.ts` import
 * the supervisor to get a type, which drags the whole dispatch/exec tree into
 * every test that builds an `EngineStore` — the same reason `attachBrowser`
 * exists rather than a constructed browser.
 *
 * EVERY METHOD IS SYNCHRONOUS AND RETURNS A HANDLE, not a promise. `tickLoom`
 * and `dryRunLoom` are 202s: they start work and return the `LoomRun` that
 * describes it, and the caller reads progress from `loomWork()`. A promise here
 * would invite a route to await a model.
 */
export interface LoomRuntime {
  /** In-memory, in-flight ticks. Never persisted — a run that did not survive a
   *  restart did not survive, and reporting one from disk would describe a
   *  process that is not there. */
  loomWork(): { runs: LoomRun[] };
  startLoomWatch(projectId: string): { watch: LoomWatch };
  stopLoomWatch(projectId: string): { watch: LoomWatch };
  tickLoom(projectId: string, input?: { note?: string }): { run: LoomRun };
  dryRunLoom(projectId: string): { run: LoomRun };
  /**
   * THE THREE ASYNC ARMS, and the asynchrony is real rather than incidental:
   * dispatch cuts a worktree, runs the Program's `setup`, runs `detail` and
   * starts a session; cancel stops a session; answer restarts one. A
   * synchronous signature could only be honoured by fire-and-forget, which
   * would hand the route a `queued` loom whose worktree does not exist yet —
   * a record that reads as a promise the machinery has not made.
   */
  dispatchLoom(projectId: string, input: { item: string; title?: string; brief?: string }): Promise<{ loom: Loom }>;
  cancelLoom(loomId: string): Promise<{ loom: Loom }>;
  answerLoom(loomId: string, answer: string): Promise<{ loom: Loom }>;
  suggestLoomProgram(projectId: string): { markdown: string; findings: string[] };
  /**
   * THE CONVERSATIONAL ORCHESTRATOR SESSION — the room a human talks to, run
   * against the project's own root rather than a worktree. `created` tells the
   * surface whether it just made one, so opening the page twice does not read
   * as two sessions. The id is persisted on the watch record (see
   * `LoomWatchRecord.orchestratorSessionId`), which is where `loomOverview`
   * reads it back from.
   */
  ensureLoomSession(projectId: string): Promise<{ sessionId: string; created: boolean }>;
  /**
   * STOP THE SUPERVISOR'S TIMER. Called from `daemon.close()` beside the other
   * `clearInterval`s, and it is not optional: the one recurring-timer precedent
   * in this codebase (`daemon.ts:343`) is injected, `.unref()`ed AND cleared in
   * `close()`, and a suite that leaves an interval armed hangs instead of
   * failing — which is the worst way to learn about it.
   *
   * MUST BE IDEMPOTENT AND MUST NOT THROW. It runs on a shutdown path, where
   * the only thing worse than a leaked timer is an exception that skips every
   * teardown after it.
   */
  close(): void;
}

/**
 * The counts a project summary carries, zeroed for every state.
 *
 * BUILT FROM `LoomState.options`, never from the looms present, and the
 * difference is what the deck renders: a project with no `stuck` looms must
 * report `stuck: 0` rather than omitting the key, or every consumer has to
 * spell `counts.stuck ?? 0` and one of them will forget.
 */
export function countByState(looms: readonly Loom[]): Record<LoomState, number> {
  const counts = Object.fromEntries(LoomState.options.map((s) => [s, 0])) as Record<LoomState, number>;
  for (const loom of looms) counts[loom.state] += 1;
  return counts;
}
