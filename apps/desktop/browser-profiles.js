/**
 * BROWSER PROFILES — a NAMED, REUSABLE Chromium identity (cookies, storage,
 * service workers, extension storage) that one or many projects may point at.
 *
 * WHAT CHANGED, AND WHY. Profiles used to BE projects: the partition was
 * computed from the project id, so "the same login in two projects" meant
 * signing in twice, and a person with several Google identities could not say
 * which one a project belonged to. Now a profile is its own record with a
 * stable id, a label a person chose, and an OPTIONAL expected account. Projects
 * are ASSIGNED to profiles; several projects may share one; a profile nobody
 * shares is exactly as isolated as the per-project partition was.
 *
 * THE PARTITION IS STORED, NOT DERIVED, and that is the whole migration story.
 * A profile record carries the partition string it was created with, so a
 * project whose cookies live in `persist:telar-project-<id>` keeps using THAT
 * partition under its new profile record. Nothing is copied, merged, renamed or
 * deleted on disk — migration moves METADATA and leaves every cookie jar where
 * it already is.
 *
 * THE RESOLUTION LADDER for a project key (a project id, or the explicit
 * `none`), in order, and every rung is deliberate:
 *   1. an explicit ASSIGNMENT for this project      — the person said so;
 *   2. an EXISTING partition on disk for this key   — migration: the identity
 *      that project already signed into keeps working, and a global default
 *      set later never silently moves it;
 *   3. the GLOBAL DEFAULT                           — what a new project joins;
 *   4. a fresh per-project profile                  — the pre-profile behaviour,
 *      unchanged, for a machine that never set a default.
 *
 * A DANGLING REFERENCE IS AN ERROR, NEVER A GUESS. If the file names a profile
 * id that no longer exists — a hand-edited file, a record removed out of band —
 * resolution THROWS with the id in the message. Landing such a session in
 * another identity's cookie jar is the exact failure profiles exist to prevent.
 *
 * THE LEGACY PARTITION is still `persist:telar-integrated-browser`, still used
 * only by the project explicitly named `legacyOwnerProjectId`, and it becomes
 * that project's profile partition at migration.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LEGACY_PARTITION = "persist:telar-integrated-browser";
/** The explicit "this session has no project" key. Deliberate, never implied. */
const PROJECTLESS_PROFILE_KEY = "none";
const PROJECT_ID = /^project_[a-f0-9]{32}$/;
const PROFILE_ID = /^bp_[a-f0-9]{16}$/;
const FILE_NAME = "browser-profiles.json";
const REGISTRY_VERSION = 2;
const MAX_LABEL = 64;
const MAX_ACCOUNT = 160;

/** Validate a project key the engine may send: a project id, or `none`. */
function requireProjectKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("A browser profile key is required.");
  if (key !== PROJECTLESS_PROFILE_KEY && !PROJECT_ID.test(key)) {
    throw new Error(`Browser profile key must be a project id or "${PROJECTLESS_PROFILE_KEY}" (got ${JSON.stringify(key)}).`);
  }
  return key;
}

/**
 * The partition a project key used BEFORE profiles existed. Migration reads
 * this and nothing else does: it is the address of cookies already on disk.
 */
function legacyPartitionFor(profileKey, mapping) {
  const key = requireProjectKey(profileKey);
  if (mapping && mapping.legacyOwnerProjectId && key === mapping.legacyOwnerProjectId) return LEGACY_PARTITION;
  if (key === PROJECTLESS_PROFILE_KEY) return "persist:telar-profile-none";
  return `persist:telar-project-${key.slice("project_".length)}`;
}

/** Back-compat alias kept for callers that only want the pre-profile mapping. */
const partitionFor = legacyPartitionFor;

function cleanLabel(value, { field = "label", max = MAX_LABEL, required = true } = {}) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) {
    if (required) throw new Error(`A browser profile ${field} is required.`);
    return undefined;
  }
  return text.slice(0, max);
}

/** Where Electron keeps a persistent partition's data. Used ONLY to detect an
 *  identity that already exists — never written to, never removed. */
function partitionDirectory(userDataDir, partition) {
  return path.join(userDataDir, "Partitions", partition.replace(/^persist:/, ""));
}

class ProfileRegistry {
  /**
   * @param {string} userDataDir
   * @param {{ fsImpl?: typeof fs, randomId?: () => string, now?: () => number,
   *           partitionExists?: (partition: string) => boolean }} [dependencies]
   */
  constructor(userDataDir, dependencies = {}) {
    this.userDataDir = userDataDir;
    this.fs = dependencies.fsImpl || fs;
    this.now = dependencies.now || Date.now;
    this.randomId = dependencies.randomId || (() => `bp_${crypto.randomBytes(8).toString("hex")}`);
    this.partitionExists =
      dependencies.partitionExists ||
      ((partition) => Boolean(this.userDataDir) && this.fs.existsSync(partitionDirectory(this.userDataDir, partition)));
    /** `null` is an EPHEMERAL registry: nothing is read, nothing is written.
     *  What a manager built without a shell (tests, the smoke run) gets, so
     *  profile resolution still works and leaves no file behind. */
    this.file = userDataDir ? path.join(userDataDir, FILE_NAME) : null;
    /** Metadata moves recorded this session: `{from: <project key>, to: <profile id>}`.
     *  The shell replays these onto per-profile caches (recent sites) so a
     *  migrated project keeps its history. */
    this.migrations = [];
    this.document = this.read();
  }

  // ── the file ────────────────────────────────────────────────────────────

  read() {
    if (!this.file) return blankDocument();
    let parsed;
    try {
      parsed = JSON.parse(this.fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") return blankDocument();
      throw error;
    }
    return normalizeDocument(parsed);
  }

  save() {
    if (!this.file) return this.document;
    this.fs.mkdirSync(this.userDataDir, { recursive: true });
    const temporary = `${this.file}.tmp`;
    this.fs.writeFileSync(temporary, JSON.stringify(this.document, null, 2));
    this.fs.renameSync(temporary, this.file);
    return this.document;
  }

  // ── reading ─────────────────────────────────────────────────────────────

  get legacyOwnerProjectId() {
    return this.document.legacyOwnerProjectId;
  }

  get defaultProfileId() {
    return this.document.defaultProfileId;
  }

  /** Every profile, oldest first, with the default marked. */
  list() {
    return Object.values(this.document.profiles)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((profile) => ({ ...profile, isDefault: profile.id === this.document.defaultProfileId }));
  }

  get(profileId) {
    const id = String(profileId || "").trim();
    return this.document.profiles[id] ? { ...this.document.profiles[id], isDefault: id === this.document.defaultProfileId } : null;
  }

  /** The record, or a named error. Used everywhere a dangling id would
   *  otherwise become a silent fallback into someone else's cookies. */
  require(profileId) {
    const found = this.get(profileId);
    if (!found) throw new Error(`No browser profile ${JSON.stringify(String(profileId || ""))} exists. Pick one in the browser panel.`);
    return found;
  }

  /** Which profile a project is explicitly assigned to, or null. */
  assignmentOf(projectKey) {
    return this.document.projects[requireProjectKey(projectKey)] || null;
  }

  /** Which project keys point at a profile — what the UI shows before a rename
   *  and what makes "several projects, one profile" visible. */
  projectsOf(profileId) {
    return Object.entries(this.document.projects)
      .filter(([, id]) => id === profileId)
      .map(([key]) => key);
  }

  // ── writing ─────────────────────────────────────────────────────────────

  /**
   * A NEW identity: a fresh partition nothing has ever signed into. The
   * partition name is derived from the id, so two profiles can never collide
   * and a label change never moves cookies.
   */
  create({ label, account, partition, internal = false } = {}) {
    const record = {
      id: this.mintId(),
      label: cleanLabel(label),
      createdAt: this.now(),
    };
    const chosenAccount = cleanLabel(account, { field: "account", max: MAX_ACCOUNT, required: false });
    if (chosenAccount) record.account = chosenAccount;
    // `partition` is internal (migration adopts an existing jar); a caller from
    // the UI never passes one.
    record.partition = partition || `persist:telar-profile-${record.id}`;
    this.document.profiles[record.id] = record;
    /**
     * A PROFILE THE LADDER MADE IS NEVER THE DEFAULT. Only a profile a PERSON
     * created may become the first default: an adopted or auto-created
     * per-project jar becoming the global default would hand every later
     * project that project's cookies — the exact leak profiles prevent.
     */
    if (!internal && !this.document.defaultProfileId) this.document.defaultProfileId = record.id;
    this.save();
    return this.get(record.id);
  }

  /** Rename, or state the account this profile is meant to be signed into.
   *  THE ACCOUNT IS INTENT, NOT PROOF: nothing here verifies a login. */
  update(profileId, patch = {}) {
    const record = this.document.profiles[this.require(profileId).id];
    if (patch.label !== undefined) record.label = cleanLabel(patch.label);
    if (patch.account !== undefined) {
      const account = cleanLabel(patch.account, { field: "account", max: MAX_ACCOUNT, required: false });
      if (account) record.account = account;
      else delete record.account;
    }
    this.save();
    return this.get(record.id);
  }

  /** What a project with no assignment of its own and no existing cookie jar
   *  joins. Never moves a project that already has an identity — see the
   *  ladder in `resolve`. */
  setDefault(profileId) {
    this.document.defaultProfileId = this.require(profileId).id;
    this.save();
    return this.get(this.document.defaultProfileId);
  }

  /** Point a project at a profile, or (null) drop the assignment and let the
   *  ladder decide again. */
  assign(projectKey, profileId) {
    const key = requireProjectKey(projectKey);
    if (profileId === null || profileId === undefined || profileId === "") {
      delete this.document.projects[key];
      this.save();
      return null;
    }
    const record = this.require(profileId);
    this.document.projects[key] = record.id;
    this.save();
    return record;
  }

  /**
   * THE LADDER. Returns the profile a project key belongs in, creating or
   * adopting one when it has none. Assignments and migrations are persisted, so
   * the answer is stable across restarts.
   */
  resolve(projectKey) {
    const key = requireProjectKey(projectKey);
    const assigned = this.document.projects[key];
    if (assigned) return this.require(assigned);

    // 2. An identity this key already signed into, from before profiles.
    const legacy = legacyPartitionFor(key, this.document);
    const existing = Object.values(this.document.profiles).find((profile) => profile.partition === legacy);
    if (existing) {
      this.document.projects[key] = existing.id;
      this.save();
      return this.get(existing.id);
    }
    if (this.partitionExists(legacy)) {
      const adopted = this.create({ label: defaultLabelFor(key, legacy), partition: legacy, internal: true });
      this.document.projects[key] = adopted.id;
      this.migrations.push({ from: key, to: adopted.id });
      this.save();
      return this.get(adopted.id);
    }

    // 3. The global default, for a project with no history of its own.
    if (this.document.defaultProfileId) {
      const fallback = this.require(this.document.defaultProfileId);
      this.document.projects[key] = fallback.id;
      this.save();
      return fallback;
    }

    // 4. The pre-profile behaviour: this project's own clean jar.
    const created = this.create({ label: defaultLabelFor(key, legacy), partition: legacy, internal: true });
    this.document.projects[key] = created.id;
    this.save();
    return this.get(created.id);
  }

  mintId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.randomId();
      if (!PROFILE_ID.test(id)) throw new Error(`A browser profile id must look like bp_<16 hex> (got ${JSON.stringify(id)}).`);
      if (!this.document.profiles[id]) return id;
    }
    throw new Error("Could not mint a unique browser profile id.");
  }
}

function defaultLabelFor(projectKey, partition) {
  if (projectKey === PROJECTLESS_PROFILE_KEY) return "No project";
  if (partition === LEGACY_PARTITION) return "Original browser";
  return `Project ${projectKey.slice("project_".length, "project_".length + 6)}`;
}

function blankDocument() {
  return { version: REGISTRY_VERSION, defaultProfileId: null, profiles: {}, projects: {}, legacyOwnerProjectId: null };
}

/**
 * A document from disk → the shape this class works in. A v1 file is just
 * `{legacyOwnerProjectId}`; it carries forward untouched, because that field is
 * still what says which project owns the pre-profile cookie jar.
 */
function normalizeDocument(parsed) {
  const document = blankDocument();
  if (!parsed || typeof parsed !== "object") return document;
  const owner = typeof parsed.legacyOwnerProjectId === "string" ? parsed.legacyOwnerProjectId.trim() : "";
  if (owner && !PROJECT_ID.test(owner)) {
    throw new Error(`browser-profiles.json: legacyOwnerProjectId must be a project id (got ${JSON.stringify(owner)})`);
  }
  document.legacyOwnerProjectId = owner || null;
  const profiles = parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
  for (const [id, raw] of Object.entries(profiles)) {
    if (!PROFILE_ID.test(id) || !raw || typeof raw !== "object") continue;
    const label = typeof raw.label === "string" ? raw.label.trim().slice(0, MAX_LABEL) : "";
    const partition = typeof raw.partition === "string" ? raw.partition.trim() : "";
    if (!label || !partition.startsWith("persist:")) continue;
    const record = { id, label, partition, createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0 };
    if (typeof raw.account === "string" && raw.account.trim()) record.account = raw.account.trim().slice(0, MAX_ACCOUNT);
    document.profiles[id] = record;
  }
  const projects = parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {};
  for (const [key, value] of Object.entries(projects)) {
    // A key or target the registry cannot honour is dropped HERE rather than
    // throwing at resolve time — the ladder then decides again for that project.
    if (typeof value !== "string" || !document.profiles[value]) continue;
    if (key !== PROJECTLESS_PROFILE_KEY && !PROJECT_ID.test(key)) continue;
    document.projects[key] = value;
  }
  const fallback = typeof parsed.defaultProfileId === "string" ? parsed.defaultProfileId.trim() : "";
  document.defaultProfileId = document.profiles[fallback] ? fallback : null;
  return document;
}

/** Read the registry. The one construction site outside tests. */
function readProfileRegistry(userDataDir, dependencies) {
  return new ProfileRegistry(userDataDir, dependencies);
}

/** The v1 read, kept because `main.js` still validates the file at startup and
 *  a bad `legacyOwnerProjectId` must remain a loud startup error. */
function readMapping(userDataDir, dependencies = {}) {
  const registry = new ProfileRegistry(userDataDir, dependencies);
  return { legacyOwnerProjectId: registry.legacyOwnerProjectId, file: registry.file };
}

/** Write the one-time legacy owner. Refuses to overwrite a different owner
 *  unless `force` — reassigning the legacy login is a deliberate act. */
function writeMapping(userDataDir, legacyOwnerProjectId, { force = false, ...dependencies } = {}) {
  if (!PROJECT_ID.test(String(legacyOwnerProjectId))) throw new Error("legacyOwnerProjectId must be a project id.");
  const registry = new ProfileRegistry(userDataDir, dependencies);
  const current = registry.legacyOwnerProjectId;
  if (current && current !== legacyOwnerProjectId && !force) {
    throw new Error(`The legacy browser profile is already owned by ${current}; pass force to reassign.`);
  }
  registry.document.legacyOwnerProjectId = legacyOwnerProjectId;
  registry.save();
  return { legacyOwnerProjectId, file: registry.file };
}

module.exports = {
  ProfileRegistry,
  readProfileRegistry,
  partitionFor,
  legacyPartitionFor,
  requireProjectKey,
  readMapping,
  writeMapping,
  partitionDirectory,
  LEGACY_PARTITION,
  PROJECTLESS_PROFILE_KEY,
  PROJECT_ID,
  PROFILE_ID,
  REGISTRY_VERSION,
  FILE_NAME,
};
