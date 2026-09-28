"use strict";

const crypto = require("node:crypto");
const fsDefault = require("node:fs");
const path = require("node:path");

const { STORE_SUBTREES, STAMP_NAME, readStamp, writeStamp } = require("./store-location");

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

    freeSpace: deps.freeSpace ?? defaultFreeSpace,

    checkSqlite: deps.checkSqlite ?? defaultCheckSqlite,
  };
}

function defaultFreeSpace(target, fs = fsDefault) {
  try {
    const stats = fs.statfsSync(target);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

function defaultCheckSqlite(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
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
    }
  }
}

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

function preflight(input, deps = {}) {
  const { fs, freeSpace } = resolveDeps(deps);
  const source = input.source;
  const target = input.target;

  if (!path.isAbsolute(target)) return refuse("target", "Choose a folder by its full path.");
  if (path.resolve(source) === path.resolve(target)) return refuse("target", "That is where the store already is.");

  if (contains(source, target)) return refuse("target", "That folder is inside the current store. Choose one outside it.");
  if (contains(target, source)) return refuse("target", "The current store is inside that folder. Choose a different one.");

  let present;
  try {
    present = fs.readdirSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return refuse("target", "That folder does not exist.");
    return refuse("target", "That folder cannot be read.");
  }

  for (const subtree of [...STORE_SUBTREES, STAMP_NAME]) {
    if (present.includes(subtree)) return refuse("target", "There is already a Telar store in that folder.");
  }
  const leftover = present.find((name) => name.startsWith(STAGING_PREFIX));
  if (leftover) {
    return refuse("target", "An interrupted move left files in that folder. Remove them, or choose another folder, and try again.");
  }

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

    const damage = checkSqliteHealth(staging, deps);
    if (damage) return { ok: false, step: "integrity", message: damage, staging };

    await fsyncTree(staging, deps);

    for (const subtree of checked.present) {
      await fs.promises.rename(path.join(staging, subtree), path.join(target, subtree));
    }
    writeStamp(target, { storeId: checked.storeId, createdAt: now() }, deps);
    await fs.promises.rm(staging, { recursive: true, force: true });

    const worktrees = repairMovedWorktrees(target, deps);

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

    const stats = await fs.promises.stat(source);
    await fs.promises.chmod(path.join(to, file), stats.mode & 0o7777);
    options.onBytes?.(stats.size);
  }
}

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
  } finally {
    await handle?.close();
  }
}

function repairMovedWorktrees(storeRoot, deps = {}) {
  const { fs, git } = { ...resolveDeps(deps), git: deps.git ?? defaultGit };
  const root = path.join(storeRoot, "engine", "worktrees");
  const repaired = [];
  const failed = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
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

    git(repository, ["worktree", "lock", "--reason", lockReason(worktree, fs), worktree]);
  }
  return { repaired, failed };
}

function lockReason(worktree, fs) {
  const session =
    "A Telar session is working in this worktree. Telar removes it when that session is archived or deleted — until then, removing it destroys work that is not finished.";
  return onRemovableVolume(worktree, fs)
    ? `${session} It also sits on a removable volume; unmounting that is not a deletion.`
    : session;
}

function repositoryOf(worktree, fs) {
  let pointer;
  try {
    pointer = fs.readFileSync(path.join(worktree, ".git"), "utf8").trim();
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (!match) return undefined;

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

      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error?.status ?? 1, stdout: "", stderr: error?.stderr ? String(error.stderr) : String(error?.message ?? error) };
  }
}

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
