"use strict";

const fsDefault = require("node:fs");
const path = require("node:path");

const { STORE_SUBTREES } = require("./store-location");

function retiredPath(root, subtree, stamp) {
  return path.join(root, `${subtree}.migrated-${stamp}`);
}

function treeBytes(root, fs) {
  let bytes = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const next = path.join(root, entry.name);
    if (entry.isDirectory()) bytes += treeBytes(next, fs);
    else if (entry.isFile()) bytes += fs.statSync(next).size;
  }
  return bytes;
}

function retiredSubtrees(source, stamp, deps = {}) {
  const fs = deps.fs ?? fsDefault;
  const found = [];
  for (const subtree of STORE_SUBTREES) {
    const retired = retiredPath(source, subtree, stamp);
    if (!fs.existsSync(retired)) continue;
    found.push({ path: retired, bytes: treeBytes(retired, fs) });
  }
  return found;
}

function deleteRetiredSubtrees(input, deps = {}) {
  const fs = deps.fs ?? fsDefault;
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

module.exports = { retiredSubtrees, deleteRetiredSubtrees };
