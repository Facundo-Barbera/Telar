/**
 * Issue #671 — listing the checkouts, and proving which may go.
 *
 * THE LADDER IS TESTED AS A PURE FUNCTION, with no repository anywhere near it.
 * That is the reason `classifyCheckout` was split out: every safety property
 * this feature claims is decided there, and a test that needed a real checkout
 * to assert "an unmounted drive is never an orphan" would be a test nobody
 * writes the awkward cases for.
 *
 * NOTHING HERE REMOVES ANYTHING REAL. The fixtures are temp repositories built
 * per test and deleted after; the engine's own store is never opened, and the
 * one test that exercises a removal does it inside a tmpdir root it created.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildInventory, classifyCheckout, describeReclaim, type CheckoutFacts } from "../src/worktree-inventory";
import { createAsyncGitRunner, removeUnregisteredCheckout } from "../src/worktree";
import { measureDirectory } from "../src/storage";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const git = createAsyncGitRunner();

/** A checkout that would be reclaimable if nothing else were said about it, so
 *  each test states only the fact it is about. */
const safe: CheckoutFacts = {
  readable: true,
  busy: false,
  protectedTree: false,
  owner: { kind: "none" },
  clean: true,
  merged: true,
  hasBranch: true,
};

// ── Rung 0 ────────────────────────────────────────────────────────────────

test("an unreadable checkout is locked, whatever else is true of it", () => {
  expect(classifyCheckout({ ...safe, readable: false })).toEqual({ kind: "locked", reason: "unreadable" });
});

/**
 * THE CASE THE FEATURE WOULD HAVE BEEN DANGEROUS WITHOUT.
 *
 * A drive that is not mounted produces no directories, matches no recorded
 * path, and proves nothing about merge state or cleanliness. Every one of those
 * absences is the shape of an orphan. If the ladder asked "does a session claim
 * it" before "did anybody look", unplugging a disk would offer to reclaim its
 * entire contents in one press.
 */
test("an unreadable checkout is never an orphan, and never reclaimable", () => {
  const verdict = classifyCheckout({
    ...safe,
    readable: false,
    owner: { kind: "none" },
    clean: undefined,
    merged: undefined,
    hasBranch: false,
  });
  expect(verdict).toEqual({ kind: "locked", reason: "unreadable" });
  expect(verdict.kind).not.toBe("reclaimable");
  expect(verdict.kind).not.toBe("needs-force");
});

test("unreadable outranks in-use, protected and active", () => {
  for (const extra of [
    { busy: true },
    { protectedTree: true },
    { owner: { kind: "session" as const, sessionId: "s1", lifecycle: "live" as const } },
  ]) {
    expect(classifyCheckout({ ...safe, ...extra, readable: false })).toEqual({ kind: "locked", reason: "unreadable" });
  }
});

// ── Rung 1 ────────────────────────────────────────────────────────────────

/**
 * THE REFUSAL THAT IS A POLICY, NOT AN ERROR.
 *
 * git's lock does not refuse Telar — `removeSessionWorktreeAsync` unlocks
 * before removing, deliberately — so a reclaim aimed at a working session's
 * checkout would SUCCEED and take the directory an agent is writing in. Nothing
 * downstream can catch that. This rung is the only thing that stops it.
 */
test("a checkout a session is working in is locked, even when it is merged and clean", () => {
  const facts: CheckoutFacts = {
    ...safe,
    busy: true,
    owner: { kind: "session", sessionId: "s1", lifecycle: "settled" },
  };
  expect(classifyCheckout(facts)).toEqual({ kind: "locked", reason: "in-use" });
});

test("busy outranks protected and active, so the sharpest true reason is the one shown", () => {
  expect(classifyCheckout({ ...safe, busy: true, protectedTree: true })).toEqual({ kind: "locked", reason: "in-use" });
});

// ── Rungs 2 and 3 ─────────────────────────────────────────────────────────

test("the main checkout and the engine's own tree are protected", () => {
  expect(classifyCheckout({ ...safe, protectedTree: true })).toEqual({ kind: "locked", reason: "protected" });
});

test("a live session's checkout is locked — removing it would break the session silently", () => {
  expect(classifyCheckout({ ...safe, owner: { kind: "session", sessionId: "s1", lifecycle: "live" } })).toEqual({
    kind: "locked",
    reason: "active",
  });
});

test("a settled session's checkout is reclaimable when the work in it is safe", () => {
  expect(classifyCheckout({ ...safe, owner: { kind: "session", sessionId: "s1", lifecycle: "settled" } })).toEqual({ kind: "reclaimable" });
});

/** `releaseWorktree` is best-effort and skips an unavailable disk, so an
 *  archive performed while the drive was out leaves exactly this: a directory
 *  whose session has already been put down. */
test("an archived session's leftover checkout is reclaimable", () => {
  expect(classifyCheckout({ ...safe, owner: { kind: "session", sessionId: "s1", lifecycle: "archived" } })).toEqual({ kind: "reclaimable" });
});

test("a checkout no session claims is reclaimable when merged and clean", () => {
  expect(classifyCheckout(safe)).toEqual({ kind: "reclaimable" });
});

// ── Rung 4, and the third answer ──────────────────────────────────────────

test("uncommitted work needs the typed force", () => {
  expect(classifyCheckout({ ...safe, clean: false })).toEqual({ kind: "needs-force", reasons: ["dirty"] });
});

test("an unmerged branch needs the typed force", () => {
  expect(classifyCheckout({ ...safe, merged: false })).toEqual({ kind: "needs-force", reasons: ["unmerged"] });
});

/**
 * A KILLED `merge-base` IS NOT "NOT MERGED" AND A KILLED `status` IS NOT
 * "CLEAN". #650 and #654 each learnt this in a different surface; here the
 * second one loses work, because a tree wrongly called clean is a tree removed
 * without a prompt.
 */
test("an unproven merge state is `unknown`, never `unmerged`", () => {
  expect(classifyCheckout({ ...safe, merged: undefined })).toEqual({ kind: "needs-force", reasons: ["unknown"] });
});

test("an unproven working tree is `unknown`, never clean", () => {
  const verdict = classifyCheckout({ ...safe, clean: undefined });
  expect(verdict).toEqual({ kind: "needs-force", reasons: ["unknown"] });
  expect(verdict.kind).not.toBe("reclaimable");
});

test("two unproven reads are one reason to go and look, not two", () => {
  expect(classifyCheckout({ ...safe, clean: undefined, merged: undefined })).toEqual({ kind: "needs-force", reasons: ["unknown"] });
});

test("no branch means nothing can be proved merged, and it is never assumed", () => {
  expect(classifyCheckout({ ...safe, hasBranch: false, merged: undefined })).toEqual({ kind: "needs-force", reasons: ["no-branch"] });
});

test("dirty and unmerged are reported together, because they are two errands", () => {
  expect(classifyCheckout({ ...safe, clean: false, merged: false })).toEqual({ kind: "needs-force", reasons: ["unmerged", "dirty"] });
});

// ── The inventory, against real repositories ──────────────────────────────

function repo(): { root: string; worktrees: string } {
  const root = tmp("telar-671-repo-");
  const worktrees = tmp("telar-671-cuts-");
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  run("add", ".");
  run("commit", "-m", "first");
  return { root, worktrees };
}

const deps = { git, measure: measureDirectory };

test("a checkout with no session is found by scanning the root, and nothing else can see it", async () => {
  const { root, worktrees } = repo();
  // A pruned checkout: a directory in the root that git has no registration for
  // and no session records. Invisible to `git worktree list` and to the session
  // records alike — the class this feature exists for.
  const orphan = path.join(worktrees, "telar--gone-abcd1234");
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, "leftover.txt"), "x".repeat(2048));

  const inventory = await buildInventory(deps, {
    roots: [worktrees],
    rootsReadable: true,
    sessions: [],
    projects: [{ id: "p1", name: "Repo", root, available: true }],
  });

  const row = inventory.rows.find((entry) => entry.basename === "telar--gone-abcd1234");
  expect(row).toBeDefined();
  expect(row!.owner).toEqual({ kind: "none" });
  expect(row!.registered).toBe(false);
  expect(row!.onDisk).toBe(true);
  expect(row!.bytes).toBeGreaterThan(0);
});

test("a merged, clean, settled checkout comes back reclaimable and sized", async () => {
  const { root, worktrees } = repo();
  const checkout = path.join(worktrees, "telar--done-11112222");
  // Cut from main and never moved on, so it is trivially an ancestor of main.
  execFileSync("git", ["worktree", "add", "-b", "telar/done", checkout, "main"], { cwd: root, stdio: "pipe" });

  const inventory = await buildInventory(deps, {
    roots: [worktrees],
    rootsReadable: true,
    sessions: [{ id: "s1", path: checkout, branch: "telar/done", projectId: "p1", lifecycle: "settled", busy: false }],
    projects: [{ id: "p1", name: "Repo", root, available: true }],
  });

  const row = inventory.rows.find((entry) => entry.basename === "telar--done-11112222");
  expect(row).toBeDefined();
  expect(row!.verdict).toEqual({ kind: "reclaimable" });
  expect(row!.merged).toBe(true);
  expect(row!.clean).toBe(true);
  expect(row!.owner).toEqual({ kind: "session", sessionId: "s1", lifecycle: "settled" });
  expect(row!.bytes).toBeGreaterThan(0);
  expect(row!.updatedAt).toBeGreaterThan(0);
});

test("a checkout with uncommitted work is never reclaimable, however finished its session looks", async () => {
  const { root, worktrees } = repo();
  const checkout = path.join(worktrees, "telar--dirty-33334444");
  execFileSync("git", ["worktree", "add", "-b", "telar/dirty", checkout, "main"], { cwd: root, stdio: "pipe" });
  fs.writeFileSync(path.join(checkout, "unsaved.txt"), "work that is only here\n");

  const inventory = await buildInventory(deps, {
    roots: [worktrees],
    rootsReadable: true,
    sessions: [{ id: "s1", path: checkout, branch: "telar/dirty", projectId: "p1", lifecycle: "settled", busy: false }],
    projects: [{ id: "p1", name: "Repo", root, available: true }],
  });

  const row = inventory.rows.find((entry) => entry.basename === "telar--dirty-33334444");
  expect(row!.clean).toBe(false);
  expect(row!.verdict).toEqual({ kind: "needs-force", reasons: ["dirty"] });
});

/**
 * THE UNMOUNTED DRIVE, END TO END.
 *
 * The recorded checkouts are still described — a person is owed the list of
 * what is out there — but every one is locked `unreadable`, none is called an
 * orphan, and none carries a size, because no walk was performed. An empty list
 * would have been the reassuring lie; a list of reclaimable orphans would have
 * been the dangerous one.
 */
test("when the checkouts' drive is out, every row is unreadable and nothing is sized", async () => {
  const { root } = repo();
  const away = path.join(os.tmpdir(), "telar-671-not-mounted", "cuts");

  const inventory = await buildInventory(deps, {
    roots: [away],
    rootsReadable: false,
    blocker: "TelarVR is not connected.",
    sessions: [{ id: "s1", path: path.join(away, "telar--away-55556666"), branch: "telar/away", projectId: "p1", lifecycle: "settled", busy: false }],
    projects: [{ id: "p1", name: "Repo", root, available: true }],
  });

  expect(inventory.blocker).toBe("TelarVR is not connected.");
  expect(inventory.rows.length).toBeGreaterThan(0);
  for (const row of inventory.rows) {
    expect(row.verdict).toEqual({ kind: "locked", reason: "unreadable" });
    expect(row.bytes).toBeUndefined();
    expect(row.clean).toBeUndefined();
    expect(row.merged).toBeUndefined();
  }
});

test("a project whose own disk is gone makes its checkouts unreadable, not orphaned", async () => {
  const { root, worktrees } = repo();
  const checkout = path.join(worktrees, "telar--offline-77778888");
  execFileSync("git", ["worktree", "add", "-b", "telar/offline", checkout, "main"], { cwd: root, stdio: "pipe" });

  const inventory = await buildInventory(deps, {
    roots: [worktrees],
    rootsReadable: true,
    sessions: [{ id: "s1", path: checkout, branch: "telar/offline", projectId: "p1", lifecycle: "settled", busy: false }],
    // The checkouts are readable; the REPOSITORY is not. Every git proof about
    // this row would be an answer about a repository nobody can read.
    projects: [{ id: "p1", name: "Repo", root, available: false }],
  });

  const row = inventory.rows.find((entry) => entry.basename === "telar--offline-77778888");
  expect(row!.verdict).toEqual({ kind: "locked", reason: "unreadable" });
  expect(row!.owner).toEqual({ kind: "session", sessionId: "s1", lifecycle: "settled" });
});

test("the project's own checkout is not offered as a row at all", async () => {
  const { root, worktrees } = repo();
  const inventory = await buildInventory(deps, {
    roots: [worktrees],
    rootsReadable: true,
    sessions: [],
    projects: [{ id: "p1", name: "Repo", root, available: true }],
  });
  expect(inventory.rows.some((row) => path.resolve(row.path) === fs.realpathSync.native(root))).toBe(false);
});

test("a session working in its checkout is locked in-use rather than offered", async () => {
  const { root, worktrees } = repo();
  const checkout = path.join(worktrees, "telar--busy-99990000");
  execFileSync("git", ["worktree", "add", "-b", "telar/busy", checkout, "main"], { cwd: root, stdio: "pipe" });

  const inventory = await buildInventory(deps, {
    roots: [worktrees],
    rootsReadable: true,
    sessions: [{ id: "s1", path: checkout, branch: "telar/busy", projectId: "p1", lifecycle: "settled", busy: true }],
    projects: [{ id: "p1", name: "Repo", root, available: true }],
  });

  const row = inventory.rows.find((entry) => entry.basename === "telar--busy-99990000");
  expect(row!.verdict).toEqual({ kind: "locked", reason: "in-use" });
});

test("reclaimable rows sort before the rest, biggest first", async () => {
  const { root, worktrees } = repo();
  for (const [name, size] of [
    ["telar--small-aaaa1111", 1024],
    ["telar--big-bbbb2222", 64 * 1024],
  ] as const) {
    const target = path.join(worktrees, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "blob"), "x".repeat(size));
  }
  const inventory = await buildInventory(deps, {
    roots: [worktrees],
    rootsReadable: true,
    sessions: [],
    projects: [{ id: "p1", name: "Repo", root, available: true }],
  });
  // Both are unregistered and have no branch, so both need the force — what is
  // asserted here is the size ordering inside a rank.
  const names = inventory.rows.map((row) => row.basename);
  expect(names.indexOf("telar--big-bbbb2222")).toBeLessThan(names.indexOf("telar--small-aaaa1111"));
});

// ── The fenced removal ────────────────────────────────────────────────────

test("an unregistered checkout is removed only from inside a root the engine manages", () => {
  const managed = tmp("telar-671-managed-");
  const elsewhere = tmp("telar-671-elsewhere-");

  const inside = path.join(managed, "telar--stray-cccc3333");
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, "blob"), "bytes");

  const outside = path.join(elsewhere, "somebodys-project");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "important.txt"), "not Telar's to delete");

  expect(removeUnregisteredCheckout(outside, [managed])).toBe(false);
  expect(fs.existsSync(outside)).toBe(true);

  expect(removeUnregisteredCheckout(inside, [managed])).toBe(true);
  expect(fs.existsSync(inside)).toBe(false);
});

/** A DIRECT CHILD, NOT A DESCENDANT. `planSessionWorktree` puts every cut
 *  exactly one level down, so accepting a descendant would let "remove this
 *  checkout" remove something INSIDE one. */
test("a directory nested inside a checkout is refused", () => {
  const managed = tmp("telar-671-nested-");
  const checkout = path.join(managed, "telar--held-dddd4444");
  const nested = path.join(checkout, "src");
  fs.mkdirSync(nested, { recursive: true });

  expect(removeUnregisteredCheckout(nested, [managed])).toBe(false);
  expect(fs.existsSync(nested)).toBe(true);
});

test("the root itself is never removable", () => {
  const managed = tmp("telar-671-root-");
  expect(removeUnregisteredCheckout(managed, [managed])).toBe(false);
  expect(fs.existsSync(managed)).toBe(true);
});

// ── The sentence ──────────────────────────────────────────────────────────

test("the summary counts archived sessions and removed checkouts separately", () => {
  const sentence = describeReclaim([
    { ok: true, action: "archived", bytes: 2 * 1024 ** 3 },
    { ok: true, action: "archived", bytes: 1024 ** 3 },
    { ok: true, action: "removed", bytes: 512 * 1024 ** 2 },
  ]);
  expect(sentence).toContain("Archived 2 sessions");
  expect(sentence).toContain("Removed 1 checkout");
  expect(sentence).toContain("GB back");
});

test("a refusal is named rather than folded into a total", () => {
  const sentence = describeReclaim([{ ok: false, refusal: "in-use" }, { ok: false, refusal: "active" }]);
  expect(sentence).toContain("worked in right now");
  expect(sentence).toContain("still on the rail");
});

test("a press that did nothing says so", () => {
  expect(describeReclaim([])).toBe("There was nothing to give back.");
});
