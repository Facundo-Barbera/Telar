const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE_NAME = "browser-site-permissions.json";
const STORE_VERSION = 1;

const PERMISSION_KINDS = ["camera", "microphone", "notifications", "geolocation", "clipboard-read", "display-capture"];

const GRANTED_WITHOUT_ASKING = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write"]);

const PROMPT_TIMEOUT_MS = 60_000;

const KIND_WORDS = {
  camera: "camera",
  microphone: "microphone",
  notifications: "notifications",
  geolocation: "location",
  "clipboard-read": "clipboard",
  "display-capture": "screen",
};

const DEVICE_MEDIA = { camera: "camera", microphone: "microphone" };

function originOf(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

function kindsFor(permission, details = {}) {
  if (permission === "media") {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];

    const wants = types.length ? types : ["audio", "video"];
    const kinds = [];
    if (wants.includes("video")) kinds.push("camera");
    if (wants.includes("audio")) kinds.push("microphone");
    return kinds.length ? kinds : null;
  }
  if (permission === "notifications") return ["notifications"];
  if (permission === "geolocation") return ["geolocation"];
  if (permission === "clipboard-read") return ["clipboard-read"];
  if (permission === "display-capture") return ["display-capture"];
  return null;
}

function describeKinds(kinds) {
  const words = kinds.map((kind) => KIND_WORDS[kind] ?? kind);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function systemSettingsSentence(kind, status) {
  const pane = kind === "camera" ? "Camera" : "Microphone";
  if (status === "restricted") {
    return `macOS will not let Telar use the ${KIND_WORDS[kind]} on this Mac — a profile or Screen Time restriction is blocking it (System Settings ▸ Privacy & Security ▸ ${pane}).`;
  }
  return `macOS is blocking Telar's ${KIND_WORDS[kind]}. Turn Telar on in System Settings ▸ Privacy & Security ▸ ${pane}, then reload the page.`;
}

function cleanDecision(value) {
  return value === "allow" || value === "block" ? value : null;
}

class SitePermissionStore {
  constructor(userDataDir, { fsImpl = fs, now = Date.now } = {}) {
    this.userDataDir = userDataDir || null;
    this.fs = fsImpl;
    this.now = now;
    this.file = this.userDataDir ? path.join(this.userDataDir, FILE_NAME) : null;
    this.document = this.read();
  }

  read() {
    if (!this.file) return blankDocument();
    let parsed;
    try {
      parsed = JSON.parse(this.fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") return blankDocument();

      console.error(`[telar-desktop] ignoring unreadable site permissions: ${error && error.message ? error.message : error}`);
      return blankDocument();
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

  get(partition, origin, kind) {
    const record = this.document.partitions[partition]?.[origin]?.[kind];
    return record ? record.decision : null;
  }

  remember(partition, origin, kind, decision) {
    const chosen = cleanDecision(decision);
    if (!chosen) throw new Error(`A site permission is "allow" or "block" (got ${JSON.stringify(String(decision))}).`);
    if (!PERMISSION_KINDS.includes(kind)) throw new Error(`Unknown site permission ${JSON.stringify(String(kind))}.`);
    if (!originOf(origin)) throw new Error(`A site permission needs an http(s) origin (got ${JSON.stringify(String(origin))}).`);
    const partitions = (this.document.partitions[partition] ||= {});
    const origins = (partitions[origin] ||= {});
    origins[kind] = { decision: chosen, at: this.now() };
    this.save();
    return { partition, origin, kind, ...origins[kind] };
  }

  forget(partition, origin, kind) {
    const origins = this.document.partitions[partition];
    if (!origins || !origins[origin]) return false;
    if (kind === undefined) delete origins[origin];
    else if (origins[origin][kind]) delete origins[origin][kind];
    else return false;
    if (origins[origin] && !Object.keys(origins[origin]).length) delete origins[origin];
    if (!Object.keys(origins).length) delete this.document.partitions[partition];
    this.save();
    return true;
  }

  listOrigin(partition, origin) {
    const kinds = this.document.partitions[partition]?.[origin] ?? {};
    return PERMISSION_KINDS.filter((kind) => kinds[kind]).map((kind) => ({ kind, ...kinds[kind] }));
  }

  list(partition) {
    const origins = this.document.partitions[partition] ?? {};
    return Object.keys(origins)
      .sort()
      .map((origin) => ({ origin, kinds: this.listOrigin(partition, origin) }))
      .filter((entry) => entry.kinds.length);
  }

  all() {
    return Object.keys(this.document.partitions)
      .sort()
      .map((partition) => ({ partition, origins: this.list(partition) }))
      .filter((entry) => entry.origins.length);
  }
}

function blankDocument() {
  return { version: STORE_VERSION, partitions: {} };
}

function normalizeDocument(parsed) {
  const document = blankDocument();
  if (!parsed || typeof parsed !== "object") return document;
  const partitions = parsed.partitions && typeof parsed.partitions === "object" ? parsed.partitions : {};
  for (const [partition, origins] of Object.entries(partitions)) {
    if (!partition || typeof partition !== "string" || !origins || typeof origins !== "object") continue;
    for (const [origin, kinds] of Object.entries(origins)) {
      if (!originOf(origin) || !kinds || typeof kinds !== "object") continue;
      for (const [kind, record] of Object.entries(kinds)) {
        if (!PERMISSION_KINDS.includes(kind) || !record || typeof record !== "object") continue;
        const decision = cleanDecision(record.decision);
        if (!decision) continue;
        const at = Number.isFinite(record.at) ? record.at : 0;
        ((document.partitions[partition] ||= {})[origin] ||= {})[kind] = { decision, at };
      }
    }
  }
  return document;
}

function createSitePermissionStore(userDataDir, dependencies) {
  return new SitePermissionStore(userDataDir, dependencies);
}

class PermissionPrompts {
  constructor({ deliver = null, timeoutMs = PROMPT_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, mintId = null, now = Date.now } = {}) {
    this.deliver = deliver;
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.mintId = mintId || (() => `perm_${crypto.randomBytes(8).toString("hex")}`);
    this.pendingById = new Map();
  }

  open({ scopeKey = null, tabId = null, webContentsId = null, partition = null, origin, kinds, sources = null } = {}) {
    const record = {
      requestId: this.mintId(),
      scopeKey,
      tabId,
      webContentsId,
      partition,
      origin,
      kinds: [...kinds],
      askedAt: this.now(),
      ...(sources ? { sources } : {}),
    };
    return new Promise((resolve) => {
      const settle = (answer) => {
        const entry = this.pendingById.get(record.requestId);
        if (!entry) return;
        this.pendingById.delete(record.requestId);
        this.clearTimer(entry.timer);
        resolve(answer);
      };
      const timer = this.setTimer(() => settle({ decision: "block", timedOut: true }), this.timeoutMs);
      this.pendingById.set(record.requestId, { record, settle, timer });

      try {
        this.deliver?.(record);
      } catch {
      }
    });
  }

  answer(requestId, { decision, sourceId } = {}) {
    const entry = this.pendingById.get(String(requestId || ""));
    if (!entry) return false;
    const chosen = decision === "allow" || decision === "once" || decision === "block" ? decision : "block";
    entry.settle({ decision: chosen, ...(sourceId ? { sourceId: String(sourceId) } : {}) });
    return true;
  }

  cancel(requestId) {
    return this.answer(requestId, { decision: "block" });
  }

  cancelWhere(match) {
    let cancelled = 0;
    for (const [requestId, entry] of [...this.pendingById]) {
      if (!match(entry.record)) continue;
      this.cancel(requestId);
      cancelled += 1;
    }
    return cancelled;
  }

  pending(scopeKey) {
    const records = [...this.pendingById.values()].map((entry) => entry.record);
    return scopeKey === undefined ? records : records.filter((record) => record.scopeKey === scopeKey);
  }

  dispose() {
    for (const requestId of [...this.pendingById.keys()]) this.cancel(requestId);
  }
}

function systemMediaConsent({ platform = process.platform, electron = null } = {}) {
  const load = () => {
    if (electron) return electron;
    try {
      return require("electron").systemPreferences;
    } catch {
      return null;
    }
  };
  return {
    async ask(kind) {
      if (platform !== "darwin") return true;
      const systemPreferences = load();
      if (!systemPreferences || typeof systemPreferences.askForMediaAccess !== "function") return true;
      try {
        return Boolean(await systemPreferences.askForMediaAccess(DEVICE_MEDIA[kind]));
      } catch {
        return false;
      }
    },
    status(kind) {
      if (platform !== "darwin") return "granted";
      const systemPreferences = load();
      if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== "function") return "granted";
      try {
        return systemPreferences.getMediaAccessStatus(DEVICE_MEDIA[kind]);
      } catch {
        return "unknown";
      }
    },
  };
}

function desktopCaptureSources({ electron = null, thumbnailSize = { width: 320, height: 200 } } = {}) {
  return async () => {
    const capturer = electron || (() => {
      try {
        return require("electron").desktopCapturer;
      } catch {
        return null;
      }
    })();
    if (!capturer || typeof capturer.getSources !== "function") return [];
    const sources = await capturer.getSources({ types: ["screen", "window"], thumbnailSize, fetchWindowIcons: false });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: String(source.id).startsWith("screen:") ? "screen" : "window",
      thumbnail: typeof source.thumbnail?.toDataURL === "function" ? source.thumbnail.toDataURL() : null,
      handle: source,
    }));
  };
}

function createPermissionHandlers({
  partition,
  store,
  prompts,
  media = systemMediaConsent(),
  sources = null,
  locate = () => ({}),
  onDenied = null,
} = {}) {
  if (!partition) throw new Error("Site permission handlers need the partition they answer for.");
  if (!store) throw new Error("Site permission handlers need a store.");
  if (!prompts) throw new Error("Site permission handlers need somewhere to ask.");

  const onceGrants = new Map();

  const onceOf = (id, origin, kind) => {
    const held = onceGrants.get(id);
    return held && held.origin === origin && held.kinds.has(kind) ? "allow" : null;
  };

  const rememberOnce = (webContents, origin, kinds) => {
    const id = webContents?.id;
    if (id === undefined || id === null) return;
    const held = onceGrants.get(id);
    const entry = held && held.origin === origin ? held : { origin, kinds: new Set() };
    for (const kind of kinds) entry.kinds.add(kind);
    onceGrants.set(id, entry);
    if (entry !== held && typeof webContents.once === "function") {
      webContents.once("destroyed", () => onceGrants.delete(id));
      if (typeof webContents.on === "function") {
        webContents.on("did-navigate", (_event, url) => {
          if (originOf(url) !== onceGrants.get(id)?.origin) onceGrants.delete(id);
        });
      }
    }
  };

  const standing = (webContents, origin, kinds) =>
    kinds.map((kind) => store.get(partition, origin, kind) ?? onceOf(webContents?.id, origin, kind));

  const resolve = async (webContents, origin, kinds, where) => {
    const answers = standing(webContents, origin, kinds);
    let decision;
    if (answers.includes("block")) decision = "block";
    else if (answers.every((answer) => answer === "allow")) decision = "allow";
    else {
      const asked = await prompts.open({ ...where, partition, origin, kinds });
      decision = asked.decision;

      if (decision === "allow" || decision === "block") {
        for (const kind of kinds) store.remember(partition, origin, kind, decision);
      } else {
        rememberOnce(webContents, origin, kinds);
      }
    }
    if (decision === "block") return { granted: false };
    for (const kind of kinds) {
      if (!DEVICE_MEDIA[kind]) continue;
      // eslint-disable-next-line no-await-in-loop -- the OS dialog is modal; two at once is not a thing
      if (await media.ask(kind)) continue;
      return { granted: false, reason: systemSettingsSentence(kind, media.status(kind)) };
    }
    return { granted: true };
  };

  const deny = (callback, context) => {
    if (context?.reason && onDenied) {
      try {
        onDenied(context);
      } catch {
      }
    }
    callback(false);
  };

  const request = async (webContents, permission, callback, details = {}) => {
    try {
      if (GRANTED_WITHOUT_ASKING.has(permission)) return callback(true);
      const kinds = kindsFor(permission, details);
      if (!kinds) return callback(false);
      const origin = originOf(details.requestingUrl || details.securityOrigin || webContents?.getURL?.());
      if (!origin) return callback(false);
      const outcome = await resolve(webContents, origin, kinds, { ...locate(webContents), webContentsId: webContents?.id ?? null });
      if (!outcome.granted) return deny(callback, { origin, kinds, ...outcome });
      callback(true);
    } catch (error) {
      console.error(`[telar-desktop] site permission request failed: ${error && error.message ? error.message : error}`);
      try {
        callback(false);
      } catch {
      }
    }
  };

  const check = (webContents, permission, requestingOrigin, details = {}) => {
    if (GRANTED_WITHOUT_ASKING.has(permission)) return true;
    const kinds = kindsFor(permission, details);
    if (!kinds) return false;
    const origin = originOf(requestingOrigin || details.requestingUrl || webContents?.getURL?.());
    if (!origin) return false;
    return standing(webContents, origin, kinds).every((answer) => answer === "allow");
  };

  const device = () => false;

  const displayMedia = async (request_, callback) => {
    const answerNothing = () => callback({});
    try {
      const origin = originOf(request_?.securityOrigin || request_?.frame?.url);
      if (!origin) return answerNothing();
      if (store.get(partition, origin, "display-capture") === "block") return answerNothing();
      const listed = sources ? await sources() : [];
      if (!listed.length) return answerNothing();
      const frame = request_?.frame ?? null;
      const asked = await prompts.open({
        ...locate(frame),
        partition,
        origin,
        kinds: ["display-capture"],

        sources: listed.map(({ handle, ...source }) => source),
      });
      if (asked.decision === "block") {
        store.remember(partition, origin, "display-capture", "block");
        return answerNothing();
      }
      const chosen = listed.find((source) => source.id === asked.sourceId);

      if (!chosen) return answerNothing();
      if (asked.decision === "allow") store.remember(partition, origin, "display-capture", "allow");
      callback({ video: chosen.handle });
    } catch (error) {
      console.error(`[telar-desktop] screen share request failed: ${error && error.message ? error.message : error}`);
      try {
        answerNothing();
      } catch {
      }
    }
  };

  const install = (ses) => {
    ses.setPermissionRequestHandler(request);
    ses.setPermissionCheckHandler(check);
    ses.setDevicePermissionHandler(device);
    if (typeof ses.setDisplayMediaRequestHandler === "function") ses.setDisplayMediaRequestHandler(displayMedia);
    return handlers;
  };

  const handlers = { request, check, device, displayMedia, install, partition };
  return handlers;
}

function installSitePermissions(ses, options) {
  return createPermissionHandlers(options).install(ses);
}

module.exports = {
  SitePermissionStore,
  createSitePermissionStore,
  PermissionPrompts,
  createPermissionHandlers,
  installSitePermissions,
  systemMediaConsent,
  desktopCaptureSources,
  originOf,
  kindsFor,
  describeKinds,
  systemSettingsSentence,
  PERMISSION_KINDS,
  PROMPT_TIMEOUT_MS,
  FILE_NAME,
};
