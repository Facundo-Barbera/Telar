"use strict";

const fsDefault = require("node:fs").promises;
const path = require("node:path");

const { STORE_SUBTREES } = require("./store-location");

const SIZE_DEADLINE_MS = 3000;

function retiredPath(root, subtree, stamp) {
  return path.join(root, `${subtree}.migrated-${stamp}`);
}

async function treeBytes(root, fs, expired) {
  let bytes = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (expired()) return undefined;
    const next = path.join(root, entry.name);
    const size = entry.isDirectory() ? await treeBytes(next, fs, expired) : entry.isFile() ? (await fs.stat(next)).size : 0;
    if (size === undefined) return undefined;
    bytes += size;
  }
  return bytes;
}

async function exists(target, fs) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function retiredSubtrees(source, stamp, deps = {}) {
  const fs = deps.fs ?? fsDefault;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.deadlineMs ?? SIZE_DEADLINE_MS);
  const expired = () => now() > deadline;
  const found = [];
  for (const subtree of STORE_SUBTREES) {
    const retired = retiredPath(source, subtree, stamp);
    if (!(await exists(retired, fs))) continue;
    found.push({ path: retired, bytes: expired() ? undefined : await treeBytes(retired, fs, expired) });
  }
  return found;
}

function totalBytes(found) {
  return found.some((entry) => entry.bytes === undefined) ? undefined : found.reduce((total, entry) => total + entry.bytes, 0);
}

async function deleteRetiredSubtrees(input, deps = {}) {
  const fs = deps.fs ?? fsDefault;
  const migratedAt = Number(input.stamp);
  if (!Number.isFinite(migratedAt)) return { ok: false, message: "That is not a move this install recorded." };
  if (!(input.openedAt > migratedAt)) {
    return { ok: false, message: "Telar has not opened the moved store yet. Restart first, then remove the old one." };
  }
  const found = await retiredSubtrees(input.source, input.stamp, deps);
  if (found.length === 0) return { ok: false, message: "There is nothing left to remove." };
  for (const entry of found) await fs.rm(entry.path, { recursive: true, force: true });
  return { ok: true, removed: totalBytes(found) };
}

module.exports = { retiredSubtrees, deleteRetiredSubtrees, totalBytes };
