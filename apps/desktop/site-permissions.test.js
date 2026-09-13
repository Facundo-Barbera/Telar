/**
 * WHAT THE BROWSER ANSWERS A SITE, AND WHAT IT REMEMBERS ABOUT IT.
 *
 * Every port is a stub here — `systemPreferences`, the source list, the timers,
 * the filesystem — which is the point of the shape site-permissions.js has: the
 * decisions are the interesting part and none of them needs Electron to be
 * exercised. The invariants below are the ones that would otherwise only be
 * discovered on a signed build in front of a real camera.
 */
const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SitePermissionStore,
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
} = require("./site-permissions");

const PARTITION = "persist:telar-profile-bp_0000000000000001";
const OTHER = "persist:telar-profile-bp_0000000000000002";
const SITE = "https://meet.example.com";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telar-site-permissions-"));
}

/** A store with a predictable clock. */
function store(dir, at = 1_000) {
  return new SitePermissionStore(dir, { now: () => at });
}

/** A prompt registry that answers whatever the test says, with no real timer. */
function prompts(answers = []) {
  const asked = [];
  const timers = new Map();
  let nextTimer = 0;
  const queue = [...answers];
  const registry = new PermissionPrompts({
    deliver: (record) => asked.push(record),
    mintId: () => `perm_${asked.length + 1}`,
    now: () => 7,
    setTimer: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  // Answer as the question arrives, so a handler awaiting `open` resolves.
  const deliver = registry.deliver;
  registry.deliver = (record) => {
    deliver(record);
    const answer = queue.shift();
    if (answer) queueMicrotask(() => registry.answer(record.requestId, answer));
  };
  return { registry, asked, timers, fire: () => [...timers.values()].forEach((timer) => timer.fn()) };
}

/** macOS consent, faked. */
function consent({ camera = true, microphone = true, status = "denied" } = {}) {
  const calls = [];
  return {
    calls,
    port: {
      ask: async (kind) => {
        calls.push(kind);
        return kind === "camera" ? camera : microphone;
      },
      status: () => status,
    },
  };
}

/** A WebContents, as much of one as the handlers ever touch. */
function page(id = 1, url = `${SITE}/room/7`) {
  const listeners = new Map();
  return {
    id,
    getURL: () => url,
    once: (event, fn) => listeners.set(event, fn),
    on: (event, fn) => listeners.set(event, fn),
    emit: (event, ...args) => listeners.get(event)?.(...args),
  };
}

/** Drive `request` and return what the site was told. */
function askSite(handlers, permission, details, webContents = page()) {
  return new Promise((resolve) => {
    void handlers.request(webContents, permission, resolve, details);
  });
}

describe("the vocabulary a decision is made in", () => {
  test("an origin is an http(s) origin or nothing a decision can be scoped to", () => {
    expect(originOf("https://example.com/a/b?c=1")).toBe("https://example.com");
    expect(originOf("http://localhost:3000/x")).toBe("http://localhost:3000");
    // A file page's origin is `null` in the spec: every local file would share
    // one bucket. An extension page is the credential UI, never a site.
    expect(originOf("file:///Users/me/page.html")).toBeNull();
    expect(originOf("chrome-extension://abc/popup.html")).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });

  test("media splits into the two devices a person actually answers about", () => {
    expect(kindsFor("media", { mediaTypes: ["video"] })).toEqual(["camera"]);
    expect(kindsFor("media", { mediaTypes: ["audio"] })).toEqual(["microphone"]);
    expect(kindsFor("media", { mediaTypes: ["video", "audio"] })).toEqual(["camera", "microphone"]);
    // Chromium not telling us which device means both, and the prompt says so.
    expect(kindsFor("media", {})).toEqual(["camera", "microphone"]);
  });

  test("a permission nobody designed an answer for is not a kind at all", () => {
    for (const permission of ["midi", "midiSysex", "usb", "serial", "idle-detection", "window-management", "unknown"]) {
      expect(kindsFor(permission, {})).toBeNull();
    }
    expect(kindsFor("notifications", {})).toEqual(["notifications"]);
    expect(kindsFor("geolocation", {})).toEqual(["geolocation"]);
    expect(kindsFor("clipboard-read", {})).toEqual(["clipboard-read"]);
    expect(kindsFor("display-capture", {})).toEqual(["display-capture"]);
  });

  test("the words are the ones a prompt and a settings row both print", () => {
    expect(describeKinds(["camera"])).toBe("camera");
    expect(describeKinds(["camera", "microphone"])).toBe("camera and microphone");
    expect(describeKinds(["camera", "microphone", "geolocation"])).toBe("camera, microphone and location");
    // The refusal names the pane, because "check your privacy settings" is not
    // an instruction anyone can follow.
    expect(systemSettingsSentence("camera", "denied")).toContain("System Settings ▸ Privacy & Security ▸ Camera");
    expect(systemSettingsSentence("microphone", "restricted")).toContain("Screen Time");
  });
});

describe("the remembered answers", () => {
  test("a decision belongs to one partition and one origin, and carries when it was made", () => {
    const dir = tmp();
    const keeper = store(dir, 4_242);
    keeper.remember(PARTITION, SITE, "camera", "allow");
    expect(keeper.get(PARTITION, SITE, "camera")).toBe("allow");
    // Another jar signed into another account has not agreed to anything.
    expect(keeper.get(OTHER, SITE, "camera")).toBeNull();
    expect(keeper.get(PARTITION, "https://other.example", "camera")).toBeNull();
    expect(keeper.get(PARTITION, SITE, "microphone")).toBeNull();
    expect(keeper.listOrigin(PARTITION, SITE)).toEqual([{ kind: "camera", decision: "allow", at: 4_242 }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("it survives a restart, and a hand-edited file costs the memory rather than the browser", () => {
    const dir = tmp();
    store(dir).remember(PARTITION, SITE, "microphone", "block");
    expect(new SitePermissionStore(dir).get(PARTITION, SITE, "microphone")).toBe("block");
    // Junk at every level is dropped at the smallest granularity that keeps
    // the rest: one bad kind costs the kind, not the file.
    fs.writeFileSync(
      path.join(dir, FILE_NAME),
      JSON.stringify({
        version: 1,
        partitions: {
          [PARTITION]: {
            [SITE]: { camera: { decision: "allow", at: 1 }, microphone: { decision: "maybe" }, "x-ray": { decision: "allow" } },
            "file:///etc/passwd": { camera: { decision: "allow" } },
          },
        },
      }),
    );
    const reread = new SitePermissionStore(dir);
    expect(reread.listOrigin(PARTITION, SITE)).toEqual([{ kind: "camera", decision: "allow", at: 1 }]);
    expect(reread.list(PARTITION)).toHaveLength(1);
    // Unreadable entirely: every site asks again, which is a new install.
    fs.writeFileSync(path.join(dir, FILE_NAME), "{not json");
    expect(new SitePermissionStore(dir).all()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("forgetting one kind keeps the others; forgetting an origin takes the lot", () => {
    const dir = tmp();
    const keeper = store(dir);
    keeper.remember(PARTITION, SITE, "camera", "allow");
    keeper.remember(PARTITION, SITE, "microphone", "allow");
    keeper.remember(PARTITION, "https://maps.example", "geolocation", "block");
    expect(keeper.forget(PARTITION, SITE, "camera")).toBe(true);
    expect(keeper.listOrigin(PARTITION, SITE).map((entry) => entry.kind)).toEqual(["microphone"]);
    expect(keeper.forget(PARTITION, SITE)).toBe(true);
    // An origin nobody holds anything for leaves no skeleton behind.
    expect(keeper.list(PARTITION).map((entry) => entry.origin)).toEqual(["https://maps.example"]);
    expect(keeper.forget(PARTITION, SITE)).toBe(false);
    expect(keeper.forget(PARTITION, "https://maps.example", "geolocation")).toBe(true);
    expect(keeper.all()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("only the closed vocabulary, only an origin, only two decisions", () => {
    const keeper = store(null);
    expect(() => keeper.remember(PARTITION, SITE, "camera", "maybe")).toThrow(/allow|block/);
    expect(() => keeper.remember(PARTITION, SITE, "x-ray", "allow")).toThrow(/Unknown site permission/);
    expect(() => keeper.remember(PARTITION, "file:///x", "camera", "allow")).toThrow(/http\(s\) origin/);
    expect(PERMISSION_KINDS).toEqual(["camera", "microphone", "notifications", "geolocation", "clipboard-read", "display-capture"]);
  });

  test("a store with no userData writes nothing and still answers", () => {
    const keeper = store(null);
    keeper.remember(PARTITION, SITE, "notifications", "allow");
    expect(keeper.get(PARTITION, SITE, "notifications")).toBe("allow");
    expect(keeper.file).toBeNull();
  });

  test("Settings reads every decision this install holds, grouped by jar", () => {
    const keeper = store(null);
    keeper.remember(PARTITION, SITE, "camera", "allow");
    keeper.remember(OTHER, "https://maps.example", "geolocation", "block");
    expect(keeper.all()).toEqual([
      { partition: PARTITION, origins: [{ origin: SITE, kinds: [{ kind: "camera", decision: "allow", at: 1_000 }] }] },
      { partition: OTHER, origins: [{ origin: "https://maps.example", kinds: [{ kind: "geolocation", decision: "block", at: 1_000 }] }] },
    ].sort((a, b) => a.partition.localeCompare(b.partition)));
  });
});

describe("a question nobody has answered yet", () => {
  test("times out to Block after a minute — an agent's tab included", () => {
    const asked = prompts();
    let answer;
    void asked.registry.open({ scopeKey: "s1", tabId: "t1", origin: SITE, kinds: ["camera"] }).then((result) => {
      answer = result;
    });
    expect(asked.registry.pending("s1")).toHaveLength(1);
    expect([...asked.timers.values()][0].ms).toBe(PROMPT_TIMEOUT_MS);
    asked.fire();
    return Promise.resolve().then(() => {
      expect(answer).toEqual({ decision: "block", timedOut: true });
      expect(asked.registry.pending()).toEqual([]);
    });
  });

  test("a second answer to the same question is ignored rather than racing the first", async () => {
    const asked = prompts();
    const pending = asked.registry.open({ origin: SITE, kinds: ["microphone"] });
    const [record] = asked.asked;
    expect(asked.registry.answer(record.requestId, { decision: "allow" })).toBe(true);
    expect(asked.registry.answer(record.requestId, { decision: "block" })).toBe(false);
    expect(await pending).toEqual({ decision: "allow" });
  });

  test("a tab that goes away takes its question with it, answered Block", async () => {
    const asked = prompts();
    const pending = asked.registry.open({ scopeKey: "s1", tabId: "gone", origin: SITE, kinds: ["camera"] });
    expect(asked.registry.cancelWhere((record) => record.tabId === "gone")).toBe(1);
    expect(await pending).toEqual({ decision: "block" });
  });

  test("what is still open is readable back — a renderer reload does not lose a prompt", () => {
    const asked = prompts();
    void asked.registry.open({ scopeKey: "s1", origin: SITE, kinds: ["camera"] });
    void asked.registry.open({ scopeKey: "s2", origin: SITE, kinds: ["notifications"] });
    expect(asked.registry.pending("s1").map((record) => record.kinds)).toEqual([["camera"]]);
    expect(asked.registry.pending()).toHaveLength(2);
    asked.registry.dispose();
    expect(asked.registry.pending()).toEqual([]);
  });

  test("a delivery that throws still ends in a definite answer", async () => {
    const registry = new PermissionPrompts({
      deliver: () => {
        throw new Error("the window went");
      },
      setTimer: (fn) => {
        queueMicrotask(fn);
        return 1;
      },
      clearTimer: () => {},
    });
    expect(await registry.open({ origin: SITE, kinds: ["camera"] })).toEqual({ decision: "block", timedOut: true });
  });
});

describe("what the site is told", () => {
  const handlers = (options = {}) => {
    const keeper = options.store ?? store(null);
    const asked = options.prompts ?? prompts(options.answers ?? []);
    const os_ = options.consent ?? consent();
    const denials = [];
    return {
      keeper,
      asked,
      os: os_,
      denials,
      handlers: createPermissionHandlers({
        partition: PARTITION,
        store: keeper,
        prompts: asked.registry,
        media: os_.port,
        locate: () => ({ scopeKey: "s1", tabId: "t1" }),
        onDenied: (context) => denials.push(context),
        ...(options.sources ? { sources: options.sources } : {}),
      }),
    };
  };

  test("nothing is stored, so it asks — and Allow is remembered for next time", async () => {
    const bundle = handlers({ answers: [{ decision: "allow" }] });
    expect(await askSite(bundle.handlers, "media", { requestingUrl: `${SITE}/room`, mediaTypes: ["video"] })).toBe(true);
    expect(bundle.asked.asked[0]).toMatchObject({ origin: SITE, kinds: ["camera"], scopeKey: "s1", tabId: "t1", partition: PARTITION });
    expect(bundle.keeper.get(PARTITION, SITE, "camera")).toBe("allow");
    // Remembered: the second request never reaches the human.
    expect(await askSite(bundle.handlers, "media", { requestingUrl: `${SITE}/room`, mediaTypes: ["video"] })).toBe(true);
    expect(bundle.asked.asked).toHaveLength(1);
  });

  test("Block is remembered too, and a blocked origin stops asking on every reload", async () => {
    const bundle = handlers({ answers: [{ decision: "block" }] });
    expect(await askSite(bundle.handlers, "notifications", { requestingUrl: `${SITE}/` })).toBe(false);
    expect(bundle.keeper.get(PARTITION, SITE, "notifications")).toBe("block");
    expect(await askSite(bundle.handlers, "notifications", { requestingUrl: `${SITE}/` })).toBe(false);
    expect(bundle.asked.asked).toHaveLength(1);
  });

  test("Allow once is never written down, and dies with the page that asked", async () => {
    const bundle = handlers({ answers: [{ decision: "once" }, { decision: "once" }] });
    const tab = page(11);
    expect(await askSite(bundle.handlers, "media", { requestingUrl: `${SITE}/room`, mediaTypes: ["audio"] }, tab)).toBe(true);
    expect(bundle.keeper.get(PARTITION, SITE, "microphone")).toBeNull();
    // Still live for this page: the check handler answers true without asking.
    expect(bundle.handlers.check(tab, "media", SITE, { mediaTypes: ["audio"] })).toBe(true);
    // The page navigates somewhere else — the grant was given to the site that
    // was in front of the person, not to the tab.
    tab.emit("did-navigate", null, "https://elsewhere.example/");
    expect(bundle.handlers.check(tab, "media", SITE, { mediaTypes: ["audio"] })).toBe(false);
    expect(await askSite(bundle.handlers, "media", { requestingUrl: `${SITE}/room`, mediaTypes: ["audio"] }, tab)).toBe(true);
    expect(bundle.asked.asked).toHaveLength(2);
  });

  test("one blocked kind blocks the pair — a half-answered request is not a grant", async () => {
    const keeper = store(null);
    keeper.remember(PARTITION, SITE, "microphone", "block");
    const bundle = handlers({ store: keeper });
    expect(await askSite(bundle.handlers, "media", { requestingUrl: `${SITE}/room`, mediaTypes: ["video", "audio"] })).toBe(false);
    // And it did not ask: the person already refused half of it.
    expect(bundle.asked.asked).toEqual([]);
  });

  test("a permission this browser does not offer is refused without a prompt", async () => {
    const bundle = handlers({ answers: [{ decision: "allow" }] });
    for (const permission of ["midi", "usb", "serial", "idle-detection", "window-management"]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await askSite(bundle.handlers, permission, { requestingUrl: `${SITE}/` })).toBe(false);
    }
    expect(bundle.asked.asked).toEqual([]);
  });

  test("a page with no origin a decision could be scoped to is refused", async () => {
    const bundle = handlers({ answers: [{ decision: "allow" }] });
    expect(await askSite(bundle.handlers, "geolocation", { requestingUrl: "file:///Users/me/page.html" })).toBe(false);
    expect(bundle.asked.asked).toEqual([]);
  });

  test("fullscreen and pointer lock are granted the way every browser grants them", async () => {
    const bundle = handlers();
    expect(await askSite(bundle.handlers, "fullscreen", { requestingUrl: `${SITE}/` })).toBe(true);
    expect(await askSite(bundle.handlers, "pointerLock", { requestingUrl: `${SITE}/` })).toBe(true);
    expect(bundle.handlers.check(page(), "fullscreen", SITE, {})).toBe(true);
    expect(bundle.asked.asked).toEqual([]);
  });

  test("a prompt nobody answers ends as Block and the page is told so", async () => {
    const asked = prompts();
    const bundle = handlers({ prompts: asked });
    const answered = askSite(bundle.handlers, "geolocation", { requestingUrl: `${SITE}/` });
    await Promise.resolve();
    asked.fire();
    expect(await answered).toBe(false);
  });
});

describe("macOS is the second gate, and it is asked in the right order", () => {
  const bundle = (options) => {
    const keeper = store(null);
    const asked = prompts(options.answers ?? []);
    const os_ = consent(options.consent ?? {});
    const denials = [];
    return {
      keeper,
      asked,
      os: os_,
      denials,
      handlers: createPermissionHandlers({
        partition: PARTITION,
        store: keeper,
        prompts: asked.registry,
        media: os_.port,
        onDenied: (context) => denials.push(context),
      }),
    };
  };

  test("a site the person is about to block never raises a system dialog", async () => {
    const it = bundle({ answers: [{ decision: "block" }] });
    expect(await askSite(it.handlers, "media", { requestingUrl: `${SITE}/`, mediaTypes: ["video"] })).toBe(false);
    expect(it.os.calls).toEqual([]);
  });

  test("the OS is asked once the person has said yes, for each device asked for", async () => {
    const it = bundle({ answers: [{ decision: "allow" }] });
    expect(await askSite(it.handlers, "media", { requestingUrl: `${SITE}/`, mediaTypes: ["video", "audio"] })).toBe(true);
    expect(it.os.calls).toEqual(["camera", "microphone"]);
  });

  test("an OS refusal denies the site and says which pane to open — not a silent no", async () => {
    const it = bundle({ answers: [{ decision: "allow" }], consent: { camera: false, status: "denied" } });
    expect(await askSite(it.handlers, "media", { requestingUrl: `${SITE}/`, mediaTypes: ["video"] })).toBe(false);
    expect(it.denials[0].reason).toContain("System Settings ▸ Privacy & Security ▸ Camera");
    // The site decision still stands: the human said yes and macOS is what has
    // to change. Turning it on in System Settings is enough, with no re-ask.
    expect(it.keeper.get(PARTITION, SITE, "camera")).toBe("allow");
  });

  test("a remembered Allow still goes through the OS gate, so a revoked grant cannot be promised", async () => {
    const it = bundle({ consent: { microphone: false } });
    it.keeper.remember(PARTITION, SITE, "microphone", "allow");
    expect(await askSite(it.handlers, "media", { requestingUrl: `${SITE}/`, mediaTypes: ["audio"] })).toBe(false);
    expect(it.asked.asked).toEqual([]);
    expect(it.os.calls).toEqual(["microphone"]);
  });

  test("notifications and location never touch the device gate", async () => {
    const it = bundle({ answers: [{ decision: "allow" }] });
    expect(await askSite(it.handlers, "geolocation", { requestingUrl: `${SITE}/` })).toBe(true);
    expect(it.os.calls).toEqual([]);
  });

  test("off macOS there is no second gate at all", async () => {
    const port = systemMediaConsent({ platform: "linux" });
    expect(await port.ask("camera")).toBe(true);
    expect(port.status("camera")).toBe("granted");
    // On darwin with no systemPreferences (a non-Electron process) the call is
    // a no-op rather than a hang.
    const bare = systemMediaConsent({ platform: "darwin", electron: {} });
    expect(await bare.ask("camera")).toBe(true);
  });

  test("systemPreferences is what the darwin port actually calls", async () => {
    const calls = [];
    const port = systemMediaConsent({
      platform: "darwin",
      electron: {
        askForMediaAccess: async (type) => {
          calls.push(type);
          return type === "camera";
        },
        getMediaAccessStatus: () => "denied",
      },
    });
    expect(await port.ask("camera")).toBe(true);
    expect(await port.ask("microphone")).toBe(false);
    expect(calls).toEqual(["camera", "microphone"]);
    expect(port.status("microphone")).toBe("denied");
  });
});

describe("the speculative check never prompts", () => {
  test("it answers from what is known, and 'nothing known' reads as no", () => {
    const keeper = store(null);
    const asked = prompts([{ decision: "allow" }]);
    const handlers = createPermissionHandlers({ partition: PARTITION, store: keeper, prompts: asked.registry, media: consent().port });
    expect(handlers.check(page(), "media", SITE, { mediaTypes: ["video"] })).toBe(false);
    keeper.remember(PARTITION, SITE, "camera", "allow");
    expect(handlers.check(page(), "media", SITE, { mediaTypes: ["video"] })).toBe(true);
    // Both asked for, one held: not a grant.
    expect(handlers.check(page(), "media", SITE, { mediaTypes: ["video", "audio"] })).toBe(false);
    keeper.remember(PARTITION, SITE, "microphone", "block");
    expect(handlers.check(page(), "media", SITE, { mediaTypes: ["audio"] })).toBe(false);
    // Nothing was asked of the human by any of that.
    expect(asked.asked).toEqual([]);
  });
});

describe("HID, serial and USB", () => {
  test("are refused, deliberately and in writing", () => {
    const handlers = createPermissionHandlers({ partition: PARTITION, store: store(null), prompts: prompts().registry });
    expect(handlers.device({}, { deviceType: "hid" })).toBe(false);
    expect(handlers.device({}, { deviceType: "serial" })).toBe(false);
    expect(handlers.device({}, { deviceType: "usb" })).toBe(false);
  });
});

describe("screen share", () => {
  const source = (id, name) => ({ id, name, thumbnail: { toDataURL: () => `data:image/png;base64,${id}` } });
  const bundle = (options = {}) => {
    const keeper = options.store ?? store(null);
    const asked = prompts(options.answers ?? []);
    const listed = options.sources ?? [source("screen:0:0", "Entire screen"), source("window:42:0", "Telar")];
    return {
      keeper,
      asked,
      listed,
      handlers: createPermissionHandlers({
        partition: PARTITION,
        store: keeper,
        prompts: asked.registry,
        media: consent().port,
        sources: desktopCaptureSources({ electron: { getSources: async () => listed } }),
      }),
    };
  };
  const share = (handlers, origin = SITE) =>
    new Promise((resolve) => {
      void handlers.displayMedia({ securityOrigin: `${origin}/`, frame: { url: `${origin}/call` } }, resolve);
    });

  test("the picker IS the prompt: choosing a source shares it, and the grant is revocable", async () => {
    const it = bundle({ answers: [{ decision: "allow", sourceId: "window:42:0" }] });
    const answer = await share(it.handlers);
    expect(answer.video).toBe(it.listed[1]);
    expect(it.keeper.get(PARTITION, SITE, "display-capture")).toBe("allow");
    // The sources reach the renderer as data, never as Electron handles.
    expect(it.asked.asked[0].sources).toEqual([
      { id: "screen:0:0", name: "Entire screen", kind: "screen", thumbnail: "data:image/png;base64,screen:0:0" },
      { id: "window:42:0", name: "Telar", kind: "window", thumbnail: "data:image/png;base64,window:42:0" },
    ]);
  });

  test("a remembered Allow still shows the picker — 'which window' is a question no memory answers", async () => {
    const it = bundle({ answers: [{ decision: "allow", sourceId: "screen:0:0" }] });
    it.keeper.remember(PARTITION, SITE, "display-capture", "allow");
    expect((await share(it.handlers)).video).toBe(it.listed[0]);
    expect(it.asked.asked).toHaveLength(1);
  });

  test("a refused site never gets to enumerate this Mac's windows", async () => {
    let listedAt = 0;
    const keeper = store(null);
    keeper.remember(PARTITION, SITE, "display-capture", "block");
    const asked = prompts([{ decision: "allow", sourceId: "screen:0:0" }]);
    const handlers = createPermissionHandlers({
      partition: PARTITION,
      store: keeper,
      prompts: asked.registry,
      sources: async () => {
        listedAt += 1;
        return [];
      },
    });
    expect(await share(handlers)).toEqual({});
    expect(listedAt).toBe(0);
    expect(asked.asked).toEqual([]);
  });

  test("Block from the picker is remembered; Cancel is not a refusal of the site", async () => {
    const blocked = bundle({ answers: [{ decision: "block" }] });
    expect(await share(blocked.handlers)).toEqual({});
    expect(blocked.keeper.get(PARTITION, SITE, "display-capture")).toBe("block");

    // Cancel arrives as an allow with no source chosen (or a source that went
    // away while the picker was open): nothing shared, nothing remembered.
    const cancelled = bundle({ answers: [{ decision: "allow" }] });
    expect(await share(cancelled.handlers)).toEqual({});
    expect(cancelled.keeper.get(PARTITION, SITE, "display-capture")).toBeNull();
  });

  test("a page with no shareable origin, and a Mac with nothing to list, both answer nothing", async () => {
    const it = bundle({ answers: [{ decision: "allow", sourceId: "screen:0:0" }] });
    expect(await share(it.handlers, "file:///Users/me")).toEqual({});
    const empty = bundle({ answers: [{ decision: "allow", sourceId: "screen:0:0" }], sources: [] });
    expect(await share(empty.handlers)).toEqual({});
  });
});

describe("installation", () => {
  test("every partition gets all four handlers, and the request one is what the session was given", async () => {
    const seated = {};
    const asked = prompts([{ decision: "allow" }]);
    const session = {
      setPermissionRequestHandler: (fn) => (seated.request = fn),
      setPermissionCheckHandler: (fn) => (seated.check = fn),
      setDevicePermissionHandler: (fn) => (seated.device = fn),
      setDisplayMediaRequestHandler: (fn) => (seated.displayMedia = fn),
    };
    const handlers = installSitePermissions(session, { partition: PARTITION, store: store(null), prompts: asked.registry, media: consent().port });
    expect(seated.request).toBe(handlers.request);
    expect(seated.check).toBe(handlers.check);
    expect(seated.device).toBe(handlers.device);
    expect(seated.displayMedia).toBe(handlers.displayMedia);
    expect(await new Promise((resolve) => void seated.request(page(), "notifications", resolve, { requestingUrl: `${SITE}/` }))).toBe(true);
  });

  test("an older session with no display-media hook still gets the other three", () => {
    const seated = {};
    const session = {
      setPermissionRequestHandler: (fn) => (seated.request = fn),
      setPermissionCheckHandler: (fn) => (seated.check = fn),
      setDevicePermissionHandler: (fn) => (seated.device = fn),
    };
    expect(() => installSitePermissions(session, { partition: PARTITION, store: store(null), prompts: prompts().registry })).not.toThrow();
    expect(typeof seated.device).toBe("function");
  });

  test("the handler set refuses to exist without the three things it decides with", () => {
    expect(() => createPermissionHandlers({ store: store(null), prompts: prompts().registry })).toThrow(/partition/);
    expect(() => createPermissionHandlers({ partition: PARTITION, prompts: prompts().registry })).toThrow(/store/);
    expect(() => createPermissionHandlers({ partition: PARTITION, store: store(null) })).toThrow(/ask/);
  });
});
