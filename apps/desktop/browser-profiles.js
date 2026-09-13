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
 *   3. the GLOBAL DEFAULT                           — where every project with
 *      no assignment and no history of its own browses.
 *
 * THERE IS ALWAYS A DEFAULT, AND NOTHING IS MINTED PER PROJECT. A registry with
 * no default makes one called "Default" the moment it is opened (`ensureDefault`),
 * so the ladder has a last rung that is a real, nameable, listable identity. It
 * used to end by minting a fresh jar per project instead, which meant a person
 * with four projects had four unnamed identities they never asked for and had to
 * sign in to one at a time.
 *
 * RUNG 3 WRITES NOTHING. A project that lands on the default stays UNASSIGNED, so
 * changing the default moves it — that is what "one default" means. A project
 * pinned by rung 1 or rung 2 keeps its identity regardless.
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
/**
 * THE MARKS A PERSON PUTS ON A PROFILE — a lucide icon id and one of eight
 * identity hues, so a list of identities can be told apart at a glance and the
 * panel can show ONE glyph where the full name does not fit.
 *
 * THE COLOURS ARE CLOSED HERE; THE ICONS ARE CHECKED BY SHAPE. The eight token
 * names are the whole vocabulary (`IDENTITY_COLORS` in
 * `packages/engine-client/src/icons.ts`, the same `--subject-*` hues the Spool
 * paints with), so a typo is a refusal rather than a colourless dot. The icon set
 * lives in that same file and is FORTY names today — restating it in this process
 * would be a second list to keep in step, and the cost of not restating it is
 * only that a record could name a glyph this build cannot draw, which every
 * renderer already handles by falling back. What IS enforced is that the value is
 * a lucide-shaped id and not prose, an emoji, or a URL.
 */
const PROFILE_COLORS = ["plum", "sea", "moss", "amber", "slate", "rose", "sky", "sand"];
const ICON_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_ICON = 48;
/**
 * THE ONLY NAME THIS FILE INVENTS. Every other profile is named by the person who
 * created it — the create form requires a name, and there is no generator behind
 * it. An adopted pre-profile jar is the one exception the data forces
 * (`adoptedLabelFor`): a record has to be called something, and losing the jar
 * would lose a login.
 */
const DEFAULT_PROFILE_LABEL = "Default";

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

/**
 * A mark, cleaned, or undefined for "cleared". `null`/`""` mean the person took
 * the mark off — an ordinary, expressible state — while a value that is not a
 * mark at all is a refusal, named, rather than a silently dropped field.
 */
function cleanIcon(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const icon = String(value).trim().toLowerCase();
  if (!ICON_ID.test(icon) || icon.length > MAX_ICON) {
    throw new Error(`A browser profile icon must be a lucide icon id like "globe" (got ${JSON.stringify(String(value))}).`);
  }
  return icon;
}

function cleanColor(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const color = String(value).trim().toLowerCase();
  if (!PROFILE_COLORS.includes(color)) {
    throw new Error(`A browser profile colour must be one of ${PROFILE_COLORS.join(", ")} (got ${JSON.stringify(String(value))}).`);
  }
  return color;
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
    this.ensureDefault();
  }

  /**
   * FIRST RUN MAKES ONE PROFILE CALLED "Default" AND MARKS IT DEFAULT.
   *
   * Called on every open, not only on a blank file, because an install that
   * upgraded from the per-project era has profile records but no default at all —
   * its adopted jars stay assigned to the projects that own them (see the ladder),
   * and this is where the identity everything ELSE joins comes from.
   *
   * Nothing existing is touched: a registry that already names a default returns
   * without a write.
   */
  ensureDefault() {
    if (this.document.defaultProfileId) return this.get(this.document.defaultProfileId);
    return this.create({ label: DEFAULT_PROFILE_LABEL });
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
  create({ label, account, icon, color, partition, internal = false } = {}) {
    const record = {
      id: this.mintId(),
      label: cleanLabel(label),
      createdAt: this.now(),
    };
    const chosenAccount = cleanLabel(account, { field: "account", max: MAX_ACCOUNT, required: false });
    if (chosenAccount) record.account = chosenAccount;
    const chosenIcon = cleanIcon(icon);
    if (chosenIcon) record.icon = chosenIcon;
    const chosenColor = cleanColor(color);
    if (chosenColor) record.color = chosenColor;
    // `partition` is internal (migration adopts an existing jar); a caller from
    // the UI never passes one.
    record.partition = partition || `persist:telar-profile-${record.id}`;
    this.document.profiles[record.id] = record;
    /**
     * A JAR THE LADDER ADOPTED IS NEVER THE DEFAULT. Only a profile a PERSON
     * created — or the "Default" one `ensureDefault` makes — may become the
     * global default: one project's migrated cookie jar becoming the default
     * would hand every later project that project's logins, the exact leak
     * profiles exist to prevent.
     */
    if (!internal && !this.document.defaultProfileId) this.document.defaultProfileId = record.id;
    this.save();
    return this.get(record.id);
  }

  /**
   * Rename, state the account this profile is meant to be signed into, or set
   * the marks it wears. THE ACCOUNT IS INTENT, NOT PROOF: nothing here verifies
   * a login.
   *
   * EVERY FIELD IS PATCHED, NOT REPLACED — an absent key leaves what is stored
   * alone, and only an explicit `null` (or empty string) takes a mark off. A
   * caller changing a colour must not have to resend the icon to keep it.
   */
  update(profileId, patch = {}) {
    const record = this.document.profiles[this.require(profileId).id];
    if (patch.label !== undefined) record.label = cleanLabel(patch.label);
    if (patch.account !== undefined) {
      const account = cleanLabel(patch.account, { field: "account", max: MAX_ACCOUNT, required: false });
      if (account) record.account = account;
      else delete record.account;
    }
    if (patch.icon !== undefined) {
      const icon = cleanIcon(patch.icon);
      if (icon) record.icon = icon;
      else delete record.icon;
    }
    if (patch.color !== undefined) {
      const color = cleanColor(patch.color);
      if (color) record.color = color;
      else delete record.color;
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

  /**
   * FORGET A PROFILE. Allowed only when nothing points at it: a profile some
   * project is assigned to is that project's identity, and a profile that is the
   * global default is where every unassigned project browses.
   *
   * THE COOKIE JAR IS NOT DELETED. Like every other operation here this moves
   * metadata only — the partition directory stays exactly where it is, so a
   * record removed by mistake costs a re-creation, never a login. (That is also
   * why deleting is not offered for a profile in use: the jar would survive with
   * nothing left naming it.)
   */
  remove(profileId) {
    const record = this.require(profileId);
    if (record.id === this.document.defaultProfileId) {
      throw new Error(`“${record.label}” is the default profile. Make another profile the default first.`);
    }
    const used = this.projectsOf(record.id);
    if (used.length) {
      throw new Error(
        `“${record.label}” is used by ${used.length} project${used.length === 1 ? "" : "s"}. Point ${used.length === 1 ? "it" : "them"} at another profile first.`,
      );
    }
    delete this.document.profiles[record.id];
    this.save();
    return { id: record.id, label: record.label };
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
   * THE LADDER. Returns the profile a project key belongs in, adopting a
   * pre-profile jar when it finds one. Assignments and migrations are persisted,
   * so the answer is stable across restarts.
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
      const adopted = this.create({ label: this.adoptedLabelFor(legacy), partition: legacy, internal: true });
      this.document.projects[key] = adopted.id;
      this.migrations.push({ from: key, to: adopted.id });
      this.save();
      return this.get(adopted.id);
    }

    // 3. The default, for every project with no assignment and no history.
    // Deliberately NOT written down as an assignment: see the header.
    return this.require(this.ensureDefault().id);
  }

  /**
   * What to call a jar that existed before profiles did.
   *
   * THE LAST AUTO-NAME, AND IT NAMES WHAT IT IS rather than which project it came
   * from — a label like "Project 6f6f07" told the reader nothing they could act
   * on, which is why it is gone. The counter only breaks a tie between two
   * adopted jars; renaming one in Settings is the expected next step.
   */
  adoptedLabelFor(partition) {
    const base = partition === LEGACY_PARTITION ? "Original browser" : "Earlier sign-ins";
    const taken = new Set(Object.values(this.document.profiles).map((profile) => profile.label));
    if (!taken.has(base)) return base;
    for (let suffix = 2; ; suffix += 1) if (!taken.has(`${base} ${suffix}`)) return `${base} ${suffix}`;
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
    /**
     * A MARK THE FILE CANNOT JUSTIFY IS DROPPED, NOT THROWN. Reading is the one
     * place a refusal would cost something real — a hand-edited colour would
     * make the whole registry unopenable, and with it every login in it. A
     * profile missing its icon is a profile you re-mark in Settings.
     */
    const icon = typeof raw.icon === "string" ? raw.icon.trim().toLowerCase() : "";
    if (icon && ICON_ID.test(icon) && icon.length <= MAX_ICON) record.icon = icon;
    const color = typeof raw.color === "string" ? raw.color.trim().toLowerCase() : "";
    if (PROFILE_COLORS.includes(color)) record.color = color;
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
  DEFAULT_PROFILE_LABEL,
  PROFILE_COLORS,
};
