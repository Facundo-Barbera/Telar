"use strict";

const { afterEach, beforeEach, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { initialiseStore, readStamp, STAMP_NAME } = require("./store-location");
const migrate = require("./store-migrate");

let scratch;
let source;
let target;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-migrate-"));
  source = path.join(scratch, "source");
  target = path.join(scratch, "target");
  fs.mkdirSync(target, { recursive: true });
  seedStore(source);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function seedStore(root) {
  fs.mkdirSync(path.join(root, "engine", "sessions", "session_one"), { recursive: true });
  fs.mkdirSync(path.join(root, "remote"), { recursive: true });
  fs.writeFileSync(path.join(root, "engine", "projects.json"), JSON.stringify({ projects: [{ id: "p" }] }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "engine", "sessions", "session_one", "session.json"), JSON.stringify({ id: "s" }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "engine", "big.bin"), crypto.randomBytes(3 << 20));
  fs.writeFileSync(path.join(root, "remote", "remote.json"), JSON.stringify({ version: 1, devices: [] }), { mode: 0o600 });
  return initialiseStore(root);
}

function fingerprint(root) {
  const out = {};
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = relative === "" ? entry.name : path.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else out[next] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, next))).digest("hex");
    }
  };
  walk("");
  return out;
}

const roomy = () => 2 ** 40;

test("a target inside the source is refused, and so is a source inside the target", () => {
  expect(migrate.preflight({ source, target: path.join(source, "inside") }, { freeSpace: roomy }).step).toBe("target");
  expect(migrate.preflight({ source: path.join(target, "inside"), target }, { freeSpace: roomy }).step).toBe("target");
});

test("moving to where it already is is refused", () => {
  expect(migrate.preflight({ source, target: source }, { freeSpace: roomy }).ok).toBe(false);
});

test("a target that already holds a store is refused rather than written over", () => {
  seedStore(target);
  const outcome = migrate.preflight({ source, target }, { freeSpace: roomy });
  expect(outcome.ok).toBe(false);
  expect(outcome.message).toContain("already a Telar store");
});

test("the wreckage of an interrupted move is refused, never resumed", () => {
  fs.mkdirSync(path.join(target, `${migrate.STAGING_PREFIX}123`), { recursive: true });
  const outcome = migrate.preflight({ source, target }, { freeSpace: roomy });
  expect(outcome.ok).toBe(false);
  expect(outcome.message).toContain("interrupted move");
});

test("a disk without room is refused before anything is copied", () => {
  const outcome = migrate.preflight({ source, target }, { freeSpace: () => 1024 });
  expect(outcome.step).toBe("space");
  expect(fs.readdirSync(target)).toEqual([]);
});

test("a disk whose free space cannot be measured is refused, not waved through", () => {
  expect(migrate.preflight({ source, target }, { freeSpace: () => undefined }).step).toBe("space");
});

test("a source with no stamp is not a store to move", () => {
  fs.rmSync(path.join(source, STAMP_NAME));
  expect(migrate.preflight({ source, target }, { freeSpace: roomy }).step).toBe("source");
});

test("a store containing a symlink is refused rather than guessed at", () => {
  fs.symlinkSync(path.join(source, "engine", "projects.json"), path.join(source, "engine", "link.json"));
  const outcome = migrate.preflight({ source, target }, { freeSpace: roomy });
  expect(outcome.ok).toBe(false);
  expect(outcome.message).toContain("symbolic link");
});

test("a move copies every byte, carries the store's id, and retires the source without deleting it", async () => {
  const before = fingerprint(source);
  const storeId = readStamp(source).storeId;
  const phases = new Set();

  const outcome = await migrate.migrateStore(
    { source, target, onProgress: (p) => phases.add(p.phase) },
    { freeSpace: roomy, checkSqlite: () => ({ ok: true }) },
  );

  expect(outcome.ok).toBe(true);
  expect(outcome.storeId).toBe(storeId);

  expect(readStamp(target).storeId).toBe(storeId);

  const after = fingerprint(target);
  for (const [file, hash] of Object.entries(before)) {
    if (file === STAMP_NAME) continue;
    expect(after[file]).toBe(hash);
  }

  expect(fs.existsSync(path.join(source, "engine"))).toBe(false);
  const retired = migrate.retiredSubtrees(source, outcome.stamp);
  expect(retired).toHaveLength(2);
  expect(fs.existsSync(path.join(retired[0].path, "projects.json"))).toBe(true);

  expect(fs.readdirSync(target).some((name) => name.startsWith(migrate.STAGING_PREFIX))).toBe(false);
  expect([...phases].sort()).toEqual(["copying", "verifying"]);
});

test("modes are carried, so a moved store does not arrive world-readable", async () => {
  await migrate.migrateStore({ source, target }, { freeSpace: roomy, checkSqlite: () => ({ ok: true }) });
  expect(fs.statSync(path.join(target, "engine", "projects.json")).mode & 0o777).toBe(0o600);
});

test("a store with no remote subtree yet moves what it has", async () => {
  fs.rmSync(path.join(source, "remote"), { recursive: true });
  const outcome = await migrate.migrateStore({ source, target }, { freeSpace: roomy, checkSqlite: () => ({ ok: true }) });
  expect(outcome.ok).toBe(true);
  expect(outcome.retired).toEqual(["engine"]);
  expect(fs.existsSync(path.join(target, "remote"))).toBe(false);
});

test("a copy that does not verify leaves the source untouched and switches nothing", async () => {
  const before = fingerprint(source);

  const outcome = await migrate.migrateStore(
    { source, target, onProgress: () => {} },
    {
      freeSpace: roomy,
      checkSqlite: () => ({ ok: true }),
      fs: new Proxy(fs, {
        get(actual, key) {
          if (key !== "promises") return actual[key];
          return new Proxy(actual.promises, {
            get(promises, call) {
              if (call !== "copyFile") return promises[call];
              return async (from, to) => {
                await promises.copyFile(from, to);
                if (to.endsWith("projects.json")) await promises.writeFile(to, "corrupted");
              };
            },
          });
        },
      }),
    },
  );

  expect(outcome.ok).toBe(false);
  expect(outcome.step).toBe("verify");
  expect(fingerprint(source)).toEqual(before);
  expect(fs.existsSync(path.join(target, "engine"))).toBe(false);
  expect(fs.existsSync(path.join(target, STAMP_NAME))).toBe(false);
});

test("a damaged database stops the move before the original is retired", async () => {
  fs.writeFileSync(path.join(source, "engine", "threads.sqlite"), "not really a database");
  const before = fingerprint(source);

  const outcome = await migrate.migrateStore(
    { source, target },
    { freeSpace: roomy, checkSqlite: () => ({ ok: false, detail: "malformed" }) },
  );

  expect(outcome.ok).toBe(false);
  expect(outcome.step).toBe("integrity");
  expect(fingerprint(source)).toEqual(before);
  expect(fs.existsSync(path.join(target, STAMP_NAME))).toBe(false);
});

test("no sqlite binding is not silently a pass, and does not block a verified copy", async () => {
  fs.writeFileSync(path.join(source, "engine", "threads.sqlite"), "whatever");
  const outcome = await migrate.migrateStore({ source, target }, { freeSpace: roomy, checkSqlite: () => ({ unavailable: true }) });

  expect(outcome.ok).toBe(true);
});

function seedWorktree(root) {
  const repository = path.join(scratch, "repo");
  fs.mkdirSync(repository, { recursive: true });
  const git = (args, cwd = repository) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repository, "file.txt"), "hello");
  git(["add", "-A"]);
  git(["commit", "-qm", "first"]);
  const worktree = path.join(root, "engine", "worktrees", "session-one");
  git(["worktree", "add", "-q", "-b", "telar/one", worktree]);
  return { repository, worktree, git };
}

test("a migrated worktree is still registered, and git can still find it", async () => {
  const { repository, worktree, git } = seedWorktree(source);
  expect(git(["worktree", "list"])).toContain(worktree);

  const outcome = await migrate.migrateStore({ source, target }, { freeSpace: roomy, checkSqlite: () => ({ ok: true }) });
  expect(outcome.ok).toBe(true);

  const moved = path.join(target, "engine", "worktrees", "session-one");
  expect(outcome.worktrees.repaired).toEqual([moved]);
  expect(outcome.worktrees.failed).toEqual([]);

  const listed = git(["worktree", "list"]);
  expect(listed).toContain(moved);
  expect(listed).not.toContain(worktree);

  git(["worktree", "prune"]);
  expect(git(["worktree", "list"])).toContain(moved);
  expect(fs.readFileSync(path.join(moved, "file.txt"), "utf8")).toBe("hello");
  void repository;
});

test("a repository that cannot be reached is reported, not silently skipped", async () => {
  const { worktree } = seedWorktree(source);

  fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /nowhere/that/exists/.git/worktrees/session-one");

  const outcome = await migrate.migrateStore({ source, target }, { freeSpace: roomy, checkSqlite: () => ({ ok: true }) });
  expect(outcome.ok).toBe(true);
  expect(outcome.worktrees.repaired).toEqual([]);
  expect(outcome.worktrees.failed).toHaveLength(1);
  expect(outcome.worktrees.failed[0].worktree).toBe(path.join(target, "engine", "worktrees", "session-one"));
});

test("a store with no worktrees at all repairs nothing and complains about nothing", () => {
  expect(migrate.repairMovedWorktrees(source)).toEqual({ repaired: [], failed: [] });
});

test("the old store cannot be removed until the new one has actually been opened", async () => {
  const moved = await migrate.migrateStore({ source, target }, { freeSpace: roomy, checkSqlite: () => ({ ok: true }) });
  const migratedAt = Number(moved.stamp);

  const tooSoon = migrate.deleteRetiredSubtrees({ source, stamp: moved.stamp, openedAt: migratedAt - 1 });
  expect(tooSoon.ok).toBe(false);
  expect(tooSoon.message).toContain("Restart first");
  expect(migrate.retiredSubtrees(source, moved.stamp)).toHaveLength(2);

  const done = migrate.deleteRetiredSubtrees({ source, stamp: moved.stamp, openedAt: migratedAt + 1 });
  expect(done.ok).toBe(true);
  expect(done.removed).toBeGreaterThan(0);
  expect(migrate.retiredSubtrees(source, moved.stamp)).toHaveLength(0);
});

test("removing twice is refused rather than pretending", async () => {
  const moved = await migrate.migrateStore({ source, target }, { freeSpace: roomy, checkSqlite: () => ({ ok: true }) });
  const openedAt = Number(moved.stamp) + 1;
  migrate.deleteRetiredSubtrees({ source, stamp: moved.stamp, openedAt });
  expect(migrate.deleteRetiredSubtrees({ source, stamp: moved.stamp, openedAt }).ok).toBe(false);
});

test("NO failure at any step leaves the source changed", async () => {
  const failures = {
    "no room": { freeSpace: () => 1 },
    "target unreadable": { freeSpace: roomy, target: path.join(scratch, "does-not-exist") },
    "copy throws": {
      freeSpace: roomy,
      fs: new Proxy(fs, {
        get(actual, key) {
          if (key !== "promises") return actual[key];
          return new Proxy(actual.promises, {
            get(promises, call) {
              if (call !== "copyFile") return promises[call];
              return async () => {
                throw new Error("the drive went away");
              };
            },
          });
        },
      }),
    },
    "integrity fails": { freeSpace: roomy, checkSqlite: () => ({ ok: false, detail: "malformed" }) },
  };

  for (const [name, bundle] of Object.entries(failures)) {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    seedStore(source);
    fs.writeFileSync(path.join(source, "engine", "threads.sqlite"), "database");
    const before = fingerprint(source);

    const { target: overridden, ...deps } = bundle;
    const outcome = await migrate.migrateStore({ source, target: overridden ?? target }, { checkSqlite: () => ({ ok: true }), ...deps });

    expect(`${name}: ${outcome.ok}`).toBe(`${name}: false`);
    expect(fingerprint(source)).toEqual(before);

    if (!overridden) expect(fs.existsSync(path.join(target, STAMP_NAME))).toBe(false);
  }
});
