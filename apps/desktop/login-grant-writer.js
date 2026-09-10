/**
 * The shell's writer for remembered login authorizations — a mirror of the
 * engine's `LoginGrantStore.remember` (apps/engine/src/secrets/login-grants.ts)
 * over the same file: same schema, same lock protocol, same replace rule.
 *
 * Why a mirror and not a daemon route: the daemon authenticates with a bearer
 * token local agents can read, so an HTTP "create a grant" route would let an
 * agent authorize itself. The write therefore happens only in the Electron
 * main process, downstream of a click inside the sender-validated offer window
 * (login-offer-window.js) — a surface no agent-reachable API drives. Listing
 * and revoking stay on the daemon (`/v2/browser/logins`).
 *
 * Why async where the engine is sync: this runs on Electron's main thread,
 * where the engine's `Atomics.wait` lock loop (worst case ~6 s under
 * contention) would freeze every window. Same mkdir-lock protocol, same
 * timings — the waiting just yields the event loop. Schema, constants and
 * contention behaviour are pinned against the real engine store in
 * login-grant-writer.test.js.
 */
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const LOGIN_GRANTS_VERSION = 1;
const LOGIN_GRANTS_FILE = "browser-login-grants.json";

// The engine's lock protocol: mkdir is the atomic primitive, a dead holder's
// lock is broken after STALE_LOCK_MS, and giving up takes ~6 s of contention.
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
        continue; // released between the mkdir and the stat
      }
      if (age > STALE_LOCK_MS) {
        try { fs.rmdirSync(lockPath); } catch { /* someone else broke it first */ }
        continue;
      }
      await delay(LOCK_WAIT_MS);
    }
  }
  if (!held) throw new Error("Could not take the browser login grant lock.");
  try {
    return run();
  } finally {
    try { fs.rmdirSync(lockPath); } catch { /* already broken as stale */ }
  }
}

/** An origin string is only usable if it IS an origin: scheme + host, http(s). */
function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The engine's parse, rule for rule: a malformed entry is dropped, a `field`
 *  kind with no label is dropped whole, an unknown version is an empty list. */
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

/**
 * Persist one grant a human just confirmed, with the engine's `remember`
 * semantics: read-modify-write under the cross-process lock, one grant per
 * (profile, origin, item) — re-approving replaces — atomic rename, mode 0600.
 * Resolves to the stored grant.
 */
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
      // An unreadable file authorizes nothing, and never resurrects — same
      // posture as the engine's read().
      if (error.code !== "ENOENT") console.error(`[telar-desktop] ignoring an unreadable browser login grant file: ${error.message}`);
    }
    const grant = { ...input, origin, id: mintId(), createdAt: now() };
    const kept = existing.filter(
      (candidate) => !(candidate.profileId === grant.profileId && candidate.origin === grant.origin && candidate.itemId === grant.itemId),
    );
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: LOGIN_GRANTS_VERSION, grants: [...kept, grant] }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* a filesystem without modes */ }
    return grant;
  });
}

module.exports = { rememberLoginGrant, exactOrigin, LOGIN_GRANTS_FILE, LOGIN_GRANTS_VERSION };
