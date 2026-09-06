/**
 * BROWSER PROFILES — one Chromium partition (cookies, storage, service
 * workers, extension storage) PER PROJECT. Sessions of one project share a
 * profile; two projects never do. A login in one project cannot leak to
 * another, which is what "the same Google account showed up in two
 * projects" was.
 *
 * THE PROFILE KEY IS DECLARED, NOT INFERRED, AND MISSING IS REFUSED. Every
 * scope (a session) must be bound to a profile before its first tab: the
 * engine binds it from the claim's project id before a turn's browser tools
 * run, and the cockpit binds it from the session record before it shows the
 * panel. A scope nobody bound gets NO tab — a missing project id is exactly
 * the case that recreated the leak, so it fails closed rather than landing in
 * a shared default. A session that genuinely has no project is declared so
 * explicitly with the key `none` and gets its own clean partition.
 *
 * THE LEGACY PARTITION IS KEPT, NOT CLONED. `persist:telar-integrated-browser`
 * holds whatever was signed in before profiles existed. It stays on disk,
 * and it is used ONLY by the one project the person explicitly names as its
 * owner in `<userData>/browser-profiles.json`:
 *
 *   { "legacyOwnerProjectId": "project_…" }
 *
 * Nothing assigns it automatically — not the first project opened, not the
 * most recent — and no project id is written into product code.
 */
const fs = require("node:fs");
const path = require("node:path");

const LEGACY_PARTITION = "persist:telar-integrated-browser";
/** The explicit "this session has no project" key. Deliberate, never implied. */
const PROJECTLESS_PROFILE_KEY = "none";
const PROJECT_ID = /^project_[a-f0-9]{32}$/;

function partitionFor(profileKey, mapping) {
  const key = String(profileKey || "").trim();
  if (!key) throw new Error("A browser profile key is required.");
  if (mapping && mapping.legacyOwnerProjectId && key === mapping.legacyOwnerProjectId) return LEGACY_PARTITION;
  if (key === PROJECTLESS_PROFILE_KEY) return "persist:telar-profile-none";
  if (!PROJECT_ID.test(key)) throw new Error(`Browser profile key must be a project id or "${PROJECTLESS_PROFILE_KEY}" (got ${JSON.stringify(key)}).`);
  return `persist:telar-project-${key.slice("project_".length)}`;
}

function readMapping(userDataDir) {
  const file = path.join(userDataDir, "browser-profiles.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const owner = typeof parsed.legacyOwnerProjectId === "string" ? parsed.legacyOwnerProjectId.trim() : "";
    if (owner && !PROJECT_ID.test(owner)) throw new Error(`browser-profiles.json: legacyOwnerProjectId must be a project id (got ${JSON.stringify(owner)})`);
    return { legacyOwnerProjectId: owner || null, file };
  } catch (error) {
    if (error && error.code === "ENOENT") return { legacyOwnerProjectId: null, file };
    throw error;
  }
}

/** Write the one-time owner mapping. Refuses to overwrite a different owner
 *  unless `force` — reassigning the legacy login is a deliberate act. */
function writeMapping(userDataDir, legacyOwnerProjectId, { force = false } = {}) {
  if (!PROJECT_ID.test(String(legacyOwnerProjectId))) throw new Error("legacyOwnerProjectId must be a project id.");
  const current = readMapping(userDataDir);
  if (current.legacyOwnerProjectId && current.legacyOwnerProjectId !== legacyOwnerProjectId && !force) {
    throw new Error(`The legacy browser profile is already owned by ${current.legacyOwnerProjectId}; pass force to reassign.`);
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(current.file, JSON.stringify({ legacyOwnerProjectId }, null, 2));
  return readMapping(userDataDir);
}

module.exports = { partitionFor, readMapping, writeMapping, LEGACY_PARTITION, PROJECTLESS_PROFILE_KEY, PROJECT_ID };
