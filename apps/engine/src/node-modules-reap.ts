/**
 * ══ THE `node_modules` UNDER FINISHED CONVERSATIONS — issue #633 ══
 *
 * WHY THIS IS THE FIRST OF THE THREE THINGS #633 ASKS FOR, and not the
 * deduplication everyone reaches for. Most of those trees belong to sessions
 * that will never run again, and **removing a tree strictly dominates making
 * its copies free**: deduplication makes copies 2…N cost nothing, where this
 * makes all N cost nothing. It also works on one disk, on two, and on every
 * platform, where deduplication only ever pays off in the cross-filesystem case
 * that `package-caches.ts` detects.
 *
 * ══ ARCHIVED, AND NOTHING ELSE ══
 *
 * `archived` is a decision somebody made about a conversation — it is over —
 * and it is the only signal here that is a decision rather than a guess.
 * "Settled" is not: it is a live function of a per-reader preference that
 * accepts `null` meaning nothing ever ages out, and a session can be settled
 * this morning and unsettled this afternoon because somebody widened their
 * window. Reaping on it would delete a person's installed dependencies because
 * of a setting they changed in a different pane.
 *
 * A reaped tree is reproducible — `bun install` remakes it — so the cost of
 * being wrong is a re-install and not lost work. That is what makes this
 * defensible at all, and it is why nothing else in this file is deleted: the
 * checkout itself, its uncommitted changes and its branch all stay.
 *
 * ══ THE TWO REFUSALS, AND THEY ARE `git worktree prune`'s LESSON ══
 *
 * `docs/store-location.md` §4a records what happens when a sweep acts on an
 * answer it could not actually read: `prune` guarded on the PROJECT being
 * available, ran while the checkouts' own drive was out, and deleted every
 * worktree registration on it. The work was still on disk; git's record of
 * whose it was, was not.
 *
 *   1. **A LIVE SESSION IS REFUSED** even if it is somehow also archived. A
 *      turn running in that directory right now is holding those files.
 *   2. **AN ABSENT OR UNVERIFIABLE CHECKOUTS ROOT REFUSES THE WHOLE SWEEP**,
 *      before a single candidate is looked at. A worktrees root on a drive that
 *      is out reads as an empty tree, and "the `node_modules` is not there" and
 *      "the disk is not there" are the same observation from the filesystem.
 *      Deleting on the first reading when the second is true is exactly the
 *      §4a failure.
 *
 * ══ A MARKER, BUT NOT `decommission-sweep.ts`'s MARKER ══
 *
 * That one records "this home has been swept" forever, which is right for
 * litter with no reader: the Spool is gone and will not come back. Archived
 * sessions keep arriving, so a once-ever marker would take today's backlog and
 * then never run again — the largest saving, once, and nothing afterwards.
 *
 * So the marker holds the TIME of the last sweep and the sweep runs at most
 * once a day. It buys the same thing that one does — no filesystem walk on
 * every start — without writing the home off as done.
 *
 * ══ IT SAYS WHAT WENT, AND ONLY WHEN SOMETHING DID ══
 *
 * `decommission-sweep.ts`'s rule, for its reason: deleting a person's
 * directories in silence leaves them no evidence but the absence, which is
 * indistinguishable from data loss to whoever goes looking — and a daemon that
 * reports "removed nothing" on every start trains its reader to skip the line
 * that matters.
 */
import fs from "node:fs";
import path from "node:path";
import { statePaths } from "./state-paths";

/**
 * How long between sweeps. A day, because the population this walks is
 * "sessions somebody archived", which changes on the timescale of a person's
 * working week rather than of a turn.
 */
const REAP_EVERY_MS = 24 * 60 * 60 * 1000;

/** One session's checkout, as the sweep needs to see it. Taken as data rather
 *  than read from a store, so the rule below is a unit test with no database:
 *  the caller already holds every one of these fields. */
export type ReapCandidate = {
  sessionId: string;
  /** The checkout's absolute path. Its `node_modules`, if any, is what goes. */
  worktree: string;
  /** Somebody decided this conversation is over. The ONLY signal that licenses
   *  a delete here — see the header on why "settled" does not. */
  archived: boolean;
  /** A turn is queued, claimed or running. Refused whatever `archived` says. */
  live: boolean;
};

/** One tree that went, and what it held. */
export type ReapedTree = { sessionId: string; path: string; bytes: number; files: number };

export type NodeModulesReap = {
  /** Empty when there was nothing to take — including on a home swept today. */
  reaped: ReapedTree[];
  /** Why the ones that stayed, stayed. Counts rather than a log line: a reaped
   *  tree and a refused one print the same session id, so a grep is satisfied
   *  by either. */
  refused: { live: number; working: number };
  /** Set when the whole sweep stood down, with the reason. Distinct from
   *  `reaped: []`, which is "nothing qualified". */
  standDown?: "root-unreadable" | "swept-recently";
};

export type ReapDeps = {
  now?: () => number;
  /** Removal, injected so a test can prove the refusals WITHOUT a filesystem —
   *  a refusal proven by a directory still existing is also satisfied by a
   *  removal that silently failed. */
  remove?: (directory: string) => void;
  exists?: (target: string) => boolean;
};

/** What one tree held, so the deletion can say what it took. TOLERANT BY
 *  DESIGN, `decommission-sweep.ts`'s rule: a tree being swept is a tree nothing
 *  else should be touching, and an unreadable corner must not stop the sweep.
 *
 *  THE BYTES ARE APPARENT, and that is a report rather than a measurement — on
 *  APFS a clone is counted at full size, so this number is an upper bound on
 *  what the disk gets back (#633). The test proves the space with free-space
 *  deltas instead, which is the only instrument that can. */
function treeSize(directory: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const frontier = [directory];
  while (frontier.length > 0) {
    const at = frontier.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { frontier.push(full); continue; }
      try { bytes += fs.lstatSync(full).size; files += 1; } catch { /* vanished mid-walk: counted for nothing */ }
    }
  }
  return { bytes, files };
}

/**
 * Reap the `node_modules` of archived sessions' checkouts.
 *
 * `rootReadable` IS THE CALLER'S ANSWER, NOT A PATH TEST. It is
 * `readWorktreesRoot(...).kind === "configured" | "default"` — the one place
 * that knows the difference between "the drive is out", "this build cannot
 * tell" and "it is right here", and re-deriving it from a `stat` is how a sweep
 * ends up deleting because a mount point looked like an empty directory.
 *
 * BEST-EFFORT, NEVER FATAL. A tree that will not remove leaves the home exactly
 * as it was; failing a daemon's boot over a `node_modules` would be a worse
 * outcome than the `node_modules`.
 */
export function reapNodeModules(
  engineRoot: string,
  input: { rootReadable: boolean; candidates: readonly ReapCandidate[] },
  deps: ReapDeps = {},
): NodeModulesReap {
  const now = deps.now ?? (() => Date.now());
  const remove = deps.remove ?? ((directory: string) => fs.rmSync(directory, { recursive: true, force: true }));
  const exists = deps.exists ?? ((target: string) => fs.existsSync(target));
  const empty: NodeModulesReap = { reaped: [], refused: { live: 0, working: 0 } };

  // REFUSED BEFORE A SINGLE CANDIDATE IS LOOKED AT — see the header. An absent
  // checkouts root makes every tree look already gone.
  if (!input.rootReadable) return { ...empty, standDown: "root-unreadable" };

  const marker = statePaths(engineRoot).nodeModulesReaped;
  const last = Number(readMarker(marker));
  if (Number.isFinite(last) && last > 0 && now() - last < REAP_EVERY_MS) return { ...empty, standDown: "swept-recently" };

  const reaped: ReapedTree[] = [];
  const refused = { live: 0, working: 0 };
  for (const candidate of input.candidates) {
    // A LIVE TURN OUTRANKS THE ARCHIVE FLAG. Counted separately from the
    // ordinary "not archived" case, because it is the one worth seeing: a
    // session both archived and running is a state somebody should look at.
    if (candidate.live) { if (candidate.archived) refused.working += 1; else refused.live += 1; continue; }
    if (!candidate.archived) { refused.live += 1; continue; }
    const tree = path.join(candidate.worktree, "node_modules");
    if (!exists(tree)) continue;
    const { bytes, files } = treeSize(tree);
    try {
      remove(tree);
      reaped.push({ sessionId: candidate.sessionId, path: tree, bytes, files });
    } catch {
      // Left where it is. The marker below still goes down: a single tree that
      // will not remove is not a reason to re-walk every checkout tomorrow and
      // fail on the same one.
    }
  }

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${new Date(now()).toISOString()}\n`, "utf8");
  } catch {
    // A marker we cannot write costs one cheap walk on the next start. Not
    // worth a failure, and `decommission-sweep.ts` makes the same trade.
  }
  return { reaped, refused };
}

function readMarker(marker: string): number {
  try { return Date.parse(fs.readFileSync(marker, "utf8").trim()); } catch { return 0; }
}

/**
 * The one line, composed where it can be tested without a daemon. `undefined`
 * when nothing went — which includes every stand-down, because "Telar did not
 * do a thing you did not know it did" is not news.
 *
 * IT NAMES THE COUNT AND THE SIZE AND SAYS THEY COME BACK, because the reader
 * of this line has just been told a directory was deleted and the only thing
 * that makes that acceptable is that `bun install` remakes it.
 */
export function reapReport(reap: NodeModulesReap): string | undefined {
  if (reap.reaped.length === 0) return undefined;
  const bytes = reap.reaped.reduce((sum, tree) => sum + tree.bytes, 0);
  const size = bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${(bytes / 1_000_000).toFixed(0)} MB`;
  const trees = `${reap.reaped.length.toLocaleString("en-US")} ${reap.reaped.length === 1 ? "checkout" : "checkouts"}`;
  // "up to", because the figure is apparent size and APFS clones are counted
  // in full — see `treeSize`. Overstating what a person got back is the one
  // direction this sentence must not go.
  return `Telar engine: removed node_modules from ${trees} of archived sessions — up to ${size}, remade by the next install (#633)`;
}
