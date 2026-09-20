/**
 * REAPING `node_modules` FROM ARCHIVED SESSIONS' CHECKOUTS — issue #633.
 *
 * ══ THE INSTRUMENT, FIRST, BECAUSE THREE OBVIOUS ONES LIE HERE ══
 *
 * `du` cannot see APFS block sharing, so a free clone and a paid copy read
 * identically. `stat.blocks` is the same fact one level down. A hardlink count
 * reads 1 either way, because bun's macOS default backend is `clonefile`, which
 * shares blocks WITHOUT raising `st_nlink`. #633 measured all three against a
 * 256 MB file: a real write consumed 257 MB of free space, `cp -c` consumed
 * −1 MB, a plain `cp` consumed 256 MB — and `du` read 262144 KB for all three
 * while `stat` read 524288 blocks for all three.
 *
 * **Only free space moved.** So the space proof below is a free-space delta —
 * `statfs`, which is what `df -k` reads — taken as tightly around the removal
 * as it can be. Nothing in this file calls `du`, reads `.blocks`, or counts a
 * link.
 *
 * ══ AND THE BOUND IS LOOSE ON PURPOSE ══
 *
 * A filesystem on a shared machine is not quiet: other processes allocate and
 * free while this runs. A tight assertion would be a flake, and a flake in a
 * test about deleting things is worse than no test — somebody re-runs it until
 * it passes. So the fixture writes a file far larger than the noise and asserts
 * a fraction of it came back. The failure this must catch is "nothing was
 * deleted", which is a delta of zero, and a loose bound catches that exactly as
 * well as a tight one.
 *
 * ══ WHAT THE REFUSALS ARE PROVEN WITH, AND WHY IT IS NOT A DIRECTORY ══
 *
 * `remove` is injected. A refusal proven by "the directory is still there" is
 * also satisfied by a removal that silently failed — so the refusal tests
 * assert that the remover was NEVER CALLED, which only a refusal can produce.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reapNodeModules, reapReport, type ReapCandidate } from "../src/node-modules-reap";

const made: string[] = [];
afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const NOW = Date.parse("2026-03-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reap-"));
  made.push(root);
  return root;
}

/** A checkout with a `node_modules` in it. `bytes` is written as real,
 *  incompressible content: a sparse or compressible file would be freed by the
 *  filesystem rather than by the sweep, which is the one way this could pass
 *  without the code working. */
function checkout(root: string, sessionId: string, bytes = 0): string {
  const worktree = path.join(root, "worktrees", sessionId);
  fs.mkdirSync(path.join(worktree, "node_modules", "some-package"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "node_modules", "some-package", "index.js"), "module.exports = 1;\n");
  if (bytes > 0) fs.writeFileSync(path.join(worktree, "node_modules", "some-package", "payload"), crypto.getRandomValues(new Uint8Array(bytes)));
  // The checkout's own work, which must survive.
  fs.writeFileSync(path.join(worktree, "README.md"), "the person's uncommitted work\n");
  return worktree;
}

const candidate = (sessionId: string, worktree: string, patch: Partial<ReapCandidate> = {}): ReapCandidate =>
  ({ sessionId, worktree, archived: true, live: false, ...patch });

test("an archived session's node_modules goes, and its work does not", () => {
  const root = home();
  const worktree = checkout(root, "session_archived");
  const reap = reapNodeModules(root, { rootReadable: true, candidates: [candidate("session_archived", worktree)] }, { now: () => NOW });
  expect(reap.reaped).toHaveLength(1);
  expect(reap.reaped[0]!.sessionId).toBe("session_archived");
  expect(reap.reaped[0]!.files).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  // THE CHECKOUT ITSELF, ITS UNCOMMITTED WORK AND ITS BRANCH ALL STAY. What
  // makes a delete defensible here is that only the reproducible part goes.
  expect(fs.readFileSync(path.join(worktree, "README.md"), "utf8")).toContain("uncommitted work");
});

test("a session that is not archived is refused, and the remover is never called", () => {
  const root = home();
  const worktree = checkout(root, "session_open");
  let removals = 0;
  const reap = reapNodeModules(
    root,
    { rootReadable: true, candidates: [candidate("session_open", worktree, { archived: false })] },
    { now: () => NOW, remove: () => { removals += 1; } },
  );
  // ASSERTED ON THE REMOVER, not on the directory: "it is still there" is also
  // what a removal that silently failed produces.
  expect(removals).toBe(0);
  expect(reap.reaped).toHaveLength(0);
  expect(reap.refused.live).toBe(1);
});

test("a live turn outranks the archive flag — the first refusal #633 asks for", () => {
  const root = home();
  const worktree = checkout(root, "session_working");
  let removals = 0;
  const reap = reapNodeModules(
    root,
    // Archived AND running: a turn in that directory right now is holding
    // those files, and the archive flag does not change that.
    { rootReadable: true, candidates: [candidate("session_working", worktree, { live: true })] },
    { now: () => NOW, remove: () => { removals += 1; } },
  );
  expect(removals).toBe(0);
  expect(reap.refused.working).toBe(1);
  expect(reap.reaped).toHaveLength(0);
});

test("an unreadable checkouts root stands the whole sweep down — the second refusal", () => {
  const root = home();
  const worktree = checkout(root, "session_archived");
  let removals = 0;
  const reap = reapNodeModules(
    root,
    { rootReadable: false, candidates: [candidate("session_archived", worktree)] },
    { now: () => NOW, remove: () => { removals += 1; } },
  );
  /**
   * `git worktree prune`'s LESSON, from `docs/store-location.md` §4a: that
   * sweep guarded on the PROJECT being available, ran while the checkouts' own
   * drive was out, and deleted every worktree registration on it. A drive that
   * is out and a tree that was never installed are the same observation from
   * the filesystem, and acting on the second reading when the first is true is
   * how work in somebody's bag disappears.
   */
  expect(removals).toBe(0);
  expect(reap.standDown).toBe("root-unreadable");
  expect(reap.reaped).toHaveLength(0);
  // AND NO MARKER, so the next start tries again rather than writing this home
  // off as swept while the drive was simply out.
  expect(fs.existsSync(path.join(root, "node-modules-reaped"))).toBe(false);
});

test("the marker bounds the sweep to once a day, and does not write the home off forever", () => {
  const root = home();
  const first = checkout(root, "session_one");
  expect(reapNodeModules(root, { rootReadable: true, candidates: [candidate("session_one", first)] }, { now: () => NOW }).reaped).toHaveLength(1);

  // An hour later: stood down, and it says which stand-down this is.
  const second = checkout(root, "session_two");
  const soon = reapNodeModules(root, { rootReadable: true, candidates: [candidate("session_two", second)] }, { now: () => NOW + 60 * 60 * 1000 });
  expect(soon.standDown).toBe("swept-recently");
  expect(fs.existsSync(path.join(second, "node_modules"))).toBe(true);

  /**
   * A DAY LATER IT RUNS AGAIN, which is the whole difference from
   * `decommission-sweep.ts`'s marker. That one records "this home has been
   * swept" forever, which is right for litter with no reader — the Spool is
   * gone and will not come back. Archived sessions keep arriving, so a
   * once-ever marker would take today's backlog and then never run again.
   */
  const later = reapNodeModules(root, { rootReadable: true, candidates: [candidate("session_two", second)] }, { now: () => NOW + DAY + 1 });
  expect(later.standDown).toBeUndefined();
  expect(later.reaped).toHaveLength(1);
  expect(fs.existsSync(path.join(second, "node_modules"))).toBe(false);
});

test("the space really comes back — proven by free space, the only instrument that can", () => {
  const root = home();
  // 64 MiB of random bytes: far above the noise a shared machine makes in the
  // moment between the two readings, and incompressible so the filesystem
  // cannot have been the one to free it.
  const PAYLOAD = 64 * 1024 * 1024;
  const worktree = checkout(root, "session_archived", PAYLOAD);

  const free = () => {
    const stat = fs.statfsSync(root);
    return Number(stat.bavail) * Number(stat.bsize);
  };
  const before = free();
  const reap = reapNodeModules(root, { rootReadable: true, candidates: [candidate("session_archived", worktree)] }, { now: () => NOW });
  const after = free();

  expect(reap.reaped).toHaveLength(1);
  /**
   * A QUARTER OF WHAT WENT IN, and the looseness is the point — see this
   * file's header. The failure worth catching is "nothing was deleted", which
   * is a delta of zero or below; a tight bound would only add flakes on a
   * machine with thirty other sessions allocating beside it.
   *
   * AND NOTE WHAT IS NOT ASSERTED: `reap.reaped[0].bytes`. That figure is
   * apparent size, which counts an APFS clone in full — it is an upper bound
   * on what the disk gets back and would pass here whether or not a single
   * block was freed.
   */
  expect(after - before).toBeGreaterThan(PAYLOAD / 4);
});

test("the line is said only when something went, and never overstates it", () => {
  expect(reapReport({ reaped: [], refused: { live: 0, working: 0 } })).toBeUndefined();
  // A STAND-DOWN IS NOT NEWS EITHER. "Telar did not do a thing you did not
  // know it did" trains a reader to skip the line that matters.
  expect(reapReport({ reaped: [], refused: { live: 2, working: 1 }, standDown: "root-unreadable" })).toBeUndefined();

  const said = reapReport({
    reaped: [
      { sessionId: "a", path: "/x/a/node_modules", bytes: 1_200_000_000, files: 40_000 },
      { sessionId: "b", path: "/x/b/node_modules", bytes: 300_000_000, files: 9_000 },
    ],
    refused: { live: 0, working: 0 },
  })!;
  expect(said).toContain("2 checkouts");
  expect(said).toContain("1.5 GB");
  // "UP TO", because the figure is apparent size and a clone is counted in
  // full. Overstating what a person got back is the one direction this
  // sentence must not go.
  expect(said).toContain("up to");
  expect(said).toContain("remade by the next install");
});
