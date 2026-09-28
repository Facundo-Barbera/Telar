"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const LOGIN_GRANTS_VERSION = 1;
const LOGIN_GRANTS_FILE = "browser-login-grants.json";

const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 15;
const LOCK_ATTEMPTS = 400;

async function withFileLock(lockPath, run) {
  let held = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      held = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }
      if (age > STALE_LOCK_MS) {
        try { fs.rmdirSync(lockPath); } catch {  }
        continue;
      }
      await delay(LOCK_WAIT_MS);
    }
  }
  if (!held) throw new Error("Could not take the browser login grant lock.");
  try {
    return run();
  } finally {
    try { fs.rmdirSync(lockPath); } catch {  }
  }
}

function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parse(raw) {
  if (!raw || typeof raw !== "object") return [];
  if (raw.version !== LOGIN_GRANTS_VERSION || !Array.isArray(raw.grants)) return [];
  const grants = [];
  for (const entry of raw.grants) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    const profileId = typeof entry.profileId === "string" ? entry.profileId : "";
    const origin = typeof entry.origin === "string" ? exactOrigin(entry.origin) : null;
    const itemId = typeof entry.itemId === "string" ? entry.itemId : "";
    const itemTitle = typeof entry.itemTitle === "string" ? entry.itemTitle : "";
    const fields = [];
    for (const field of Array.isArray(entry.fields) ? entry.fields : []) {
      const kind = field && field.kind;
      if (kind !== "username" && kind !== "password" && kind !== "otp" && kind !== "field") continue;
      if (kind === "field" && typeof field.label !== "string") continue;
      fields.push({ kind, ...(typeof field.label === "string" ? { label: field.label } : {}) });
    }
    if (!id || !profileId || !origin || !itemId || fields.length === 0) continue;
    grants.push({
      id,
      profileId,
      ...(typeof entry.profileLabel === "string" ? { profileLabel: entry.profileLabel } : {}),
      origin,
      itemId,
      itemTitle: itemTitle || itemId,
      ...(typeof entry.vault === "string" ? { vault: entry.vault } : {}),
      fields,
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
      ...(typeof entry.lastUsedAt === "number" ? { lastUsedAt: entry.lastUsedAt } : {}),
    });
  }
  return grants;
}

async function rememberLoginGrant(stateRoot, input, { now = Date.now, mintId = () => `lg_${crypto.randomBytes(8).toString("hex")}` } = {}) {
  const origin = exactOrigin(input && input.origin);
  if (!origin) throw new Error("A remembered login needs an exact http(s) origin.");
  if (!input.profileId) throw new Error("A remembered login needs the browser profile it applies to.");
  if (!input.itemId) throw new Error("A remembered login needs the 1Password item the human picked.");
  if (!Array.isArray(input.fields) || !input.fields.length) throw new Error("A remembered login needs the fields the human approved.");
  const file = path.join(stateRoot, LOGIN_GRANTS_FILE);
  fs.mkdirSync(stateRoot, { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    let existing = [];
    try {
      existing = parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`[telar-desktop] ignoring an unreadable browser login grant file: ${error.message}`);
    }
    const grant = { ...input, origin, id: mintId(), createdAt: now() };
    const kept = existing.filter(
      (candidate) => !(candidate.profileId === grant.profileId && candidate.origin === grant.origin && candidate.itemId === grant.itemId),
    );
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: LOGIN_GRANTS_VERSION, grants: [...kept, grant] }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {  }
    return grant;
  });
}

module.exports = { rememberLoginGrant, exactOrigin, LOGIN_GRANTS_FILE, LOGIN_GRANTS_VERSION };
