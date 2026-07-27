// The one append-only spend ledger — $TELAR_HOME/usage.ndjson (AD-18).
//
// This module IS the ledger's port (AD-20): shared runtime state that belongs
// to no module is owned by its core service and written only through that
// service. No module opens usage.ndjson by path. apps/web/lib/store.ts
// re-exports logUsage/usageSummary from here rather than keeping a second
// implementation, so there is exactly one writer and exactly one file.
//
// WHY appendFileSync and NOT the .tmp→rename atomic idiom every other store
// here uses: usage.ndjson is AD-6's append-only-stream class. A whole-file
// tmp-write + rename would have to re-serialize the entire ledger on every
// call and would destroy append-only semantics (two concurrent processes —
// the dev server and the packaged app — would clobber each other's lines
// instead of interleaving them). A single O_APPEND write of one line is the
// correct primitive for this class. Do not "fix" this to tmp+rename.
//
// Every readout in the app is a PROJECTION over this log, never an independent
// counter: the session's per-turn cost, ultra's manifest `spend` and a loom
// charter's budget-left all fold these lines. Cost language (USD on Claude,
// tokens on Codex) is a rendering concern of the projection — the record
// carries NO UNIT SELECTOR.
//
// AMENDED BY STORY 4.1, because the sentence used to read "the record itself
// carries no currency or unit" and, read literally, that is false: `costUsd`
// names a currency and is the field every USD readout folds. What is true, and
// what the sentence always meant, is that a row carries the raw material for
// BOTH denominations — a cost number and token counts, side by side, on every
// row — and carries nothing that CHOOSES between them: no `currency`, no
// `unit`, no `provider`. The chooser is apps/web/lib/spend-readout.ts, at render
// time, from the session's provider. `packages/core/test/usage-ledger.test.ts`'s
// "4.1 AC6 proof 1" asserts exactly that, which is how the prose stopped being
// the only thing holding the claim up.
import fs from "node:fs";
import path from "node:path";
import { telarDir } from "./manifest";
import { UsageEntry, type UsageOwnerKind } from "./schemas";

const usageFile = () => path.join(telarDir(), "usage.ndjson");

// What a caller hands logUsage: `ts` is required, everything else defaults via
// the schema. Owner fields are optional so the pre-existing chat-route call
// site keeps working unchanged and lands as a session-owned record.
export type UsageEntryInput = { ts: number } & Partial<UsageEntry>;

export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
};

export type UsageWindow = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

function emptyTokenTotals(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
}

function emptyWindow(): UsageWindow {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
}

// `ownerId` cannot default to a sibling field in zod, so the "attribute an
// un-owned record to its own session" rule lives here, in one place, shared by
// the write path and the read path rather than restated at each call site.
function attribute(entry: UsageEntry): UsageEntry {
  if (!entry.ownerId) entry.ownerId = entry.sessionId;
  return entry;
}

// The READ path's parse. A malformed line is SKIPPED (null), never thrown —
// AD-7. The WRITE path (logUsage) parses separately so that it can REPORT what
// it could not log; this one must stay SILENT, or a single hand-written bad
// line would spray the console on every projection read for the life of the
// process.
function normalize(raw: unknown): UsageEntry | null {
  const parsed = UsageEntry.safeParse(raw);
  return parsed.success ? attribute(parsed.data) : null;
}

// ── The projection cache ────────────────────────────────────────────────────
// Keyed on (file, file IDENTITY, bytes-already-folded). NOT on mtime, with one
// narrow exception noted below. Reasons, all real:
//  - Correctness: ultra and weave now append a line and re-read the projection
//    inside the SAME synchronous tick. Filesystem mtime granularity can be
//    coarser than that, so an mtime key can serve a stale total for a write
//    that already landed. A byte length cannot. GROWTH IS ALWAYS DETECTED BY
//    LENGTH; mtime is consulted only when the length did NOT change, as a
//    best-effort catch for an in-place rewrite that no amount of
//    length-watching can see — best-effort because mtime granularity is the
//    filesystem's to choose, so see the residual list below for when it misses.
//  - Cost: the ledger is append-only, so a grown file only ever needs its NEW
//    bytes folded. This makes the append-then-read hot loop O(appended)
//    instead of O(whole ledger) on every read.
//  - Identity: (dev, ino) are read by fstat on the SAME descriptor the bytes
//    come from, so a rotate-then-regrow past the cached offset can never be
//    mistaken for growth of the file we actually folded. `file` stays in the
//    key too: the root resolves lazily, so two TELAR_HOME roots can be live in
//    one process and must never share a fold — and an inode number is reused
//    once a temp root is removed.
//
// `size` is the count of bytes this fold has CONSUMED, and it is only ever
// advanced by what readSync actually returned. Never by a stat taken before
// the read (an append landing in between would make the next read re-fold the
// overlap and inflate every total for the life of the process), and never by
// Buffer.byteLength of decoded text (a torn multi-byte character decodes to a
// 3-byte U+FFFD and the offset drifts past the real end of file).
//
// Residual, documented rather than hidden. Both are outside usage.ndjson's
// contract — its sole writer is one O_APPEND line at a time — and neither is
// fixed here:
//  - TRUNCATE-IN-PLACE THEN REGROW. `> file`, fs.writeFileSync, or logrotate's
//    copytruncate keeps the INODE, so the identity check matches; if the
//    replacement content ends up longer than the cached offset, the length
//    comparison reads it as growth and the pre-truncation totals stay in the
//    fold with the new file's tail added to them. What IS caught: a
//    rename-based rotation, by (dev, ino); and a regrow that has not yet
//    passed the cached offset, by `cache.size <= st.size`.
//  - A SAME-SIZE in-place rewrite on a filesystem whose mtime granularity is
//    coarser than the gap between the fold and the rewrite — see the
//    equal-size branch in readFold.
type Fold = {
  bySessionTokens: Map<string, TokenTotals>;
  bySessionCost: Map<string, number>;
  byOwnerCost: Map<string, number>;
  // Story 4.1 / AC5 — the two ULTRA-scoped folds. Deliberately separate maps
  // rather than a widening of bySessionCost: that map feeds usageSummary()'s
  // account windows, whose byte-identity is the owner filter's stated reason
  // (2) and whose widening is an unresolved [Review][Decision] on story 1.1.
  // Keeping them apart is what lets `sessionSpendUsd` sum the two ONE LAYER UP
  // while every other projection stays exactly as it was.
  ultraCostBySession: Map<string, number>;
  ultraCostByMessage: Map<string, number>;
  entries: UsageEntry[];
  // Every non-empty entryKey this fold has already consumed — THE dedupe.
  // Derived from the file, so it is rebuilt whenever the fold is.
  seenKeys: Set<string>;
};

function emptyFold(): Fold {
  return {
    bySessionTokens: new Map(),
    bySessionCost: new Map(),
    byOwnerCost: new Map(),
    ultraCostBySession: new Map(),
    ultraCostByMessage: new Map(),
    entries: [],
    seenKeys: new Set(),
  };
}

// The in-memory owner index key. \u0000 is written as an ESCAPE, never as a raw
// byte: a literal 0x00 makes this whole file binary to git and grep — no
// reviewable diff, no `git grep ownerKey` — while rendering as an innocent
// space, so a reviewer reading the diff sees different code than what is on
// disk. The runtime value is identical either way.
const ownerKey = (kind: UsageOwnerKind, id: string) => `${kind}\u0000${id}`;

type CacheSlot = {
  file: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number; // bytes consumed — exactly what readSync returned
  partial: Buffer; // trailing bytes after the last "\n", not yet a whole line
  fold: Fold;
};

// The identity of a file, however it was observed: by fstat on the descriptor
// the bytes came from, or — when the open itself failed and there is no
// descriptor — by a path stat.
type FileId = { dev: number; ino: number };

let cache: CacheSlot | null = null;

// Whether the most recent fold-producing read FAILED with nothing to serve in
// its place — see ledgerReadUnavailable(). A property of the LAST READ, not of
// the file: readFold clears it on entry and the next successful read leaves it
// clear.
let readUnavailable = false;

// Whether the fold just served was NOT produced by reading the file on this
// call — the read failed and the last known good fold for the SAME file
// identity was re-served in its place (foldAfterFailedRead's cache-hit branch).
// The number is real and it is a LOWER BOUND, which is why it is deliberately
// not "unavailable": stale-and-high still binds a budget where zero does not,
// and test (m) pins that distinction on purpose.
//
// It is still not an answer every caller may take at face value, and that is
// why this second flag exists. `readUnavailable` is FILE-scoped — "was anything
// served at all" — while a DISPLAY asks a row-scoped question: "is the figure I
// got for THIS session what the file says now?" A stale fold answers 0 for
// every row appended since it was taken, by another process or by this one
// before the failure, and a bare 0 cannot be told from "this session never
// spent anything". Same property as the LAST READ, cleared on entry.
let readStale = false;

const NEWLINE = 0x0a;
const READ_CHUNK = 64 * 1024;
const NO_BYTES = Buffer.alloc(0);

// THE DEDUPE, and WHY it lives here in the fold rather than at the writer.
//
// A non-empty `entryKey` names ONE billable event globally, and this fold
// consumes each key AT MOST ONCE. Because the fold is derived from the FILE it
// is rebuilt whenever the projection is, so the guarantee survives a cache
// rebuild, a process restart and a second writer. An "already recorded" Set
// held by a writer dies with its process and would fix only the in-run case.
// Three production paths legitimately re-present the same billable event:
//  - in-run mediation — mediateThread reuses the existing child and keeps its
//    attempts[] intact, so a re-settle re-presents every earlier attempt;
//  - cross-process resume — resumeLoom/steerLoom/rejectLoom/answerBlocked run
//    a fresh process over children already `done` on disk;
//  - a dev server and the packaged app appending to one root concurrently.
//
// FIRST OCCURRENCE WINS: the log is append-ordered, and the byte-incremental
// path cannot retroactively unfold a total it has already added. A key is a
// GLOBAL event identity, never owner-scoped. An EMPTY key opts out entirely,
// so nothing that folds today folds differently (AC5) — every record already
// on disk is un-keyed.
//
// Note the early `return` also skips `fold.entries.push`, so usageSummary()
// sees a deduped row exactly once too. Harmless today: only loom and ultra
// rows are keyed and both are already excluded by the ownerKind filter below.
//
// The session-scoped maps take ONLY ownerKind === "session" rows — see
// readFold's comment for why that is load-bearing rather than incidental.
function foldLine(fold: Fold, entry: UsageEntry) {
  if (entry.entryKey) {
    if (fold.seenKeys.has(entry.entryKey)) return;
    fold.seenKeys.add(entry.entryKey);
  }
  fold.entries.push(entry);
  fold.byOwnerCost.set(
    ownerKey(entry.ownerKind, entry.ownerId),
    (fold.byOwnerCost.get(ownerKey(entry.ownerKind, entry.ownerId)) ?? 0) + entry.costUsd,
  );
  // Story 4.1 / AC5 — the ultra folds, accumulated ABOVE the owner-scoping
  // early return below, because that return is what excludes these rows from
  // every session-scoped projection and it is NOT being relaxed. Same dedupe
  // (the entryKey check at the top of this function has already run), same
  // pass, no second read of the file.
  //
  // Keyed on the row's OWN fields: `sessionId` is the launching chat's id (the
  // owning chat's session, which is what makes a per-session rollup possible at
  // all) and `messageId` is the launching turn's runId. A row with an empty
  // messageId — every ultra row written before story 4.1 — contributes to the
  // per-session fold and is skipped by the per-message one, which is the honest
  // answer: it is this session's spend, and nothing on disk says whose turn.
  if (entry.ownerKind === "ultra") {
    if (entry.sessionId) {
      fold.ultraCostBySession.set(
        entry.sessionId,
        (fold.ultraCostBySession.get(entry.sessionId) ?? 0) + entry.costUsd,
      );
    }
    if (entry.messageId) {
      fold.ultraCostByMessage.set(
        entry.messageId,
        (fold.ultraCostByMessage.get(entry.messageId) ?? 0) + entry.costUsd,
      );
    }
  }
  if (entry.ownerKind !== "session") return;
  const totals = fold.bySessionTokens.get(entry.sessionId) ?? emptyTokenTotals();
  totals.inputTokens += entry.inputTokens;
  totals.outputTokens += entry.outputTokens;
  totals.cacheReadTokens += entry.cacheReadTokens;
  totals.cacheCreateTokens += entry.cacheCreateTokens;
  fold.bySessionTokens.set(entry.sessionId, totals);
  fold.bySessionCost.set(entry.sessionId, (fold.bySessionCost.get(entry.sessionId) ?? 0) + entry.costUsd);
}

// Reads from `start` out of an ALREADY-OPEN descriptor and returns exactly the
// bytes it got. `end` is the size the fstat that DECIDED this read observed.
// Four properties readFold depends on:
//  - the caller advances its offset by `.length`, never by a stat figure, so a
//    byte that was never read can never be marked as folded;
//  - a short read is LOOPED, not merely accounted for: the fold must be exact
//    on the read that OBSERVES the growth, not one read later;
//  - the loop is BOUNDED by `end`. It stops as soon as it holds the bytes it
//    was promised; it never chases a writer. An unbounded loop that ran until
//    readSync returned 0 cannot terminate while an appender lands a line
//    between iterations — and leaving those bytes for the NEXT call is the
//    byte-incremental design's whole premise, not a loss. Each read still asks
//    for a whole chunk rather than the exact remaining promise, so bytes that
//    landed between the fstat and the syscall come back in the same buffer and
//    are folded and accounted NOW (the append-during-stat case); what the
//    bound removes is the chase, not that.
//  - only `subarray(0, n)` is kept, so no zero padding ever reaches the parser.
function readFrom(fd: number, start: number, end: number): Buffer {
  const chunks: Buffer[] = [];
  let pos = start;
  while (pos < end) {
    const buf = Buffer.alloc(READ_CHUNK);
    const n = fs.readSync(fd, buf, 0, READ_CHUNK, pos);
    if (n <= 0) break;
    chunks.push(buf.subarray(0, n));
    pos += n;
  }
  return Buffer.concat(chunks);
}

// A read that could not happen AT ALL — the open, the fstat, or the bytes.
// The two ways that happens are DIFFERENT EVENTS and must not share an answer.
//
//  - ENOENT is the ledger's legitimate empty state: no line has ever been
//    written, or the file was rotated away. 0 IS the total. The cache is
//    dropped so a fold built from a file that is no longer there can never be
//    served in place of the file that is not.
//  - ANYTHING ELSE — EACCES, EMFILE, ENFILE, EIO, a throw with no `code` — is
//    TRANSIENT: the ledger is still on disk and still holds every dollar it
//    held a moment ago. Answering 0 here is a MONEY GUARD FAILING OPEN, and
//    silently: weave.ts reads spentUsd on every tick and a returned number is
//    indistinguishable from a successful read of an empty ledger, so its
//    fail-closed catch never fires and no event is emitted. Serve the last
//    known good fold for THIS file instead — for a budget check
//    stale-and-high is safe, zero is not.
//
// The fallback is matched on FILE IDENTITY, never on the path alone. A
// rotation puts a DIFFERENT INODE under an unchanged path, and a fold of the
// file that WAS there is not a fold of the file that is — serving it reports
// spend the current ledger never recorded, and reports keys it never carried.
// `seen` is the identity the fstat on the failing descriptor observed; when
// the open itself failed there is no descriptor, so identity is re-stated by a
// path stat, which needs no read permission on the file and so still answers
// under the EACCES that (j) covers. Identity unproven means no fallback.
//
// With no fold to fall back on, answer empty and DO NOT cache that answer:
// caching it would pin every spend readout at 0 for the life of the process
// with no error anywhere, which is exactly the poisoning test (b) exists to
// keep fixed. The next call retries. That empty answer is also the one a
// caller CANNOT TELL from a successful read of an empty ledger — a 0 that
// un-binds maxCostUsd — so it is the single case that raises `readUnavailable`
// for ledgerReadUnavailable() to report.
function foldAfterFailedRead(file: string, err: unknown, seen: FileId | null): Fold {
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
    // Not a failure to read: a ledger that is not there really is worth 0.
    cache = null;
    return emptyFold();
  }
  const id = seen ?? statIdentity(file);
  if (cache && cache.file === file && id && cache.dev === id.dev && cache.ino === id.ino) {
    // Real, and a lower bound — but not read from the file on this call, so a
    // row that landed after it was taken is missing and reads as 0. See
    // readStale.
    readStale = true;
    return cache.fold;
  }
  readUnavailable = true;
  return emptyFold();
}

// Identity for the failure that never got a descriptor. Best-effort by
// definition — if it cannot answer, the caller must treat identity as unproven
// rather than assume the cached fold describes what is on disk now.
function statIdentity(file: string): FileId | null {
  try {
    const st = fs.statSync(file);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

// THE OWNER-SCOPING RULE, stated once:
//
// The session-scoped projections (per-session tokens, per-session cost, and
// usageSummary's account windows) fold ONLY rows with ownerKind === "session".
// Two independent reasons:
//  1. Correctness. An ultra run's ledger lines carry the OWNING CHAT's
//     sessionId, and a Chat's id IS the SDK session id. Without this filter a
//     chat that ran an ultra script would display its own spend PLUS every
//     child agent's — a wrong number.
//  2. No user-visible regression. usageSummary feeds the sidebar/dashboard
//     account windows. Loom and ultra lines are new to the ledger as of this
//     change; scoping to "session" keeps those readouts byte-identical.
// A pre-attribution record is unaffected: the schema defaults it to
// ownerKind "session", so it still counts toward every total.
//
// STORY 4.1 AMENDS REASON (1), AND ONLY REASON (1). Reason (2) is preserved
// exactly — usageCostBySession() and usageSummary() are untouched and are
// asserted unchanged. Reason (1) now describes the PRE-4.1 behaviour of the
// session fold, and it stays true OF THIS FUNCTION: bySessionCost still holds a
// chat's own turns and nothing else. What changed is one layer up. AD-18/FR-UW-5
// want a run's spend to appear in the session's display, so
// apps/web/lib/store.ts's `sessionSpendUsd` SUMS this fold with
// ultraCostBySession() — deliberately, in one place, at the display projection.
// The two summands are disjoint by construction (a row is either
// ownerKind "session" or ownerKind "ultra", never both), and they are disjoint
// in SUBSTANCE too: the chat route logs its own SDK turn's
// `lastResult.totalCostUsd`, while an ultra child runs through
// ultra/runner.ts -> engine.agent() -> a SEPARATE query(), detached, continuing
// after the launching turn's POST already ran endChatRun in its finally. So the
// sum adds two things, never the same thing twice.
//
// The rule that has NOT moved: this filter is not relaxed, not reordered and not
// removed. Anything that wants ultra rows asks for them by name.
function readFold(): Fold {
  const file = usageFile();
  // Cleared on ENTRY: the flags describe the read that is about to happen, and
  // only the exits that could not read the file raise them. Cleared here rather
  // than per-exit so the warm fast path — same identity, same length, same
  // mtime, no I/O beyond the fstat — leaves them correct too.
  readUnavailable = false;
  readStale = false;
  // The identity of the file the bytes are coming from, hoisted so the catch
  // below can hand the failure the identity it already observed.
  let seen: FileId | null = null;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    // No ledger yet, or unreadable right now — NOT the same answer. See
    // foldAfterFailedRead: an absent file is worth 0, an unreadable one is
    // worth whatever it was worth on the last read that succeeded.
    return foldAfterFailedRead(file, err, seen);
  }
  try {
    // Size AND identity come from the descriptor the bytes are read from, so
    // there is no window in which they can describe a different file.
    const st = fs.fstatSync(fd);
    seen = { dev: st.dev, ino: st.ino };
    const slot =
      cache && cache.file === file && cache.dev === st.dev && cache.ino === st.ino && cache.size <= st.size
        ? cache
        : null;
    if (slot) {
      if (slot.size < st.size) {
        // Append-only growth: fold ONLY the new bytes. The read is BOUNDED by
        // the size this fstat saw, so it cannot be kept alive by a writer; it
        // still issues whole-chunk reads, so an append that landed before the
        // syscall comes back with them and is folded now and counted now — it
        // can never be folded a second time. Anything later is simply the next
        // call's tail.
        const bytes = readFrom(fd, slot.size, st.size);
        slot.size += bytes.length;
        slot.mtimeMs = st.mtimeMs;
        appendChunk(slot.fold, slot, bytes);
        return slot.fold;
      }
      // Same identity, same length. Growth never reaches here, so the only
      // thing that can have changed the bytes is an in-place rewrite, and
      // mtime is the only signal left that could catch one. That signal is
      // BEST-EFFORT, not a guarantee: mtime granularity is a property of the
      // filesystem, not of the write (HFS+ and ext3 quantise to 1s, FAT to 2s,
      // some network filesystems worse), so a same-size rewrite landing inside
      // one granule leaves the recorded mtime unmoved and this fast path
      // serves the stale fold. Sub-second-resolution filesystems (APFS, ext4,
      // NTFS) do catch it — which is what test (d) pins, on APFS. Either way a
      // same-size rewrite is outside usage.ndjson's contract; see the residual
      // list above.
      if (slot.mtimeMs === st.mtimeMs) return slot.fold;
    }
    // Truncated, rotated, rewritten in place, a different root, or nothing
    // cached: fold the whole file. That is just this same incremental read
    // starting at byte 0 — one code path, one accounting rule.
    const next: CacheSlot = {
      file,
      dev: st.dev,
      ino: st.ino,
      mtimeMs: st.mtimeMs,
      size: 0,
      partial: NO_BYTES,
      fold: emptyFold(),
    };
    const bytes = readFrom(fd, 0, st.size);
    next.size = bytes.length;
    appendChunk(next.fold, next, bytes);
    cache = next;
    return next.fold;
  } catch (err) {
    // Any I/O failure on EITHER path, once the file is already open. The
    // rebuild branch publishes its slot only after the last byte is folded, so
    // whatever `cache` holds here is still a COMPLETE fold of this file and is
    // safe to serve — the same two classes, the same rule.
    return foldAfterFailedRead(file, err, seen);
  } finally {
    // A close failure must never become the read API's exception — the whole
    // point of this guard is that getChat/listChats/ledgerSpendUsd cannot
    // throw.
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

// Folds whole lines out of `bytes`, carrying any trailing partial line forward
// AS BYTES so a torn write — a line whose "\n" has not landed yet, including
// one torn in the middle of a multi-byte character — is never consumed
// half-parsed and is folded exactly once when it completes. Carrying it as a
// string would decode those boundary bytes to U+FFFD and the completed line
// would fold with mangled fields. Decoding starts at 0 and stops at a newline
// boundary, so no complete line is ever decoded across a torn character.
function appendChunk(fold: Fold, slot: { partial: Buffer }, bytes: Buffer) {
  const buf = slot.partial.length === 0 ? bytes : Buffer.concat([slot.partial, bytes]);
  const lastBreak = buf.lastIndexOf(NEWLINE);
  if (lastBreak === -1) {
    // Copy, never retain a slice: `bytes` is backed by a full read chunk and
    // the partial is at most one line.
    slot.partial = Buffer.from(buf);
    return;
  }
  slot.partial = Buffer.from(buf.subarray(lastBreak + 1));
  for (const line of buf.toString("utf8", 0, lastBreak).split("\n")) {
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // malformed line — skipped, never thrown
    }
    const entry = normalize(raw);
    if (entry) foldLine(fold, entry);
  }
}

// ── The port ────────────────────────────────────────────────────────────────

// The ledger's SOLE writer. Appends one line to $TELAR_HOME/usage.ndjson; no
// other file is ever created. Returns whether the entry is accounted for.
export function logUsage(entry: UsageEntryInput): boolean {
  // WHY this guard: before this change nothing in packages/core wrote the
  // ledger, so an unpinned test suite could not pollute real state. Now that
  // core is a writer, a test that forgets to pin TELAR_HOME would append into
  // the developer's real ~/.telar — the exact failure the state-root fix
  // exists to prevent. `bun test` sets NODE_ENV=test; `next dev` sets
  // development and the packaged server production, so this can never fire
  // outside a test process. Fail loud rather than write silently.
  //
  // THE GUARD READS THE VARIABLE THROUGH THE SAME `?.trim()` THE RESOLVERS DO,
  // and that is load-bearing rather than tidy. The write does not land where
  // this line looks — it lands wherever telarDir() (manifest.ts) resolves, and
  // that resolver TRIMS before deciding. Guarding the RAW variable made the two
  // disagree on exactly one value: TELAR_HOME=" " is truthy, so the guard stayed
  // silent, while " ".trim() is "" so telarDir() fell through to
  // os.homedir()/.telar and the test appended a synthetic billing line to the
  // developer's REAL ledger. A guard must read the same value as the thing it
  // guards; anything else is a check on a different question.
  if (process.env.NODE_ENV === "test" && !process.env.TELAR_HOME?.trim()) {
    throw new Error(
      "logUsage refused: NODE_ENV=test with no TELAR_HOME — pin a temp home before writing the usage ledger.",
    );
  }
  // WHY loud, and WHY NOT a throw. This line is the only record that the money
  // was spent, so a silent drop is the wrong default: `ts` is the one field
  // with no schema default and z.number() rejects NaN, so a NaN attempt cost
  // or a non-numeric injected clock makes the whole entry vanish without a
  // trace. But throwing is worse: accounting is best-effort, the work is not,
  // and a throw here is a control-flow failure raised over a bookkeeping
  // defect.
  //
  // MEASURED, because the earlier wording here was stale and a future editor
  // could have removed a guard on its authority: it said "neither weave.ts's
  // spend recording nor ultra/storage.ts's onEvent guards this call". Both DO
  // now — weave.ts's recordSpend and ultra/storage.ts's onEvent each wrap their
  // call in a try/catch and report through the run's own event log. What is
  // still true, and is what keeps the no-throw rule: apps/web's chat-route call
  // site does NOT wrap it, and a throw there would break an SSE turn the user
  // is watching. The RETURNED BOOLEAN is the reportable signal for the two that
  // do wrap — both check it, so a schema rejection lands in the run's log
  // instead of only in the console.
  const parsed = UsageEntry.safeParse(entry);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    console.error(
      `[usage-ledger] dropped an unloggable usage entry (${why}) — sessionId=${String(entry.sessionId)} ts=${String(entry.ts)}`,
    );
    return false;
  }
  const normalized = attribute(parsed.data);
  // THE WRITE PATH NEVER DEDUPES. It appends, always, keyed or not.
  //
  // foldLine is the whole guarantee — it consumes a non-empty entryKey AT MOST
  // ONCE over the FILE — so a duplicate row already changes no total, and a
  // write-side pre-check buys nothing but one row. What it costs is the audit
  // trail: idempotence enforced by SUPPRESSING a write leaves no row anywhere,
  // so a key that collided for the WRONG reason (a stale fold, a second
  // writer, a key derived from something countable) is money spent that
  // `jq -s 'map(.costUsd)|add'` cannot see and no human can reconcile. A
  // duplicate row is visible and arguable; a missing row is silent. This is
  // also exactly what the record's own contract says, in schemas.ts: "The log
  // stays append-only: the duplicate row is never removed, it simply stops
  // counting." Nothing may stop it being WRITTEN.
  const dir = telarDir();
  fs.mkdirSync(dir, { recursive: true });
  // `entryKey` is omitted from the JSON when empty so an UN-KEYED record stays
  // byte-identical to one written before the field existed: the schema
  // materializes the "" default on parse, and serializing it would add a 12th
  // key to every historical-shaped line. `messageId` (story 4.1) gets exactly
  // the same treatment for exactly the same reason — a row nobody attributed to
  // a turn must not grow a key just because the field now exists.
  fs.appendFileSync(
    usageFile(),
    JSON.stringify({
      ...normalized,
      entryKey: normalized.entryKey || undefined,
      messageId: normalized.messageId || undefined,
    }) + "\n",
  );
  return true;
}

// Per-session token totals — the read-time fallback for chats persisted before
// per-turn token accumulation existed on the chat record itself.
export function usageTokensBySession(): Map<string, TokenTotals> {
  return readFold().bySessionTokens;
}

// Per-session spend. The projection behind a session's persisted cost readout.
export function usageCostBySession(): Map<string, number> {
  return readFold().bySessionCost;
}

// Spend for one owner — the projection behind ultra's manifest `spend` and a
// loom charter's budget-left. Both are folds of this same log, not counters.
export function ledgerSpendUsd(owner: { ownerKind: UsageOwnerKind; ownerId: string }): number {
  return readFold().byOwnerCost.get(ownerKey(owner.ownerKind, owner.ownerId)) ?? 0;
}

// Story 4.1 / AC5 — ULTRA spend rolled up by the LAUNCHING CHAT SESSION.
//
// The projection `apps/web/lib/store.ts`'s `sessionSpendUsd` adds to its
// session-owned fold, and the reason FR-UW-5 is a projection rather than a
// counter: fold the same rows two ways and they agree by construction, so
// `ultraCostBySession().get(sid)` necessarily equals the sum of
// `ledgerSpendUsd({ ownerKind: "ultra", ownerId })` over that session's runs.
// There is no second number that can drift from the first.
//
// Keyed by the OWNING chat's session id (a Chat's id IS the SDK session id).
// Rows with no sessionId — a run launched outside a chat — are simply absent,
// which is the honest answer rather than an "" bucket nothing reads.
export function ultraCostBySession(): Map<string, number> {
  return readFold().ultraCostBySession;
}

// Story 4.1 / AC5 — ULTRA spend rolled up by the OWNING CHAT TURN.
//
// Deliberately answers only for `ownerKind: "ultra"` rows. The chat route's own
// per-turn row carries no messageId and is not being given one (that is an
// explicit scope fence: `runId` is in scope there and it is one line, but
// changing the shape of the per-turn row is changing the row story 1.1 spent
// four repair rounds stabilising). So this map is "what did the runs this turn
// launched cost", never "what did this turn cost" — and the two are different
// questions with different owners.
//
// The key is the launching turn's `runId`, which `apps/web/app/api/chat/route.ts`
// threads into ultra through `getMessageId: () => runId`. It is the finest-
// grained id a chat turn has in this app; there is no stored message object to
// join to (see UsageEntry.messageId's note in schemas.ts).
export function ultraCostByMessage(): Map<string, number> {
  return readFold().ultraCostByMessage;
}

// Story 4.1 / AC5 — BOTH per-session cost maps out of ONE fold read, for the
// display projection that sums them (`apps/web/lib/store.ts`'s
// `sessionSpendUsd`).
//
// WHY THIS EXISTS AT ALL, and it is a bug that was found and fixed rather than a
// tidiness. The obvious spelling of that sum is
// `usageCostBySession().get(id) + ultraCostBySession().get(id)`, and it is
// WRONG: those are two exported functions, so it is TWO `readFold()` calls, and
// `readUnavailable`/`readStale` are cleared on ENTRY to each one. So the flags
// left standing afterwards describe only the SECOND call, and a transient
// failure on the first that clears before the second is erased.
//
// The reachable consequence, in order: a cold process's session-leg read fails
// transiently (EACCES/EMFILE/EIO — the module header treats these as
// first-class), so that leg answers 0 and raises `readUnavailable`; microseconds
// later the ultra-leg read succeeds, clears the flag, and answers 0 because the
// session genuinely has no ultra rows; `sessionSpendUsd` returns 0 and
// `ledgerReadDegraded()` returns FALSE; and `displayedSpendUsd`'s
// `projected !== 0 || !ledgerReadDegraded()` short-circuit therefore returns a
// confident $0.00 beside a real transcript WITHOUT ever consulting the stored
// counter. That is precisely the failure `ledgerReadDegraded()` exists to
// prevent, reopened through a seam rather than through the predicate.
//
// ONE read fixes it by construction: the two maps come off the SAME `Fold`
// object, so the flags describe exactly the read that produced both, and a
// degraded read degrades the pair together — which is what the caller's comment
// is entitled to claim only because of this function.
//
// The two single-map accessors above are kept: they are the story's named
// projections, they are what INV-tests and the ledger suite read, and a caller
// that wants only one of them should not pay for both.
export function sessionCostFolds(): {
  session: Map<string, number>;
  ultra: Map<string, number>;
} {
  const fold = readFold();
  return { session: fold.bySessionCost, ultra: fold.ultraCostBySession };
}

// Whether the projection just read is TRUSTWORTHY — the other half of the
// money guard, and the reason the no-throw contract above is not a hole.
//
// Every read here is deliberately no-throw: a chat GET must not 500 and a read
// error must not fail an in-flight weave. The cost of that is a number the
// caller cannot interrogate — an UNREADABLE ledger answers 0, and 0 is exactly
// what a genuinely empty one answers. The first says "no line was ever
// written, the budget has room"; the second says nothing at all. Treating the
// second as the first is maxCostUsd quietly ceasing to bind, with no throw, no
// event and no log line to notice it by. This predicate is how a caller tells
// them apart WITHOUT the read having to throw.
//
// TRUE only for that one case: the most recent fold-producing read failed for
// a TRANSIENT reason (EACCES, EMFILE, EIO, a throw with no code) and had no
// fold of THIS file to serve instead. FALSE after any successful read — an
// empty ledger and a missing one (ENOENT) really are worth 0 — and FALSE when
// a stale-but-real fold was served, because stale-and-high still binds a
// budget where zero does not.
//
// It describes the LAST read, so consult it in the same tick as the projection
// it qualifies; the next projection call recomputes it.
export function ledgerReadUnavailable(): boolean {
  return readUnavailable;
}

// The WIDER question, for callers whose number is a per-row READOUT rather than
// a budget guard: did the projection just served come from reading the file on
// this call, or not?
//
// TRUE in both degraded cases — the read failed with nothing to serve (a 0 that
// means nothing), AND the read failed with the last known good fold served in
// its place (a real total, but one that predates every row appended since it
// was taken: another process's append, or this process's own before the
// failure). FALSE after any read that actually reached the file, including a
// missing one (ENOENT) and an empty one — those really are worth 0.
//
// WHY THE TWO PREDICATES ARE NOT ONE. A budget guard wants stale-and-high: it
// still binds, where zero does not, so `ledgerReadUnavailable()` deliberately
// answers FALSE for a served stale fold and weave.ts keeps scheduling against
// it (test (m) pins exactly that, on purpose). A per-session DISPLAY asks a
// different question — "is this session's figure what the file says now?" — and
// for that a stale fold's silence about a row is indistinguishable from the row
// not existing. Widening the first predicate to serve the second would fail a
// budget closed on a number that is safe; a second predicate costs one boolean
// and keeps both answers honest.
//
// Describes the LAST read, like its sibling: consult it in the same tick as the
// projection it qualifies.
export function ledgerReadDegraded(): boolean {
  return readUnavailable || readStale;
}

export function usageSummary(): {
  session: UsageWindow; // trailing 5h — approximates the subscription window
  weekly: UsageWindow; // trailing 7d
  byAccount: Record<string, { session: UsageWindow; weekly: UsageWindow }>;
} {
  const now = Date.now();
  const H5 = 5 * 60 * 60 * 1000;
  const D7 = 7 * 24 * 60 * 60 * 1000;
  const session = emptyWindow();
  const weekly = emptyWindow();
  const byAccount: Record<string, { session: UsageWindow; weekly: UsageWindow }> = {};

  for (const e of readFold().entries) {
    // Session-scoped — see the owner-scoping rule above.
    if (e.ownerKind !== "session") continue;
    if (now - e.ts > D7) continue;
    byAccount[e.account] ??= { session: emptyWindow(), weekly: emptyWindow() };
    const targets = [weekly, byAccount[e.account].weekly];
    if (now - e.ts <= H5) targets.push(session, byAccount[e.account].session);
    for (const t of targets) {
      t.costUsd += e.costUsd;
      t.inputTokens += e.inputTokens;
      t.outputTokens += e.outputTokens;
      t.requests += 1;
    }
  }
  return { session, weekly, byAccount };
}
