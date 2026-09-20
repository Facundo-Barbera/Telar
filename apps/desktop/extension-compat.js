/**
 * CHROME-EXTENSION COMPATIBILITY FOR THE INTEGRATED BROWSER — the piece
 * between Electron's partial extension support and an official extension that
 * expects Chrome. Shared by the app and the isolated 1Password harness.
 *
 *   · electron-chrome-extensions (Samuel Maddock; GPL-3.0 / patron dual
 *     license — GPL-3.0 declared here) supplies action/popup, contextMenus,
 *     notifications, tabs, windows, webNavigation, cookies and a native-
 *     messaging host that reads Chrome's own NativeMessagingHosts manifests,
 *     enforces `allowed_origins`, and spawns the host with the real
 *     `chrome-extension://<id>/` origin. Nothing here spoofs a browser or
 *     relaxes those checks.
 *   · CRX3 identity is VERIFIED, then preserved: every RSA/ECDSA proof in the
 *     package is checked over Chromium's signed payload, the id the package
 *     was signed for must match the id the caller PINS, and only then is the
 *     matching publisher key written to `manifest.key` — which is how Chrome
 *     itself derives the id. A package that fails any of that is refused.
 *   · Shims run in the EXTENSION'S MAIN WORLD, only for the pinned origin,
 *     and before the library freezes `chrome`. Ordinary pages never see them.
 *   · No message payloads are ever logged by this module.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

// ── CRX3 ──────────────────────────────────────────────────────────────────

/** Strict protobuf varint: bounded to 10 bytes, must terminate inside `buf`. */
function varint(buf, i) {
  let r = 0n;
  let s = 0n;
  for (let n = 0; n < 10; n += 1) {
    if (i >= buf.length) throw new Error("CRX3: truncated varint");
    const c = buf[i++];
    r |= BigInt(c & 0x7f) << s;
    s += 7n;
    if (c < 0x80) {
      if (r > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CRX3: varint out of range");
      return [Number(r), i];
    }
  }
  throw new Error("CRX3: varint too long");
}

/** Length-delimited protobuf fields only (that is all crx3.proto uses). */
function fields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag;
    [tag, i] = varint(buf, i);
    if ((tag & 7) !== 2) throw new Error("CRX3: unexpected wire type");
    let len;
    [len, i] = varint(buf, i);
    if (i + len > buf.length) throw new Error("CRX3: field runs past buffer");
    out.push({ field: tag >> 3, value: buf.subarray(i, i + len) });
    i += len;
  }
  return out;
}

/** Chrome's id alphabet: each nibble of the first 16 bytes → a–p. */
const alpha = (bytes) => [...bytes].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
const idOf = (der) => alpha(crypto.createHash("sha256").update(der).digest().subarray(0, 16));

/**
 * Parse and VERIFY a CRX3. Chromium's scheme (crx3.proto / crx_verifier.cc):
 * each proof's signature covers
 *   "CRX3 SignedData\0" ‖ uint32le(len(signed_header_data)) ‖ signed_header_data ‖ zip
 * with RSA-PKCS1v1.5-SHA256 (field 2) or ECDSA-P256-SHA256 (field 3).
 * `expectedId` is the id the caller trusts (the Web Store's); the package's
 * own signed crx_id must equal it, and a proof must exist whose key hashes to
 * it. Any proof that fails to verify refuses the whole package.
 */
function verifyCrx(crxBuffer, expectedId) {
  if (crxBuffer.length < 12 || crxBuffer.toString("ascii", 0, 4) !== "Cr24") throw new Error("CRX3: bad magic");
  const version = crxBuffer.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX${version} is not supported (CRX3 only)`);
  const headerLength = crxBuffer.readUInt32LE(8);
  if (12 + headerLength > crxBuffer.length) throw new Error("CRX3: header runs past file");
  const header = crxBuffer.subarray(12, 12 + headerLength);
  const zip = crxBuffer.subarray(12 + headerLength);
  const top = fields(header);
  const signedData = top.find((f) => f.field === 10000);
  if (!signedData) throw new Error("CRX3: no signed_header_data");
  const crxIdField = fields(signedData.value).find((f) => f.field === 1);
  if (!crxIdField || crxIdField.value.length !== 16) throw new Error("CRX3: bad crx_id");
  const signedCrxId = alpha(crxIdField.value);
  if (signedCrxId !== expectedId) throw new Error(`CRX3: package is signed for ${signedCrxId}, expected ${expectedId}`);

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(signedData.value.length, 0);
  const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), lengthPrefix, signedData.value, zip]);

  const proofs = top.filter((f) => f.field === 2 || f.field === 3);
  if (proofs.length === 0) throw new Error("CRX3: no proofs");
  let publisherKey;
  const verified = [];
  for (const proof of proofs) {
    const parts = fields(proof.value);
    const pub = parts.find((f) => f.field === 1)?.value;
    const sig = parts.find((f) => f.field === 2)?.value;
    if (!pub || !sig) throw new Error("CRX3: incomplete proof");
    const key = crypto.createPublicKey({ key: pub, format: "der", type: "spki" });
    const ok =
      proof.field === 2
        ? crypto.verify("sha256", payload, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig)
        : crypto.verify("sha256", payload, { key, dsaEncoding: "der" }, sig);
    if (!ok) throw new Error(`CRX3: ${proof.field === 2 ? "RSA" : "ECDSA"} proof failed to verify`);
    const id = idOf(pub);
    verified.push({ algorithm: proof.field === 2 ? "sha256_with_rsa" : "sha256_with_ecdsa", id });
    if (id === signedCrxId) publisherKey = pub.toString("base64");
  }
  if (!publisherKey) throw new Error("CRX3: no verified proof matches the signed crx_id");
  return { id: signedCrxId, publisherKey, proofs: verified, zip };
}

/**
 * Verify, unpack, and write `manifest.key` so Electron derives the SAME id
 * Chrome does. Refuses a manifest that already carries a different key.
 */
function unpackVerified(crxPath, outDir, expectedId) {
  const identity = verifyCrx(fs.readFileSync(crxPath), expectedId);
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, "..", `${path.basename(outDir)}.zip`);
  fs.writeFileSync(zipPath, identity.zip);
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", outDir]);
  const manifestPath = path.join(outDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (Object.prototype.hasOwnProperty.call(manifest, "key") && manifest.key !== identity.publisherKey) {
    throw new Error("CRX3: manifest.key disagrees with the verified publisher key");
  }
  manifest.key = identity.publisherKey;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { id: identity.id, proofs: identity.proofs, manifest, keyWritten: true };
}

// ── session support ───────────────────────────────────────────────────────

/**
 * THE LIBRARY'S RENDERER PRELOAD LOGS PAYLOADS. Its published
 * dist/chrome-extension-api.preload.js was compiled in development mode:
 * three `if (true) { console.log(...) }` blocks print every extension API
 * call's arguments and result — and every event's payload — to the
 * extension's console. NODE_ENV cannot reach a literal `true`, so the file
 * is rewritten: each of the three blocks is removed by EXACT match, the
 * count is asserted, and anything else noisy that the exact patterns did
 * not cover fails the sanitizer loudly rather than being redacted by guess.
 */
const NOISY_BLOCKS = [
  `      if (true) {\n        console.log(name, "(result)", ...args);\n      }\n`,
  `      if (true) {\n        console.log(fnName, args);\n      }\n`,
  `      if (true) {\n        console.log(fnName, "(result)", result);\n      }\n`,
];

function sanitizePreloadSource(source) {
  let out = source;
  for (const block of NOISY_BLOCKS) {
    const at = out.indexOf(block);
    if (at < 0) throw new Error("preload sanitizer: expected logging block not found — the library changed; re-verify before use");
    if (out.indexOf(block, at + 1) >= 0) throw new Error("preload sanitizer: logging block matched more than once");
    out = out.slice(0, at) + out.slice(at + block.length);
  }
  if (/\bif \(true\)/.test(out)) throw new Error("preload sanitizer: an unexpected `if (true)` remains");
  if (/console\.(log|info|debug)\(/.test(out)) throw new Error("preload sanitizer: an unexpected console.log/info/debug remains");
  return out;
}

/**
 * WHICH CONTEXT A PRELOAD LANDED IN — the gate both extension preloads run
 * before they do anything (#487).
 *
 * Electron's `registerPreloadScript` takes no scheme and no scope, so a
 * preload registered for `type: "service-worker"` runs in EVERY service worker
 * of the partition: github's, youtube's, cloudflare's, and 1Password's alike.
 * Upstream's own dispatch (`process.type === "service-worker" ||
 * location.href.startsWith("chrome-extension://")`) makes that explicit — the
 * service-worker arm never looks at an origin at all. So a site's worker was
 * getting the whole extension API bridge injected into its main world, plus an
 * `electron` object on the way in.
 *
 * `context` is what the isolated world could answer about itself: a `location`
 * protocol (a frame has one), a service-worker `registration.scope`, and the
 * extension id an already-installed `chrome.runtime` carries.
 *
 * UNKNOWN RUNS, DELIBERATELY. Electron gives a service-worker preload's
 * isolated world no location and no chrome (that is what the probe in
 * `registerShimPreload` records, and why upstream orders its condition the way
 * it does), so a context that answers nothing is NOT evidence of a site — and
 * refusing it would take 1Password's own worker preloads away with it and
 * break the login flow. This gate only removes the contexts it can actually
 * name; the main-world gates (`mainWorldShims`' pinned-id check, and the
 * library reading `chrome.runtime.id` for itself) still refuse the rest.
 */
function isExtensionPreloadContext({ protocol = null, scope = null, runtimeId = null } = {}) {
  // A frame's own location is authoritative and beats everything: a content
  // script's isolated world carries a runtime id while the document is a site.
  if (typeof protocol === "string" && protocol) return protocol === "chrome-extension:";
  // A service worker that DOES expose its registration names its own origin.
  if (typeof scope === "string" && scope) {
    try { return new URL(scope).protocol === "chrome-extension:"; } catch { return true; }
  }
  if (typeof runtimeId === "string" && runtimeId) return true;
  return true;
}

/** The isolated-world prelude that answers `isExtensionPreloadContext` where
 *  the preload actually runs. Reading any of the three can throw in a context
 *  that has none of them, so each is guarded on its own. */
const GATE_SOURCE = `
// #487: an extension preload must not run in a site's service worker.
const __telarPreloadContext = { protocol: null, scope: null, runtimeId: null };
try { __telarPreloadContext.protocol = globalThis.location?.protocol ?? null; } catch {}
try { __telarPreloadContext.scope = globalThis.registration?.scope ?? globalThis.self?.registration?.scope ?? null; } catch {}
try { __telarPreloadContext.runtimeId = globalThis.chrome?.runtime?.id ?? null; } catch {}
const __telarIsExtensionContext = (${isExtensionPreloadContext.toString()})(__telarPreloadContext);
`;

/**
 * Write the sanitized preload beside the shims and return its path. The
 * library's own registration is replaced (same ids, `crx-mv2-preload` /
 * `crx-mv3-preload`) so exactly one copy runs.
 *
 * The sanitized source is wrapped in the #487 gate rather than edited: the
 * sanitizer stays a function that only removes upstream's payload logs (its
 * byte accounting is asserted in the tests), and the gate is a prelude around
 * the whole IIFE. A block, not a top-level `return` — a preload that Electron
 * ever loaded as a classic script would make that a SyntaxError, and a
 * SyntaxError here is 1Password not loading.
 */
function sanitizedPreloadPath(dir) {
  const upstream = require.resolve("electron-chrome-extensions/preload");
  const file = path.join(dir, "chrome-extension-api.preload.sanitized.js");
  const sanitized = sanitizePreloadSource(fs.readFileSync(upstream, "utf8"));
  fs.writeFileSync(file, `${GATE_SOURCE}if (__telarIsExtensionContext) {\n${sanitized}\n}\n`);
  return file;
}

/**
 * The library's main-process `debug` namespaces (`electron-chrome-extensions:*`,
 * including nativeMessaging which formats native message JSON) are forced
 * OFF for this process, whatever DEBUG the environment carries. Negation is
 * appended to the current namespaces so nothing else is affected.
 */
function disableLibraryDebug() {
  const { createRequire } = require("node:module");
  const debug = createRequire(require.resolve("electron-chrome-extensions"))("debug");
  debug.enable([debug.namespaces, "-electron-chrome-extensions:*"].filter(Boolean).join(","));
  if (debug("electron-chrome-extensions:nativeMessaging").enabled) throw new Error("library debug logging could not be disabled");
}

function attachExtensionSupport(session, tabs, options = {}) {
  disableLibraryDebug();
  const { ElectronChromeExtensions } = require("electron-chrome-extensions");
  const existing = ElectronChromeExtensions.fromSession(session);
  if (existing) return existing;
  const extensions = new ElectronChromeExtensions({
    license: options.license || "GPL-3.0",
    session,
    createTab: tabs.createTab,
    selectTab: tabs.selectTab,
    removeTab: tabs.removeTab,
    createWindow: tabs.createWindow,
    removeWindow: tabs.removeWindow,
    assignTabDetails: tabs.assignTabDetails,
  });
  ElectronChromeExtensions.handleCRXProtocol(session);
  // THE APP WINDOW IS KNOWN BEFORE ANY TAB. The library learns windows only
  // through addTab; an extension booting with zero tabs sees
  // windows.getLastFocused() === null and chrome.windows.getCurrent() === null
  // (1Password reads `.id` off it during startup). Register the window now.
  if (options.window) {
    const store = extensions.ctx && extensions.ctx.store;
    if (!store || typeof store.addWindow !== "function") throw new Error("electron-chrome-extensions: cannot register the app window (store.addWindow missing) — library changed; re-verify");
    store.addWindow(options.window);
  }
  // The library registers its noisy preload synchronously in its
  // constructor; re-register the same ids with the sanitized file. Required:
  // without a directory to write it to, the noisy upstream would run.
  if (!options.preloadDir) throw new Error("attachExtensionSupport: preloadDir is required (sanitized preload)");
  const file = sanitizedPreloadPath(options.preloadDir);
  for (const [id, type] of [["crx-mv2-preload", "frame"], ["crx-mv3-preload", "service-worker"]]) {
    try { session.unregisterPreloadScript(id); } catch {}
    session.registerPreloadScript({ id, type, filePath: file });
  }
  const registered = session.getPreloadScripts().filter((s) => s.id === "crx-mv2-preload" || s.id === "crx-mv3-preload");
  if (registered.length !== 2 || registered.some((s) => s.filePath !== file)) throw new Error("sanitized preload was not the one registered");
  return extensions;
}

/**
 * The members 1Password's worker touches that neither Electron nor the
 * library provide. This function is STRINGIFIED and executed in the
 * extension's main world (the same way the library installs its own APIs),
 * before the library's preload freezes `chrome`, and only when the running
 * context's origin is one of `allowedIds`.
 *
 * Honesty rules: a setting whose value is not real reports
 * `levelOfControl: "not_controllable"` and writes REJECT (Chrome's own answer
 * when an extension cannot control a setting); nothing is reported as done
 * that did not happen.
 */
function mainWorldShims(allowedIds) {
  const chrome = globalThis.chrome;
  if (!chrome || !chrome.runtime || typeof chrome.runtime.id !== "string" || !allowedIds.includes(chrome.runtime.id)) return;
  // In a frame the document origin must BE that extension; a page that
  // somehow carried a runtime id is refused.
  try {
    const loc = globalThis.location;
    if (loc && typeof loc.protocol === "string" && loc.protocol !== "" && (loc.protocol !== "chrome-extension:" || loc.host !== chrome.runtime.id)) return;
  } catch {}
  if (Object.isFrozen(chrome)) return; // the library already froze it; the probe reports this

  const define = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { value, configurable: true, writable: true, enumerable: true });
    } catch {}
  };
  const eventSurface = () => {
    const listeners = new Set();
    return {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      hasListener: (fn) => listeners.has(fn),
      hasListeners: () => listeners.size > 0,
    };
  };
  const notControllable = (msg) => {
    const error = new Error(msg);
    return (...args) => {
      const cb = args.find((a) => typeof a === "function");
      if (cb) {
        chrome.runtime.lastError = { message: msg };
        try { cb(); } finally { delete chrome.runtime.lastError; }
        return undefined;
      }
      return Promise.reject(error);
    };
  };

  // chrome.privacy.services.*: there is no Chrome autofill/password manager
  // in this host to control. `get` reports that truthfully; `set`/`clear`
  // are refused the way Chrome refuses a setting the extension cannot control.
  if (!chrome.privacy) {
    const setting = () => ({
      get: (_details, cb) => {
        const r = { value: false, levelOfControl: "not_controllable" };
        cb && cb(r);
        return Promise.resolve(r);
      },
      set: notControllable("This setting is not controllable by this host."),
      clear: notControllable("This setting is not controllable by this host."),
      onChange: eventSurface(),
    });
    const services = {};
    for (const name of ["autofillEnabled", "autofillAddressEnabled", "autofillCreditCardEnabled", "passwordSavingEnabled", "safeBrowsingEnabled", "searchSuggestEnabled", "spellingServiceEnabled", "translationServiceEnabled", "alternateErrorPagesEnabled"]) services[name] = setting();
    define(chrome, "privacy", { services, network: {}, websites: {} });
  }

  // chrome.webRequest: Electron's bindings fail to load in a worker. Provide
  // the event surface so listener registration succeeds; the events do not
  // fire here (Electron's session.webRequest is the interception point, wired
  // separately). 1Password feature-checks onBeforeRedirect and bounds its
  // onHeadersReceived wait to 5 s.
  const wr = Object.assign({}, chrome.webRequest && typeof chrome.webRequest === "object" ? chrome.webRequest : {});
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onAuthRequired", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred", "onActionIgnored"]) {
    if (!wr[name] || typeof wr[name].addListener !== "function") wr[name] = eventSurface();
  }
  if (typeof wr.handlerBehaviorChanged !== "function") wr.handlerBehaviorChanged = (cb) => { cb && cb(); return Promise.resolve(); };
  define(chrome, "webRequest", wr);

  // chrome.tabs.captureVisibleTab: no capture from a worker here; answer as a
  // failed capture (undefined + lastError), never a fake image.
  if (chrome.tabs && typeof chrome.tabs.captureVisibleTab !== "function") {
    const tabs = Object.assign({}, chrome.tabs);
    for (const key of Object.keys(chrome.tabs)) if (tabs[key] === undefined) tabs[key] = chrome.tabs[key];
    tabs.captureVisibleTab = notControllable("captureVisibleTab is not available in this host.");
    define(chrome, "tabs", tabs);
  }

  // chrome.offscreen: not supported; say so.
  if (!chrome.offscreen) {
    define(chrome, "offscreen", {
      Reason: Object.freeze({ TESTING: "TESTING", AUDIO_PLAYBACK: "AUDIO_PLAYBACK", IFRAME_SCRIPTING: "IFRAME_SCRIPTING", DOM_SCRAPING: "DOM_SCRAPING", BLOBS: "BLOBS", DOM_PARSER: "DOM_PARSER", USER_MEDIA: "USER_MEDIA", DISPLAY_MEDIA: "DISPLAY_MEDIA", WEB_RTC: "WEB_RTC", CLIPBOARD: "CLIPBOARD", LOCAL_STORAGE: "LOCAL_STORAGE", WORKERS: "WORKERS", BATTERY_STATUS: "BATTERY_STATUS", MATCH_MEDIA: "MATCH_MEDIA", GEOLOCATION: "GEOLOCATION" }),
      createDocument: notControllable("Offscreen documents are not supported in this host."),
      closeDocument: () => Promise.resolve(),
      hasDocument: () => Promise.resolve(false),
    });
  }

  // chrome.downloads / storage.*.onChanged: the library gives downloads its
  // methods (as no-ops) but no events; Electron's storage areas lack the
  // per-area onChanged. Event surfaces only — nothing is reported as fired.
  if (chrome.downloads && typeof chrome.downloads === "object") {
    const dl = Object.assign({}, chrome.downloads);
    for (const key of Object.keys(chrome.downloads)) if (dl[key] === undefined) dl[key] = chrome.downloads[key];
    for (const name of ["onCreated", "onErased", "onChanged", "onDeterminingFilename"]) if (!dl[name] || typeof dl[name].addListener !== "function") dl[name] = eventSurface();
    define(chrome, "downloads", dl);
  }
  if (chrome.storage && typeof chrome.storage === "object") {
    const st = Object.assign({}, chrome.storage);
    for (const key of Object.keys(chrome.storage)) if (st[key] === undefined) st[key] = chrome.storage[key];
    if (!st.onChanged || typeof st.onChanged.addListener !== "function") st.onChanged = eventSurface();
    for (const area of ["local", "sync", "session", "managed"]) {
      const a = st[area];
      if (a && typeof a === "object" && (!a.onChanged || typeof a.onChanged.addListener !== "function")) {
        const copy = Object.assign({}, a);
        for (const key of Object.keys(a)) if (copy[key] === undefined) copy[key] = a[key];
        for (const key of ["get", "set", "remove", "clear", "getBytesInUse", "setAccessLevel"]) if (typeof a[key] === "function" && copy[key] === undefined) copy[key] = a[key].bind(a);
        copy.onChanged = eventSurface();
        st[area] = copy;
      }
    }
    define(chrome, "storage", st);
  }

  // The "browser" alias: WebExtension-style code calls browser.action /
  // browser.commands. Electron's "browser" object misses members the
  // library adds on "chrome" (browser.commands has no onCommand). Two-level
  // fall-through: namespace, then member.
  // PRIORITY IS chrome FIRST. The library replaces chrome.runtime (its
  // connectNative spawns the registered native host), chrome.tabs, windows…
  // by redefining members on `chrome` only; Electron's own `browser` keeps
  // Electron's stubs — its runtime.connectNative fails with "disabled by
  // the system administrator". 1Password calls browser.runtime.connectNative,
  // so a browser alias that preferred its own members would route the
  // desktop-app connection to the stub. Read lazily: chrome[ns] is looked up
  // at call time, after the library's factories have run.
  const own = globalThis.browser;
  if (own !== chrome) {
    const mergeNs = (preferred, fallback) => {
      if (!(preferred && typeof preferred === "object" && fallback && typeof fallback === "object")) return preferred !== undefined ? preferred : fallback;
      return new Proxy(preferred, {
        get: (t, k) => { const v = t[k]; return v !== undefined ? (typeof v === "function" ? v.bind(t) : v) : (typeof fallback[k] === "function" ? fallback[k].bind(fallback) : fallback[k]); },
        has: (t, k) => k in t || k in fallback,
      });
    };
    const merged = new Proxy(own && typeof own === "object" ? own : {}, {
      get: (target, key) => mergeNs(chrome[key], target[key]),
      has: (target, key) => key in chrome || key in target,
    });
    define(globalThis, "browser", merged);
  }
  globalThis.__telarCrxShims = true;
}

/**
 * Register the shim preload for frames AND service workers. Registered
 * BEFORE the library's own preloads (call this before attachExtensionSupport)
 * so it runs before `Object.freeze(chrome)`. Uses the same
 * `contextBridge.executeInMainWorld` route the library uses, so the shims
 * land in the extension's main world rather than the isolated preload world.
 */
function registerShimPreload(session, dir, allowedIds) {
  const source = `${GATE_SOURCE}
const { contextBridge } = require("electron");
const allowedIds = ${JSON.stringify(allowedIds)};
const diag = { protocol: null, host: null, hasExecute: "executeInMainWorld" in contextBridge, applied: false, error: null, via: null, gated: !__telarIsExtensionContext };
// A frame has a location; a service-worker preload does NOT (Electron gives
// it none), so the origin is read from the worker's own registration scope
// or, failing that, the extension id the isolated world's chrome.runtime
// carries. Only the pinned ids pass, whichever route answered.
try { diag.protocol = globalThis.location?.protocol ?? null; diag.host = globalThis.location?.host ?? null; diag.via = diag.host ? "location" : null; } catch {}
if (!diag.host) {
  try {
    const scope = globalThis.registration?.scope || globalThis.self?.registration?.scope;
    if (typeof scope === "string") { const u = new URL(scope); diag.protocol = u.protocol; diag.host = u.host; diag.via = "registration"; }
  } catch {}
}
if (!diag.host) {
  try {
    const id = globalThis.chrome?.runtime?.id;
    if (typeof id === "string" && id) { diag.protocol = "chrome-extension:"; diag.host = id; diag.via = "runtime.id"; }
  } catch {}
}
// A CONTEXT THAT NAMED ITSELF AND IS NOT AN EXTENSION IS SKIPPED (#487); a
// context that named nothing still runs, because on this Electron a service
// worker's isolated world names nothing and one of those is 1Password's own.
// For everything that gets through, THE REAL GATE IS THE MAIN WORLD's:
// mainWorldShims refuses every context whose chrome.runtime.id is not pinned
// (ordinary pages have none) and any frame whose location origin disagrees
// with that id.
try {
  if (diag.hasExecute && __telarIsExtensionContext) { contextBridge.executeInMainWorld({ func: ${mainWorldShims.toString()}, args: [allowedIds] }); diag.applied = true; }
} catch (error) {
  diag.error = String(error && error.message);
}
// Diagnostics only: which context this preload saw, and whether it applied.
// No payloads, no page content. probe lists what the isolated world has.
try {
  diag.probe = {
    self: typeof self, location: typeof location, registration: typeof registration, chrome: typeof chrome, chromeRuntimeId: typeof chrome !== "undefined" ? typeof chrome?.runtime?.id : "n/a",
    processType: typeof process !== "undefined" ? process.type : "n/a", contextIsolated: typeof process !== "undefined" ? process.contextIsolated : "n/a",
    serviceWorkerScope: typeof self !== "undefined" && self.serviceWorker ? self.serviceWorker.scriptURL : null,
    globals: Object.getOwnPropertyNames(globalThis).filter((k) => /extension|crx|chrome|browser|worker|registration|scope|origin/i.test(k)).slice(0, 20),
  };
} catch (error) { diag.probeError = String(error && error.message); }
console.info("telar-crx-shims " + JSON.stringify(diag));
`;
  const file = path.join(dir, "telar-extension-shims.preload.js");
  fs.writeFileSync(file, source);
  session.registerPreloadScript({ id: "telar-crx-shims-sw", type: "service-worker", filePath: file });
  session.registerPreloadScript({ id: "telar-crx-shims-frame", type: "frame", filePath: file });
  return file;
}

module.exports = { verifyCrx, unpackVerified, attachExtensionSupport, registerShimPreload, mainWorldShims, sanitizePreloadSource, sanitizedPreloadPath, isExtensionPreloadContext, disableLibraryDebug };
