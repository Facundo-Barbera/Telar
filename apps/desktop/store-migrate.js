"use strict";

/**
 * MOVING THE STORE, WITHOUT EVER BEING ABLE TO LOSE IT — issue #630.
 *
 * ONE RULE, AND EVERY ORDERING DECISION BELOW FOLLOWS FROM IT: **the source is
 * never touched by the operation that creates the copy.** A migration that
 * deleted its source and left a half-written store is the worst bug this
 * feature can have, because a person's conversations are not reproducible. So
 * copying, switching and removing are three separate acts, in that order, and
 * the last one is not even in this run — see `deleteRetiredSubtrees`.
 *
 * ══ WHAT IS ACTUALLY MOVED, and why it is a list rather than a directory ══
 *
 * At the default location the store root IS Electron's userData, which also
 * holds `Cache/`, `Local Storage/` and this install's own preferences. "Move
 * the store" can therefore never mean "move the directory". It means moving the
 * subtrees the store owns — `engine/` and `remote/` (`store-location.js`) —
 * which is also why a migration onto a drive does not drag a Chromium cache
 * along with it. Retiring the source is subtree-wise for the same reason:
 * renaming userData itself would take the whole app with it.
 *
 * ══ STAGING LIVES INSIDE THE TARGET, and that is not an aesthetic choice ══
 *
 * The final step has to be a rename, because a rename is the only way to make
 * "the store is now here" happen at one instant rather than over several
 * seconds. A rename is atomic only WITHIN a filesystem. Staging beside the
 * target — `<target>.incoming-x` — would put it on the target's PARENT, which
 * for a target at a volume root is `/Volumes`: a different filesystem, an
 * unwritable one, and a cross-device rename that fails at the very end after
 * the whole copy has been paid for. So staging is `<target>/.telar-incoming-…`.
 *
 * ══ WHAT PROVES THE COPY, AND WHAT DOES NOT ══
 *
 * The copy is proven by CONTENT HASHES READ BACK OFF THE TARGET. Hashing the
 * bytes on their way out of the writer proves only that the writer had them; it
 * says nothing about what reached the disk. So every file is read back and
 * digested, and compared against a digest taken from the source.
 *
 * `PRAGMA integrity_check` is run too, but it is worth being exact about what
 * it establishes: once the target is byte-identical to the source, a check on
 * the target is a check on the SOURCE. It is kept because discovering that the
 * store was already damaged is worth knowing BEFORE the original is retired —
 * but it is not what verifies the copy. The hashes are.
 *
 * ══ AND WHY A CRASH HERE COSTS NOTHING ══
 *
 * The marker is written at exactly one point, after everything else has been
 * proven, and it alone decides which store Telar opens. Before that write,
 * every intermediate state — a half-filled staging directory, subtrees moved
 * but unstamped — leaves the source intact and untouched and the marker still
 * naming it. Which is why an interrupted migration REFUSES to resume rather
 * than trying to be clever: nothing has been lost, so a confused resume is the
 * only way left to lose something.
 */

const crypto = require("node:crypto");
const fsDefault = require("node:fs");
const path = require("node:path");

const { STORE_SUBTREES, STAMP_NAME, readStamp, writeStamp } = require("./store-location");

/** Enough headroom that a target which exactly fits is refused. Filesystems
 *  need room for metadata, and a store is written to the moment it opens. */
const FREE_SPACE_MARGIN = 1.05;

const STAGING_PREFIX = ".telar-incoming-";
const RETIRED_INFIX = ".migrated-";

function stagingPath(target, stamp) {
  return path.join(target, `${STAGING_PREFIX}${stamp}`);
}

function retiredPath(root, subtree, stamp) {
  return path.join(root, `${subtree}${RETIRED_INFIX}${stamp}`);
}

function resolveDeps(deps = {}) {
  return {
    fs: deps.fs ?? fsDefault,
    now: deps.now ?? (() => Date.now()),
    // Injected so a test can present a full disk without filling one.
    freeSpace: deps.freeSpace ?? defaultFreeSpace,
    // Injected because `node:sqlite` is a runtime detail of whoever is hosting
    // this, and because a test should be able to exercise a damaged store.
    checkSqlite: deps.checkSqlite ?? defaultCheckSqlite,
  };
}

function defaultFreeSpace(target, fs = fsDefault) {
  try {
    const stats = fs.statfsSync(target);
    return stats.bavail * stats.bsize;
  } catch {
    // Unknown is not "plenty". A preflight that cannot measure says so and the
    // caller decides; it does not wave the copy through.
    return undefined;
  }
}

/**
 * `ok` from `PRAGMA integrity_check`, or the complaint.
 *
 * Opened READ-ONLY, which matters: this runs against the SOURCE, which is the
 * store the person still has, and a verification step that could write to it
 * would be the one thing this module promises not to do.
 */
function defaultCheckSqlite(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    // No sqlite binding in this host. The hashes still prove the copy; this
    // check is about the source's health, so its absence is reported rather
    // than treated as a pass.
    return { unavailable: true };
  }
  let database;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const rows = database.prepare("PRAGMA integrity_check").all();
    const answer = rows.length === 1 ? String(Object.values(rows[0])[0]) : rows.map((row) => String(Object.values(row)[0])).join("; ");
    return answer === "ok" ? { ok: true } : { ok: false, detail: answer };
  } catch (error) {
    return { ok: false, detail: error && error.message ? error.message : String(error) };
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a database that failed to open.
    }
  }
}

// --- Walking ----------------------------------------------------------------

/**
 * Every regular file under `root`, as paths relative to it, plus a byte total.
 *
 * SYMLINKS ARE REFUSED RATHER THAN FOLLOWED OR COPIED. A store containing one
 * is not a shape this understands, and the two ways to guess — copy the link
 * and have it point somewhere that will not exist, or follow it and silently
 * inline somebody else's directory — are both worse than saying so.
 */
function walkTree(root, deps = {}) {
  const { fs } = resolveDeps(deps);
  const files = [];
  const directories = [];
  let bytes = 0;
  const walk = (relative) => {
    const absolute = relative === "" ? root : path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const next = relative === "" ? entry.name : path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`the store contains a symbolic link (${next}); this cannot be moved safely`);
      if (entry.isDirectory()) {
        directories.push(next);
        walk(next);
        continue;
      }
      if (!entry.isFile()) throw new Error(`the store contains something that is not a file or a directory (${next})`);
      files.push(next);
      bytes += fs.statSync(path.join(root, next)).size;
    }
  };
  walk("");
  return { files, directories, bytes };
}

/** A file's sha-256, streamed so a multi-gigabyte store does not need memory. */
async function digest(file, onBytes, deps = {}) {
  const { fs } = resolveDeps(deps);
  const hash = crypto.createHash("sha256");
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      onBytes?.(bytesRead);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

// --- Preflight --------------------------------------------------------------

/**
 * Everything that can be known to be wrong BEFORE a byte is copied.
 *
 * A failure is a value, as in `apps/engine/src/clone.ts`: each arm is a
 * sentence somebody reads under the folder they just chose.
 */
function preflight(input, deps = {}) {
  const { fs, freeSpace } = resolveDeps(deps);
  const source = input.source;
  const target = input.target;

  if (!path.isAbsolute(target)) return refuse("target", "Choose a folder by its full path.");
  if (path.resolve(source) === path.resolve(target)) return refuse("target", "That is where the store already is.");
  // A target inside the source would have the copy copying itself; a source
  // inside the target would be retired out from under the thing that now holds
  // it. Neither is recoverable by being clever about ordering.
  if (contains(source, target)) return refuse("target", "That folder is inside the current store. Choose one outside it.");
  if (contains(target, source)) return refuse("target", "The current store is inside that folder. Choose a different one.");

  let present;
  try {
    present = fs.readdirSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return refuse("target", "That folder does not exist.");
    return refuse("target", "That folder cannot be read.");
  }

  /**
   * A TARGET THAT ALREADY HOLDS A STORE, OR THE WRECKAGE OF AN INTERRUPTED
   * MOVE, IS REFUSED — never resumed and never written over. The source is
   * intact in both cases, so nothing has been lost yet; a resume that guessed
   * wrong is the only remaining way to lose it.
   */
  for (const subtree of [...STORE_SUBTREES, STAMP_NAME]) {
    if (present.includes(subtree)) return refuse("target", "There is already a Telar store in that folder.");
  }
  const leftover = present.find((name) => name.startsWith(STAGING_PREFIX));
  if (leftover) {
    return refuse("target", "An interrupted move left files in that folder. Remove them, or choose another folder, and try again.");
  }

  // Writable is proven, not inferred. A permission bit is not a promise, and
  // network shares and read-only mounts both answer one cheerfully.
  const probe = path.join(target, `${STAGING_PREFIX}probe-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(probe, "telar");
    if (fs.readFileSync(probe, "utf8") !== "telar") return refuse("target", "That folder cannot be written to.");
  } catch {
    return refuse("target", "That folder cannot be written to.");
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // Best effort; the probe is a few bytes.
    }
  }

  const stamp = readStamp(source, deps);
  if (!stamp) return refuse("source", "Telar cannot find its own store to move.");

  let measured;
  try {
    measured = measure(source, deps);
  } catch (error) {
    return refuse("source", error && error.message ? error.message : String(error));
  }

  const available = freeSpace(target, fs);
  if (available === undefined) return refuse("space", "Telar could not work out how much room that disk has.");
  const needed = Math.ceil(measured.bytes * FREE_SPACE_MARGIN);
  if (available < needed) {
    return refuse("space", `That disk has ${format(available)} free and the store needs about ${format(needed)}.`);
  }

  return { ok: true, storeId: stamp.storeId, bytes: measured.bytes, files: measured.files, present: measured.present };
}

function refuse(step, message) {
  return { ok: false, step, message };
}

/** The store's own subtrees, skipping any this install has never created. */
function measure(source, deps = {}) {
  const { fs } = resolveDeps(deps);
  let bytes = 0;
  let files = 0;
  const present = [];
  for (const subtree of STORE_SUBTREES) {
    const from = path.join(source, subtree);
    if (!fs.existsSync(from)) continue;
    const walked = walkTree(from, deps);
    bytes += walked.bytes;
    files += walked.files.length;
    present.push(subtree);
  }
  return { bytes, files, present };
}

function contains(root, candidate) {
  const from = path.resolve(root);
  const to = path.resolve(candidate);
  return to === from || to.startsWith(from.endsWith(path.sep) ? from : `${from}${path.sep}`);
}

function format(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// --- The move ---------------------------------------------------------------

/**
 * Copy, verify, switch — and stop.
 *
 * Returns the retirement stamp on success, which is the handle the separate,
 * later deletion is performed with. Nothing here deletes anything.
 *
 * `onProgress` is called with `{ phase, bytesDone, bytesTotal }`. There are two
 * byte-paying phases, `copying` and `verifying`, and they are reported
 * separately rather than averaged, because a progress bar that stalls at 100%
 * while a verification nobody was told about runs is how a person learns to
 * pull the drive out.
 */
async function migrateStore(input, deps = {}) {
  const { fs, now } = resolveDeps(deps);
  const source = input.source;
  const target = input.target;
  const onProgress = input.onProgress ?? (() => {});

  const checked = preflight({ source, target }, deps);
  if (!checked.ok) return checked;

  const stamp = String(now());
  const staging = stagingPath(target, stamp);

  try {
    // 1. COPY, into staging, never onto a name the next launch would read.
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    let copied = 0;
    for (const subtree of checked.present) {
      await copyTree(path.join(source, subtree), path.join(staging, subtree), {
        onBytes: (n) => {
          copied += n;
          onProgress({ phase: "copying", bytesDone: copied, bytesTotal: checked.bytes });
        },
        deps,
      });
    }

    // 2. VERIFY, by reading the target back. See the header for why hashing
    //    what we wrote would not have been a verification.
    let verified = 0;
    for (const subtree of checked.present) {
      const failure = await verifyTree(path.join(source, subtree), path.join(staging, subtree), {
        onBytes: (n) => {
          verified += n;
          onProgress({ phase: "verifying", bytesDone: verified, bytesTotal: checked.bytes * 2 });
        },
        deps,
      });
      if (failure) return { ok: false, step: "verify", message: failure, staging };
    }

    // 3. THE SOURCE'S OWN HEALTH, reported before the original is retired. A
    //    byte-identical copy of a damaged database is a faithful copy, and the
    //    moment to learn that is now rather than after the original is gone.
    const damage = checkSqliteHealth(staging, deps);
    if (damage) return { ok: false, step: "integrity", message: damage, staging };

    // 4. DURABLE BEFORE IT IS BELIEVED. Without this, "verified" means
    //    "verified in the page cache" — and the engine fsyncs nothing at steady
    //    state, so this is the one moment the whole store's durability is
    //    bought explicitly.
    await fsyncTree(staging, deps);

    // 5. SWITCH. Each rename is atomic within this filesystem. A crash between
    //    them leaves the target unstamped, which is not a store — and the
    //    marker still names the source.
    for (const subtree of checked.present) {
      await fs.promises.rename(path.join(staging, subtree), path.join(target, subtree));
    }
    writeStamp(target, { storeId: checked.storeId, createdAt: now() }, deps);
    await fs.promises.rm(staging, { recursive: true, force: true });

    /**
     * 5a. AND TELL EVERY REPOSITORY WHERE ITS WORKTREES WENT. A copied worktree
     * is not a moved one: the repository still points at the old path, which
     * step 6 is about to rename away, and git would then read that as a
     * deletion. Done BEFORE the source is retired, so both paths still exist
     * and `repair` cannot be confused about which is which.
     */
    const worktrees = repairMovedWorktrees(target, deps);

    // 6. RETIRE THE SOURCE — renamed, not removed. The caller writes the marker
    //    once this returns; deleting what is retired is a separate act the
    //    person takes later, gated on having opened the new store.
    for (const subtree of checked.present) {
      await fs.promises.rename(path.join(source, subtree), retiredPath(source, subtree, stamp));
    }

    return { ok: true, stamp, storeId: checked.storeId, bytes: checked.bytes, retired: checked.present, worktrees };
  } catch (error) {
    return {
      ok: false,
      step: "copy",
      message: "The move did not finish. Your store has not been changed.",
      detail: error && error.message ? error.message : String(error),
      staging,
    };
  }
}

async function copyTree(from, to, options) {
  const { fs } = resolveDeps(options.deps);
  const walked = walkTree(from, options.deps);
  await fs.promises.mkdir(to, { recursive: true, mode: 0o700 });
  for (const directory of walked.directories) {
    await fs.promises.mkdir(path.join(to, directory), { recursive: true, mode: 0o700 });
  }
  for (const file of walked.files) {
    const source = path.join(from, file);
    await fs.promises.copyFile(source, path.join(to, file));
    // Modes carried deliberately: the engine writes 0o600 documents and 0o700
    // directories, and a store that arrived world-readable would be a quiet
    // downgrade nobody asked for.
    const stats = await fs.promises.stat(source);
    await fs.promises.chmod(path.join(to, file), stats.mode & 0o7777);
    options.onBytes?.(stats.size);
  }
}

/**
 * Nothing missing, nothing extra, every file identical. Returns a sentence when
 * it is not, and nothing when it is.
 *
 * BOTH DIRECTIONS. A manifest compared one way catches a file that did not
 * arrive and misses a file that should not have; the second is rarer and just
 * as much a sign that this did not do what it thinks it did.
 */
async function verifyTree(from, to, options) {
  const sourceTree = walkTree(from, options.deps);
  const targetTree = walkTree(to, options.deps);

  const missing = sourceTree.files.filter((file) => !targetTree.files.includes(file));
  if (missing.length > 0) return `${missing.length} file(s) did not copy, including ${missing[0]}.`;
  const extra = targetTree.files.filter((file) => !sourceTree.files.includes(file));
  if (extra.length > 0) return `the copy has ${extra.length} file(s) the store does not, including ${extra[0]}.`;

  for (const file of sourceTree.files) {
    const sourceDigest = await digest(path.join(from, file), options.onBytes, options.deps);
    const targetDigest = await digest(path.join(to, file), options.onBytes, options.deps);
    if (sourceDigest !== targetDigest) return `${file} did not copy correctly.`;
  }
  return undefined;
}

/** Every `*.sqlite` in the copy, checked read-only. See the header for exactly
 *  what this establishes and what it does not. */
function checkSqliteHealth(root, deps = {}) {
  const { fs, checkSqlite } = resolveDeps(deps);
  for (const subtree of STORE_SUBTREES) {
    const from = path.join(root, subtree);
    if (!fs.existsSync(from)) continue;
    for (const file of walkTree(from, deps).files) {
      if (!file.endsWith(".sqlite")) continue;
      const answer = checkSqlite(path.join(from, file));
      if (answer.unavailable) continue;
      if (!answer.ok) return `${path.join(subtree, file)} is damaged (${answer.detail}). Nothing has been changed.`;
    }
  }
  return undefined;
}

/**
 * Flush the copied tree, directories included.
 *
 * THE DIRECTORIES MATTER AS MUCH AS THE FILES: a file whose contents reached
 * the platter is still lost if the directory entry naming it did not.
 */
async function fsyncTree(root, deps = {}) {
  const { fs } = resolveDeps(deps);
  const walked = walkTree(root, deps);
  for (const file of walked.files) await fsyncPath(path.join(root, file), "r", fs);
  for (const directory of [...walked.directories].reverse()) await fsyncPath(path.join(root, directory), "r", fs);
  await fsyncPath(root, "r", fs);
}

async function fsyncPath(target, flags, fs) {
  let handle;
  try {
    handle = await fs.promises.open(target, flags);
    await handle.sync();
  } catch {
    // A filesystem that will not fsync a directory (some network mounts) is not
    // a reason to fail a verified copy — it is a reason not to claim more
    // durability than was obtained, which the user-facing wording already does.
  } finally {
    await handle?.close();
  }
}

// --- Git worktrees, which do not move by being copied ------------------------

/**
 * RE-POINT EVERY REPOSITORY AT THE WORKTREES THAT JUST MOVED — issue #630.
 *
 * THE TWO POINTERS ARE NOT SYMMETRIC, and that asymmetry is why copying a store
 * is not enough:
 *
 *   <worktree>/.git                      -> <repo>/.git/worktrees/<name>
 *   <repo>/.git/worktrees/<name>/gitdir  -> <worktree>/.git
 *
 * Copying the store rewrites neither. The first still resolves, because the
 * REPOSITORY did not move. The second names a path that the migration is about
 * to rename away — so git concludes the worktree was deleted, and the next
 * `git worktree prune` anywhere deletes the registration. The work is still on
 * disk; git's record of whose it is, is not.
 *
 * NO PROJECT REGISTRY IS NEEDED TO FIX IT. The worktree's own `.git` file names
 * its repository, so each moved directory carries everything required to repair
 * itself. That is what keeps this in the shell, where the migration happens,
 * rather than requiring the engine — which does not exist yet at this point.
 *
 * AND A WORKTREE THAT LANDED ON A REMOVABLE VOLUME IS LOCKED. Git's own
 * documentation asks for this on a portable device: a locked worktree is
 * ignored by `prune` however long its directory has been missing, so unmounting
 * the drive stops being indistinguishable from deleting the work.
 *
 * BEST-EFFORT, AND REPORTED RATHER THAN FATAL. A repository that is itself on
 * an absent disk cannot be repaired now and must not fail a verified migration;
 * it is named in the answer so the failure is visible instead of silent.
 */
function repairMovedWorktrees(storeRoot, deps = {}) {
  const { fs, git } = { ...resolveDeps(deps), git: deps.git ?? defaultGit };
  const root = path.join(storeRoot, "engine", "worktrees");
  const repaired = [];
  const failed = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // A store with no worktrees yet. Nothing to repair is the common case on a
    // fresh install and is not worth reporting as anything.
    return { repaired, failed };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktree = path.join(root, entry.name);
    const repository = repositoryOf(worktree, fs);
    if (!repository) {
      failed.push({ worktree, reason: "this worktree does not say which repository it belongs to" });
      continue;
    }
    const result = git(repository, ["worktree", "repair", worktree]);
    if (result.status !== 0) {
      failed.push({ worktree, reason: result.stderr.trim() || "git could not repair it" });
      continue;
    }
    repaired.push(worktree);
    // RE-LOCKED UNCONDITIONALLY — issue #641. `worktree repair` leaves the lock
    // alone, but a worktree that arrived here from an older store never had one:
    // #630 locked only the removable-volume case, and the risk the lock actually
    // answers is `gh pr merge --delete-branch` running `git worktree remove` on
    // whichever worktree holds the merged branch — which has nothing to do with
    // which disk it is on. A migration that left them unlocked would be the one
    // way a store move quietly reopens the hole. Never fatal, for the reason
    // below.
    //
    // Never fatal: the lock protects a LATER removal, and a migration that
    // copied and verified everything must not be failed by it.
    git(repository, ["worktree", "lock", "--reason", lockReason(worktree, fs), worktree]);
  }
  return { repaired, failed };
}

/**
 * The lock's reason, in the words a person meets it in — `git worktree list`,
 * or gh's refusal to remove it. The engine spells the same two sentences in
 * `worktree.ts`'s `worktreeLockReason`; this file imports nothing from it for
 * the reason the header gives, so the wording is duplicated on purpose and the
 * two are meant to be changed together.
 */
function lockReason(worktree, fs) {
  const session =
    "A Telar session is working in this worktree. Telar removes it when that session is archived or deleted — until then, removing it destroys work that is not finished.";
  return onRemovableVolume(worktree, fs)
    ? `${session} It also sits on a removable volume; unmounting that is not a deletion.`
    : session;
}

/** The repository a worktree belongs to, out of its own `.git` file. */
function repositoryOf(worktree, fs) {
  let pointer;
  try {
    pointer = fs.readFileSync(path.join(worktree, ".git"), "utf8").trim();
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (!match) return undefined;
  // `<repo>/.git/worktrees/<name>` — the repository is three levels up, and
  // anything else is a shape this does not understand rather than one to guess.
  const admin = match[1].trim();
  const worktreesDir = path.dirname(admin);
  const gitDir = path.dirname(worktreesDir);
  if (path.basename(worktreesDir) !== "worktrees" || path.basename(gitDir) !== ".git") return undefined;
  const repository = path.dirname(gitDir);
  return fs.existsSync(repository) ? repository : undefined;
}

function onRemovableVolume(target, fs) {
  const roots = process.platform === "darwin" ? ["/Volumes"] : process.platform === "linux" ? ["/media", "/mnt"] : [];
  for (const root of roots) {
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!target.startsWith(prefix)) continue;
    const [name] = target.slice(prefix.length).split(path.sep);
    if (!name) continue;
    try {
      return fs.statSync(path.join(root, name)).dev !== fs.statSync(root).dev;
    } catch {
      return false;
    }
  }
  return false;
}

function defaultGit(cwd, args) {
  try {
    const stdout = require("node:child_process").execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Bounded: a repository on a disk that is itself away must not hold the
      // launch this runs inside.
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error?.status ?? 1, stdout: "", stderr: error?.stderr ? String(error.stderr) : String(error?.message ?? error) };
  }
}

// --- Afterwards -------------------------------------------------------------

/** What a retired source still occupies, so the person deciding can see it. */
function retiredSubtrees(source, stamp, deps = {}) {
  const { fs } = resolveDeps(deps);
  const found = [];
  for (const subtree of STORE_SUBTREES) {
    const retired = retiredPath(source, subtree, stamp);
    if (!fs.existsSync(retired)) continue;
    found.push({ path: retired, bytes: walkTree(retired, deps).bytes });
  }
  return found;
}

/**
 * REMOVE THE OLD STORE. The separate, later act — and the only destructive one
 * in this file.
 *
 * GATED ON THE NEW STORE HAVING BEEN OPENED, not on the copy having matched.
 * `openedAt` is the marker's `lastOpenedAt`; requiring it to post-date the
 * migration is what makes "verified" mean "a store Telar has actually run
 * from" rather than "bytes that compared equal an hour ago".
 */
function deleteRetiredSubtrees(input, deps = {}) {
  const { fs } = resolveDeps(deps);
  const migratedAt = Number(input.stamp);
  if (!Number.isFinite(migratedAt)) return { ok: false, message: "That is not a move this install recorded." };
  if (!(input.openedAt > migratedAt)) {
    return { ok: false, message: "Telar has not opened the moved store yet. Restart first, then remove the old one." };
  }
  const found = retiredSubtrees(input.source, input.stamp, deps);
  if (found.length === 0) return { ok: false, message: "There is nothing left to remove." };
  let removed = 0;
  for (const entry of found) {
    fs.rmSync(entry.path, { recursive: true, force: true });
    removed += entry.bytes;
  }
  return { ok: true, removed };
}

module.exports = {
  FREE_SPACE_MARGIN,
  STAGING_PREFIX,
  RETIRED_INFIX,
  stagingPath,
  retiredPath,
  preflight,
  measure,
  migrateStore,
  repairMovedWorktrees,
  retiredSubtrees,
  deleteRetiredSubtrees,
  walkTree,
  format,
};
