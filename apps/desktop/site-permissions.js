/**
 * SITE PERMISSIONS — what one origin may do inside one browser profile, and the
 * memory of every answer a person has given.
 *
 * WHY THIS FILE EXISTS AT ALL. Chromium's default, with no handler installed, is
 * to DENY every permission request without asking — so camera and microphone in
 * Telar's browser were not "broken", they were never offered. A page called
 * `getUserMedia`, nothing appeared, and the page reported NotAllowedError as if
 * the human had refused something they were never shown. Three things had to be
 * true at once for that to become an ordinary browser: the packaged app has to
 * carry the macOS usage strings and device entitlements (package.json /
 * build/entitlements.mac.plist), the partition has to install handlers, and a
 * decision has to be written down somewhere. This is the third, plus the
 * handlers that read it.
 *
 * THE KEY IS THE PARTITION, NOT THE PROJECT. A decision belongs to the COOKIE
 * JAR it was made in — the same identity that holds the login the page is
 * signed into — so two projects sharing a profile share its answers and a
 * profile switch does not carry them across. (#422 wrote this as `profileKey`;
 * the partition string is what actually names a jar, and it is what a session
 * hands us.)
 *
 * "ALLOW ONCE" IS NEVER WRITTEN DOWN. It lives in memory against the asking
 * WebContents and dies with it — which is what "this time" means in a browser.
 * A reload of the same page asks again; that is the point of the middle button.
 *
 * THE OS IS A SECOND GATE AND IT IS NOT OURS. Answering "Allow" to a site is a
 * decision about the site; macOS still has to have given Telar itself the
 * camera or the microphone, and it only asks once per app. So the media path
 * calls `systemPreferences.askForMediaAccess` after the human's answer and
 * before the site's, and an OS refusal becomes a sentence naming System
 * Settings rather than a silent denial the page blames on the human.
 *
 * NOTHING HERE TOUCHES ELECTRON AT IMPORT TIME. Every port — the OS consent,
 * the source list, the timers, the filesystem — is injected, with a real
 * implementation built lazily, so the whole decision surface is testable in a
 * plain bun process with no shell.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE_NAME = "browser-site-permissions.json";
const STORE_VERSION = 1;

/**
 * THE CLOSED VOCABULARY. Everything a person can be asked about, and therefore
 * everything that can be remembered or revoked. `media` is deliberately NOT a
 * kind: Chromium asks for it as one permission carrying `mediaTypes`, but a
 * person answers about their CAMERA and their MICROPHONE separately, and a
 * grant to a video call must not silently cover the next audio-only request.
 */
const PERMISSION_KINDS = ["camera", "microphone", "notifications", "geolocation", "clipboard-read", "display-capture"];

/**
 * GRANTED WITHOUT ASKING, BECAUSE CHROMIUM IS ALREADY THE GATE. No browser
 * interrupts any of these with a modal, and each has a condition Chromium
 * enforces itself that a prompt would only duplicate. They are remembered
 * nowhere because there is nothing to remember — no row in the lock popover, no
 * line in the file, nothing to revoke.
 *
 * FULLSCREEN and POINTERLOCK need a user gesture to request and show their own
 * way out — the "press Esc to exit" overlay, the escape hatch. Granting them is
 * what makes a video player and a canvas game work the way they do everywhere.
 *
 * CLIPBOARD-SANITIZED-WRITE is what Chromium asks for when a page calls
 * `navigator.clipboard.writeText` — every "Copy" button on the web (#614). It
 * was falling into the unknown bucket below and being refused, so those buttons
 * did nothing in Telar's browser and most sites swallowed the rejection. Two
 * things measured on Electron 43 rather than assumed, because they are the
 * whole reason this is safe to grant (clipboard-write.electron-test.js):
 *
 *   - CHROMIUM'S GATE IS THE FOCUSED DOCUMENT, and it is checked BEFORE this
 *     handler is ever consulted. A page that is not focused gets
 *     `NotAllowedError: Document is not focused` whatever we answer — so what
 *     is granted here is only ever "the page the person is looking at".
 *   - THAT GATE IS THE ONLY ONE. Once granted, a focused page may write with no
 *     user gesture at all. That is exactly Chrome's own behaviour — Chrome
 *     auto-grants clipboard-write to a focused document — and it is the cost of
 *     the Copy button working: a focused page can replace the clipboard.
 *
 * WRITE IS NOT READ. `clipboard-read` is deliberately NOT here: reading what a
 * person copied somewhere else is a real question, it stays a prompt, and it
 * keeps its row in the panel.
 */
const GRANTED_WITHOUT_ASKING = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write"]);

/** A prompt nobody answers is a page left hanging. Sixty seconds, then Block —
 *  and an agent's tab is no exception (#422 item 6): it waits for the human
 *  like every other request and then fails closed. */
const PROMPT_TIMEOUT_MS = 60_000;

/** The words a prompt, a lock popover and a settings row all use. */
const KIND_WORDS = {
  camera: "camera",
  microphone: "microphone",
  notifications: "notifications",
  geolocation: "location",
  "clipboard-read": "clipboard",
  "display-capture": "screen",
};

/** What macOS calls the two device grants — the only two it gates. */
const DEVICE_MEDIA = { camera: "camera", microphone: "microphone" };

/**
 * The origin a decision is about, or null for an address no decision can be
 * scoped to. `file:` pages have origin `null` in the spec and would all share
 * one bucket; an extension page is the credential UI, which is never a site.
 */
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

/**
 * A Chromium permission (plus its details) → the kinds a person is asked about,
 * or null for "not something this browser offers".
 *
 * NULL IS A DENIAL, and that is the fail-closed half of the rule: `midi`,
 * `usb`, `serial`, `idle-detection`, `window-management` and whatever Chromium
 * adds next are refused without a prompt rather than silently granted, because
 * a permission this file has never heard of is one nobody has designed an
 * answer for.
 */
function kindsFor(permission, details = {}) {
  if (permission === "media") {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    // NO mediaTypes AT ALL means Chromium could not tell us which device the
    // page asked for. Both is the honest reading — the prompt then names both,
    // and a person who only meant to share a microphone blocks the pair — and
    // it is what keeps a real getUserMedia({audio,video}) working when the
    // detail is missing. Guessing narrower would grant something unasked.
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

/** "your camera and microphone" — the phrase a prompt puts after the origin. */
function describeKinds(kinds) {
  const words = kinds.map((kind) => KIND_WORDS[kind] ?? kind);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * WHAT TO SAY WHEN macOS IS THE ONE REFUSING. The site asked, the human said
 * yes, and the request still fails — without this sentence that reads as Telar
 * ignoring the answer. It names the exact pane, because "check your privacy
 * settings" is not an instruction anyone can follow.
 */
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

/**
 * THE REMEMBERED ANSWERS: partition → origin → kind → {decision, at}.
 *
 * Written the way the profile registry writes: a temp file renamed into place,
 * so a crash mid-write leaves the previous answers rather than half of them. A
 * store with no userDataDir is EPHEMERAL — nothing is read, nothing is written
 * — which is what a manager built without a shell (the tests, the smoke run)
 * gets, so the handlers still work and leave no file behind.
 */
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
      /**
       * AN UNREADABLE FILE COSTS THE MEMORY, NOT THE BROWSER. Throwing here
       * would make a hand-edited or truncated file a shell that cannot open a
       * page at all; what it actually costs is that every site asks again,
       * which is the same state a new install is in.
       */
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

  /** "allow", "block", or null for "nobody has said". */
  get(partition, origin, kind) {
    const record = this.document.partitions[partition]?.[origin]?.[kind];
    return record ? record.decision : null;
  }

  /** Write one answer. "Allow once" never reaches here — see the header. */
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

  /**
   * Forget one kind, or (with no kind) everything this origin holds — the
   * lock popover's Reset. Removing the last kind removes the origin, and the
   * last origin removes the partition, so the file never accumulates the
   * skeletons of decisions nobody has.
   */
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

  /** What one origin holds in one partition, for the lock popover. */
  listOrigin(partition, origin) {
    const kinds = this.document.partitions[partition]?.[origin] ?? {};
    return PERMISSION_KINDS.filter((kind) => kinds[kind]).map((kind) => ({ kind, ...kinds[kind] }));
  }

  /** Every remembered decision in one partition, newest origin first. */
  list(partition) {
    const origins = this.document.partitions[partition] ?? {};
    return Object.keys(origins)
      .sort()
      .map((origin) => ({ origin, kinds: this.listOrigin(partition, origin) }))
      .filter((entry) => entry.kinds.length);
  }

  /** Every decision this install holds, grouped by partition — Settings. */
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

/**
 * A file from disk → the shape this class works in. Anything malformed is
 * dropped at the smallest granularity that keeps the rest: a bad kind costs the
 * kind, never the origin, and never the file.
 */
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

/**
 * THE PENDING PROMPTS — one record per question the browser is waiting on, and
 * the promise the handler is blocked on.
 *
 * THE REGISTRY IS HERE RATHER THAN IN THE MANAGER because the rules are the
 * interesting part and they are all rules about a question nobody has answered
 * yet: it times out to Block, it is cancelled when the tab it belongs to goes
 * away, a second answer to the same request is ignored rather than racing the
 * first, and a renderer that reloaded can read back what is still open. The
 * manager supplies `deliver` (an IPC send) and nothing else.
 */
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

  /**
   * Ask, and resolve when the human answers — or with Block when the timer
   * runs out. The record handed to `deliver` is exactly what the renderer
   * draws; `sources` is present only for a screen-share picker.
   */
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
      // Delivery failing must not strand the page: the timer is already armed,
      // so a renderer that is not there yet still ends in a definite answer.
      try {
        this.deliver?.(record);
      } catch {
        /* a panel mid-reload is not a reason to hang a page */
      }
    });
  }

  /** The human's answer. An unknown id is a no-op — a second click, or an
   *  answer that arrived after the timeout took the question away. */
  answer(requestId, { decision, sourceId } = {}) {
    const entry = this.pendingById.get(String(requestId || ""));
    if (!entry) return false;
    const chosen = decision === "allow" || decision === "once" || decision === "block" ? decision : "block";
    entry.settle({ decision: chosen, ...(sourceId ? { sourceId: String(sourceId) } : {}) });
    return true;
  }

  /** The question no longer has anywhere to be answered — its tab closed, its
   *  page navigated away, the window went. Answered Block, because a page that
   *  is gone must not be left holding a grant it never got. */
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

  /** What is still open — everything, or one session's. The read a remounted
   *  panel makes so a prompt survives a renderer reload. */
  pending(scopeKey) {
    const records = [...this.pendingById.values()].map((entry) => entry.record);
    return scopeKey === undefined ? records : records.filter((record) => record.scopeKey === scopeKey);
  }

  /** Nothing outlives the window that was asking. */
  dispose() {
    for (const requestId of [...this.pendingById.keys()]) this.cancel(requestId);
  }
}

/**
 * THE OS CONSENT PORT. On macOS the first `askForMediaAccess` raises the system
 * dialog (which is why the Info.plist usage strings and the device entitlements
 * have to be in the packaged app — without them the call fails silently and the
 * prompt never appears); every later call answers from the stored status.
 *
 * ANY OTHER PLATFORM HAS NO SUCH GATE, so it answers granted — the site
 * decision is then the only decision, which is correct there.
 */
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

/** The screen/window list a share picker draws, as data URLs. */
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

/**
 * THE DECISION SURFACE, as four handlers over one partition.
 *
 * `store` remembers, `prompts` asks, `media` is the OS gate, `sources` lists
 * what can be shared, and `locate` turns a WebContents into the session and tab
 * a prompt belongs to (the manager knows that; this file does not).
 *
 * Returned rather than only installed, so every branch below can be exercised
 * without a session object at all.
 */
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

  /**
   * "ALLOW ONCE", HELD AGAINST THE ASKING PAGE. Keyed by WebContents id, so it
   * dies with the tab; dropped on a navigation to another origin, because the
   * grant was given to the site that was in front of the person.
   */
  const onceGrants = new Map(); // webContents id → { origin, kinds: Set }

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
      // The two ends of "this time": the page went, or the page changed.
      webContents.once("destroyed", () => onceGrants.delete(id));
      if (typeof webContents.on === "function") {
        webContents.on("did-navigate", (_event, url) => {
          if (originOf(url) !== onceGrants.get(id)?.origin) onceGrants.delete(id);
        });
      }
    }
  };

  /** The remembered answer for every kind, with once-grants folded in. */
  const standing = (webContents, origin, kinds) =>
    kinds.map((kind) => store.get(partition, origin, kind) ?? onceOf(webContents?.id, origin, kind));

  /**
   * The human's answer, then the OS's. Returns `{ granted, reason? }`.
   *
   * THE ORDER IS THE WHOLE ETHIC OF THE FUNCTION: nothing asks macOS about a
   * device until a person has said the site may have it, so a site you are
   * about to block never raises a system dialog; and nothing tells the site yes
   * until macOS has agreed, so a grant is never a promise Telar cannot keep.
   */
  const resolve = async (webContents, origin, kinds, where) => {
    const answers = standing(webContents, origin, kinds);
    let decision;
    if (answers.includes("block")) decision = "block";
    else if (answers.every((answer) => answer === "allow")) decision = "allow";
    else {
      const asked = await prompts.open({ ...where, partition, origin, kinds });
      decision = asked.decision;
      // Block is remembered too — that is what the button means in every
      // browser, and an origin you refused should not ask again on every
      // reload. It is taken back from the lock popover, like an Allow.
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
        /* a sentence nobody could show is not worth a thrown handler */
      }
    }
    callback(false);
  };

  /**
   * `setPermissionRequestHandler`. Async on purpose — Electron does not wait on
   * the return value, it waits on the callback, which is what lets the prompt
   * and the OS dialog both happen before the page is answered.
   */
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
      // A handler that throws leaves the page waiting forever. Fail closed,
      // loudly enough to find in a log.
      console.error(`[telar-desktop] site permission request failed: ${error && error.message ? error.message : error}`);
      try {
        callback(false);
      } catch {
        /* already answered */
      }
    }
  };

  /**
   * `setPermissionCheckHandler` — the SYNCHRONOUS question Chromium asks before
   * it decides whether to show a page its device labels, and what
   * `navigator.permissions.query` reports.
   *
   * IT NEVER PROMPTS, and that is not a limitation being worked around: this is
   * called speculatively, off any user gesture, and a prompt from here would be
   * a dialog nobody asked for. It answers from what is already known, so
   * "prompt" (nothing stored) reads as false — the page then makes a real
   * request, which is the path that asks.
   */
  const check = (webContents, permission, requestingOrigin, details = {}) => {
    if (GRANTED_WITHOUT_ASKING.has(permission)) return true;
    const kinds = kindsFor(permission, details);
    if (!kinds) return false;
    const origin = originOf(requestingOrigin || details.requestingUrl || webContents?.getURL?.());
    if (!origin) return false;
    return standing(webContents, origin, kinds).every((answer) => answer === "allow");
  };

  /**
   * HID, SERIAL AND USB ARE OUT OF SCOPE AND SAY SO. Returning false is the
   * same answer Chromium gives with no handler, written down: a device grant is
   * a different consent surface (a device chooser, a per-device record) and
   * quietly inheriting the site-permission prompt's "Allow" for it would be
   * this file granting something it never asked about.
   */
  const device = () => false;

  /**
   * `setDisplayMediaRequestHandler` — screen share.
   *
   * THE PICKER IS THE PROMPT. A remembered Block short-circuits before any
   * source is listed (a site that was refused does not get to enumerate this
   * Mac's windows); otherwise the person chooses a screen or a window, and
   * choosing IS the grant. `allow` is written afterwards so the share is
   * revocable from the lock popover and Settings like everything else — and it
   * still shows the picker every time, exactly as Chrome does, because "which
   * window" is a question no memory can answer.
   */
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
        // The handle is the Electron source object; it must not cross IPC.
        sources: listed.map(({ handle, ...source }) => source),
      });
      if (asked.decision === "block") {
        store.remember(partition, origin, "display-capture", "block");
        return answerNothing();
      }
      const chosen = listed.find((source) => source.id === asked.sourceId);
      // Cancelled, or a source that vanished while the picker was open. Not a
      // refusal of the site — nothing is remembered either way.
      if (!chosen) return answerNothing();
      if (asked.decision === "allow") store.remember(partition, origin, "display-capture", "allow");
      callback({ video: chosen.handle });
    } catch (error) {
      console.error(`[telar-desktop] screen share request failed: ${error && error.message ? error.message : error}`);
      try {
        answerNothing();
      } catch {
        /* already answered */
      }
    }
  };

  /** Seat all four on one partition's session. */
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

/**
 * The one call the shell makes: give a partition's session everything it needs
 * to behave like a browser. Returns the handler set, so a caller (a test, a
 * harness) can drive it directly.
 */
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
  GRANTED_WITHOUT_ASKING,
  PROMPT_TIMEOUT_MS,
  KIND_WORDS,
  FILE_NAME,
  STORE_VERSION,
};
