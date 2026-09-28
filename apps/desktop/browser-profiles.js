const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LEGACY_PARTITION = "persist:telar-integrated-browser";

const PROJECTLESS_PROFILE_KEY = "none";
const PROJECT_ID = /^project_[a-f0-9]{32}$/;
const PROFILE_ID = /^bp_[a-f0-9]{16}$/;
const FILE_NAME = "browser-profiles.json";
const REGISTRY_VERSION = 2;
const MAX_LABEL = 64;
const MAX_ACCOUNT = 160;

const PROFILE_COLORS = ["plum", "sea", "moss", "amber", "slate", "rose", "sky", "sand"];
const ICON_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_ICON = 48;

const DEFAULT_PROFILE_LABEL = "Default";

function requireProjectKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("A browser profile key is required.");
  if (key !== PROJECTLESS_PROFILE_KEY && !PROJECT_ID.test(key)) {
    throw new Error(`Browser profile key must be a project id or "${PROJECTLESS_PROFILE_KEY}" (got ${JSON.stringify(key)}).`);
  }
  return key;
}

function legacyPartitionFor(profileKey, mapping) {
  const key = requireProjectKey(profileKey);
  if (mapping && mapping.legacyOwnerProjectId && key === mapping.legacyOwnerProjectId) return LEGACY_PARTITION;
  if (key === PROJECTLESS_PROFILE_KEY) return "persist:telar-profile-none";
  return `persist:telar-project-${key.slice("project_".length)}`;
}

const partitionFor = legacyPartitionFor;

function cleanLabel(value, { field = "label", max = MAX_LABEL, required = true } = {}) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) {
    if (required) throw new Error(`A browser profile ${field} is required.`);
    return undefined;
  }
  return text.slice(0, max);
}

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

function partitionDirectory(userDataDir, partition) {
  return path.join(userDataDir, "Partitions", partition.replace(/^persist:/, ""));
}

class ProfileRegistry {
  constructor(userDataDir, dependencies = {}) {
    this.userDataDir = userDataDir;
    this.fs = dependencies.fsImpl || fs;
    this.now = dependencies.now || Date.now;
    this.randomId = dependencies.randomId || (() => `bp_${crypto.randomBytes(8).toString("hex")}`);
    this.partitionExists =
      dependencies.partitionExists ||
      ((partition) => Boolean(this.userDataDir) && this.fs.existsSync(partitionDirectory(this.userDataDir, partition)));

    this.file = userDataDir ? path.join(userDataDir, FILE_NAME) : null;

    this.migrations = [];
    this.document = this.read();
    this.ensureDefault();
  }

  ensureDefault() {
    if (this.document.defaultProfileId) return this.get(this.document.defaultProfileId);
    return this.create({ label: DEFAULT_PROFILE_LABEL });
  }

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

  get legacyOwnerProjectId() {
    return this.document.legacyOwnerProjectId;
  }

  get defaultProfileId() {
    return this.document.defaultProfileId;
  }

  list() {
    return Object.values(this.document.profiles)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((profile) => ({ ...profile, isDefault: profile.id === this.document.defaultProfileId }));
  }

  get(profileId) {
    const id = String(profileId || "").trim();
    return this.document.profiles[id] ? { ...this.document.profiles[id], isDefault: id === this.document.defaultProfileId } : null;
  }

  require(profileId) {
    const found = this.get(profileId);
    if (!found) throw new Error(`No browser profile ${JSON.stringify(String(profileId || ""))} exists. Pick one in the browser panel.`);
    return found;
  }

  assignmentOf(projectKey) {
    return this.document.projects[requireProjectKey(projectKey)] || null;
  }

  projectsOf(profileId) {
    return Object.entries(this.document.projects)
      .filter(([, id]) => id === profileId)
      .map(([key]) => key);
  }

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

    record.partition = partition || `persist:telar-profile-${record.id}`;
    this.document.profiles[record.id] = record;

    if (!internal && !this.document.defaultProfileId) this.document.defaultProfileId = record.id;
    this.save();
    return this.get(record.id);
  }

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

  setDefault(profileId) {
    this.document.defaultProfileId = this.require(profileId).id;
    this.save();
    return this.get(this.document.defaultProfileId);
  }

  remove(profileId) {
    const record = this.require(profileId);
    if (record.id === this.document.defaultProfileId) {
      throw new Error(`“${record.label}” is the default profile. Make another profile the default first.`);
    }
    const moved = this.projectsOf(record.id);
    for (const key of moved) delete this.document.projects[key];
    delete this.document.profiles[record.id];
    this.save();
    return { id: record.id, label: record.label, projects: moved };
  }

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

  resolve(projectKey) {
    const key = requireProjectKey(projectKey);
    const assigned = this.document.projects[key];
    if (assigned) return this.require(assigned);

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

    return this.require(this.ensureDefault().id);
  }

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

    const icon = typeof raw.icon === "string" ? raw.icon.trim().toLowerCase() : "";
    if (icon && ICON_ID.test(icon) && icon.length <= MAX_ICON) record.icon = icon;
    const color = typeof raw.color === "string" ? raw.color.trim().toLowerCase() : "";
    if (PROFILE_COLORS.includes(color)) record.color = color;
    document.profiles[id] = record;
  }
  const projects = parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {};
  for (const [key, value] of Object.entries(projects)) {
    if (typeof value !== "string" || !document.profiles[value]) continue;
    if (key !== PROJECTLESS_PROFILE_KEY && !PROJECT_ID.test(key)) continue;
    document.projects[key] = value;
  }
  const fallback = typeof parsed.defaultProfileId === "string" ? parsed.defaultProfileId.trim() : "";
  document.defaultProfileId = document.profiles[fallback] ? fallback : null;
  return document;
}

function readProfileRegistry(userDataDir, dependencies) {
  return new ProfileRegistry(userDataDir, dependencies);
}

function readMapping(userDataDir, dependencies = {}) {
  const registry = new ProfileRegistry(userDataDir, dependencies);
  return { legacyOwnerProjectId: registry.legacyOwnerProjectId, file: registry.file };
}

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
