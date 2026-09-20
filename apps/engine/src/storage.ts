/**
 * ══ HOW BIG IS TELAR, AND WHERE — issue #642 ══
 *
 * WHY THIS EXISTS AT ALL, in one measurement. Sizing this Mac's store to write
 * #642 turned up `execution.sqlite` at 993 MB — the second largest thing Telar
 * owns, with a 24 MB WAL beside it — which had never come up in any
 * conversation about disk, including a whole day of work on moving the store.
 * Nothing here would have been learnt by discussing it. That is the argument
 * for a pane that reports, and it is the reason this module attributes EVERY
 * byte under the root to exactly one category: a figure that silently omits a
 * gigabyte is the bug, not a rounding choice.
 *
 * TELAR'S OWN FOOTPRINT AND NOTHING ELSE. The walk starts at the store root and
 * at the worktrees root, and it never follows a symlink — a link into somebody's
 * project would attribute their repository's bytes to Telar, which is how a
 * storage pane turns into a disk cleaner.
 *
 * IT MEASURES WHAT `du` MEASURES — allocated blocks, not apparent size — so the
 * number agrees with Finder's "on disk" and with the terminal somebody will
 * check it against. Hard links are counted once; a file whose blocks are zero
 * but whose size is not (macOS stores a compressed file's data in an extended
 * attribute) falls back to its size rather than reporting nothing.
 *
 * NOTHING HERE CACHES, POLLS, OR SCHEDULES. This is a function that walks a
 * tree and returns a number with a timestamp on it; when it runs is the
 * daemon's decision (see `readStorage` in daemon.ts) and it is driven by a
 * person opening a pane or pressing refresh, never by a timer.
 *
 * AND IT WRITES NOTHING. The pane it feeds is read-only in this pass — no
 * delete, no "clean up" — so there is no call here that could remove a byte.
 */

import fs from "node:fs";
import path from "node:path";
import type { StorageCategory, StorageEntry, StorageReport } from "@telar/engine-client";

/**
 * The store root's own subdirectories, each one a category.
 *
 * `worktrees` IS DELIBERATELY ABSENT from this table. Its root is passed in
 * rather than derived from a name, because #642 part 2 makes it relocatable and
 * a table keyed on "the child called worktrees" would stop finding it the day
 * it moved off this volume. Everything else here is a child of the root by
 * construction.
 */
const DIRECTORY_CATEGORIES: Readonly<Record<string, StorageCategory>> = {
  sessions: "sessions",
  python: "python",
  "browser-profiles": "browser-profiles",
  agent: "agent",
  notes: "notes",
  dictation: "dictation",
  run: "run",
  diagnostics: "diagnostics",
  // Configuration that outgrew a single file, so it reads under the same
  // heading as the JSON beside it rather than as a row of its own.
  orientation: "settings",
};

/**
 * The folder a category opens, for the categories that ARE one folder.
 *
 * NOT THE INVERSE OF THE TABLE ABOVE, deliberately: `settings` is mostly loose
 * files at the root and only incidentally the `orientation/` directory, so
 * reversing the map would send a reader to the one subdirectory that holds
 * almost none of the bytes the row is reporting.
 */
const CATEGORY_DIRECTORIES: Readonly<Partial<Record<StorageCategory, string>>> = {
  sessions: "sessions",
  python: "python",
  "browser-profiles": "browser-profiles",
  agent: "agent",
  notes: "notes",
  dictation: "dictation",
  run: "run",
  diagnostics: "diagnostics",
};

/** The journal, by every name it writes under: the database, its WAL and shared
 *  memory, and the JSON file the sqlite import replaced (execution-store.ts). */
function isJournalFile(name: string): boolean {
  return name === "execution.sqlite" || name.startsWith("execution.sqlite-") || name === "execution-store.json";
}

/**
 * Which category a loose file at the root belongs to.
 *
 * THE TWO USAGE CACHES ARE NAMED, not matched by prefix. `usage-limit-sources`
 * and `usage-limit-secrets` are configuration a person typed — kilobytes, and
 * the same kind of thing as `projects.json` — while the scan cache and the rate
 * list are derived data measured in tens of megabytes. Folding all four under
 * one heading would put a hub's URL in a row called "Spend history".
 */
function categoryOfFile(name: string): StorageCategory {
  if (isJournalFile(name)) return "journal";
  if (name === "usage-scan-cache.json" || name === "usage-model-rates.json") return "usage";
  // `.json.bak-telar-<stamp>` is what a migration leaves beside the file it
  // rewrote; it is the same configuration and belongs in the same row.
  if (name.endsWith(".json") || name.includes(".json.bak") || name === "engine.lock") return "settings";
  return "other";
}

/** A directory whose bytes are one category's, and the file that stands for it
 *  when a reader presses Reveal. */
type Target = { path: string; kind: "directory" | "file" };

/**
 * A single walk's running total.
 *
 * `seen` SPANS THE WHOLE REPORT rather than one subtree: two categories could
 * in principle share an inode, and a hard link counted in both would make the
 * rows add up to more disk than the volume holds.
 */
type Walk = { bytes: number; partial: boolean };

/** How many entries are stat'd at once. Bounded because a store holds hundreds
 *  of thousands of files and an unbounded `Promise.all` over them would open as
 *  many descriptors as the tree is wide. */
const STAT_BATCH = 64;

function bytesOf(stat: fs.Stats): number {
  const allocated = stat.blocks * 512;
  // macOS keeps a compressed file's data in an extended attribute and reports
  // no blocks for it. Reporting zero for a file that plainly holds bytes is
  // worse than reporting its apparent size.
  return allocated > 0 || stat.size === 0 ? allocated : stat.size;
}

/**
 * Every byte under `root`, following nothing out of it.
 *
 * ITERATIVE, NOT RECURSIVE, and the reason is the tree being walked: a store
 * holds a checkout per session and a `node_modules` inside several of them, and
 * a recursive walk over that is a stack the depth of the deepest dependency
 * chain somebody happened to install.
 *
 * A FAILURE IS RECORDED, NEVER THROWN. A directory that cannot be read — a
 * permission, a drive pulled mid-walk — makes the answer a floor rather than a
 * figure, which the report says with `partial`. Throwing would trade a slightly
 * low number for no pane at all.
 */
async function walk(root: string, seen: Set<string>): Promise<Walk> {
  let bytes = 0;
  let partial = false;

  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.lstat(root);
  } catch {
    return { bytes: 0, partial: false }; // Absent is not partial: it is zero.
  }
  if (!rootStat.isDirectory()) return { bytes: bytesOf(rootStat), partial: false };
  bytes += bytesOf(rootStat);

  const frontier: string[] = [root];
  while (frontier.length > 0) {
    const dir = frontier.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      partial = true;
      continue;
    }
    for (let at = 0; at < entries.length; at += STAT_BATCH) {
      const batch = entries.slice(at, at + STAT_BATCH);
      const stats = await Promise.all(
        batch.map(async (entry) => {
          const target = path.join(dir, entry.name);
          try {
            // `lstat`, so a symlink is counted as the link it is and never
            // followed: out of the store, and into a cycle.
            return { target, stat: await fs.promises.lstat(target) };
          } catch {
            return { target, stat: undefined };
          }
        }),
      );
      for (const { target, stat } of stats) {
        if (!stat) {
          partial = true;
          continue;
        }
        if (stat.isDirectory()) {
          frontier.push(target);
          bytes += bytesOf(stat);
          continue;
        }
        if (stat.nlink > 1) {
          const inode = `${stat.dev}:${stat.ino}`;
          if (seen.has(inode)) continue;
          seen.add(inode);
        }
        bytes += bytesOf(stat);
      }
    }
  }
  return { bytes, partial };
}

/**
 * ONE DIRECTORY'S SIZE, BY THE SAME RULE THE PANE IS MEASURED WITH — issue
 * #671's per-checkout figure.
 *
 * EXPORTED RATHER THAN REIMPLEMENTED, and that is the entire point. The
 * checkout listing sits under the "Session checkouts" row and offers to reclaim
 * what that row is counting; if the two used different walkers they would
 * disagree — on allocated blocks versus apparent size, on a symlink, on a hard
 * link — and a listing that disagrees with the number beside it by a gigabyte
 * is worse than no listing at all.
 *
 * ITS OWN `seen` SET, because these are separate questions asked at separate
 * times. Sharing one across calls would make a checkout's size depend on which
 * checkout was measured first.
 */
export async function measureDirectory(target: string): Promise<{ bytes: number; partial: boolean }> {
  return walk(target, new Set<string>());
}

/** Where a category's Reveal lands. Directory categories open themselves; a
 *  category made of loose files opens the folder they sit in, except the
 *  journal, which is one file worth selecting by name. */
function targetOf(category: StorageCategory, root: string): Target {
  if (category === "journal") {
    const database = path.join(root, "execution.sqlite");
    return fs.existsSync(database) ? { path: database, kind: "file" } : { path: root, kind: "directory" };
  }
  const directory = CATEGORY_DIRECTORIES[category];
  return { path: directory ? path.join(root, directory) : root, kind: "directory" };
}

/**
 * WHAT TELAR IS KEEPING, measured once.
 *
 * `worktreesRoot` IS A PARAMETER, and that is the whole of what #642 part 3
 * asked for structurally: a relocated category is a root passed in, walked
 * wherever it is, and reported under its own row — so a second relocatable
 * category is an addition here rather than a rewrite. It may sit inside the
 * store root (where it is today) or outside it (once it can be moved); the
 * inside case is skipped during the root's own walk so its bytes are counted in
 * its own row and not twice.
 */
export async function measureStorage(input: {
  root: string;
  worktreesRoot: string;
  /**
   * Roots that ALSO hold checkouts — a location the setting has moved away
   * from, whose worktrees have not been moved yet (#642 part 2).
   *
   * They are summed into the same row rather than given rows of their own: a
   * person reading "Session checkouts" wants to know what their checkouts cost
   * them, and splitting that across two rows because of an in-progress move
   * would make the pane report Telar's bookkeeping instead of their disk.
   */
  alsoWorktrees?: readonly string[];
  now?: number;
}): Promise<StorageReport> {
  const started = Date.now();
  const root = path.resolve(input.root);
  const worktrees = path.resolve(input.worktreesRoot);
  const seen = new Set<string>();
  const bytes = new Map<StorageCategory, number>();
  let partial = false;

  const add = (category: StorageCategory, amount: number) => bytes.set(category, (bytes.get(category) ?? 0) + amount);

  const alsoWorktrees = (input.alsoWorktrees ?? []).map((extra) => path.resolve(extra)).filter((extra) => extra !== worktrees);
  for (const target of [worktrees, ...alsoWorktrees]) {
    const checkouts = await walk(target, seen);
    if (checkouts.bytes > 0) add("worktrees", checkouts.bytes);
    partial ||= checkouts.partial;
  }

  let children: fs.Dirent[] = [];
  try {
    children = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    partial = true;
  }
  const checkoutRoots = new Set([worktrees, ...alsoWorktrees]);
  for (const child of children) {
    const target = path.join(root, child.name);
    if (checkoutRoots.has(target)) continue; // Counted in its own row, wherever it is.
    if (child.isDirectory()) {
      const measured = await walk(target, seen);
      add(DIRECTORY_CATEGORIES[child.name] ?? "other", measured.bytes);
      partial ||= measured.partial;
      continue;
    }
    try {
      const stat = await fs.promises.lstat(target);
      if (stat.nlink > 1) {
        const inode = `${stat.dev}:${stat.ino}`;
        if (seen.has(inode)) continue;
        seen.add(inode);
      }
      add(categoryOfFile(child.name), bytesOf(stat));
    } catch {
      partial = true;
    }
  }

  const entries: StorageEntry[] = [...bytes.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([category, amount]) => {
      const target = category === "worktrees" ? { path: worktrees, kind: "directory" as const } : targetOf(category, root);
      return { category, bytes: amount, path: target.path, kind: target.kind };
    })
    // Largest first: the row somebody needs to see is the one they did not know
    // about, and that is almost always the big one.
    .sort((left, right) => right.bytes - left.bytes);

  return {
    root,
    total: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    measuredAt: input.now ?? Date.now(),
    tookMs: Date.now() - started,
    partial,
  };
}
