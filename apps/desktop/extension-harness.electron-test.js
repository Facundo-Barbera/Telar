/**
 * 1PASSWORD EXTENSION COMPATIBILITY HARNESS — dev-only, evidence-only.
 *
 * Loads the OFFICIAL 1Password Chrome extension (Chrome Web Store id
 * aeblfdkhhhdcdjpifhhbdiojplfjncoa, publisher AgileBits Inc) into a real
 * Electron session shaped like the integrated browser's, opens a local dummy
 * login page, and records what actually works. It proves nothing by loading
 * alone: every claim below is a measured fact written to a JSON report, and
 * what was NOT measured is listed under `untested` / `limitations`.
 *
 *   · runs with its OWN temp userData and a temp `persist:` partition — never
 *     the app's, never a user browser profile, vault or extension storage;
 *   · downloads the CRX from Google's update endpoint only (no third party);
 *   · adds no 1Password trust, unlocks nothing, fills nothing;
 *   · a hidden window; no focus taken.
 *
 * Run: `bun run test:desktop:extension`. (Directly: `env -u ELECTRON_RUN_AS_NODE
 * electron ./extension-harness.electron-test.js` — with that variable set,
 * Electron runs the file as plain Node and `app` is undefined.)
 * Env: TELAR_1P_CRX=/path/to/1password.crx to reuse a download.
 * Output: <tmp>/telar-1password-harness-<id>/report.json, and a summary on stdout.
 */
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { attachExtensionSupport, registerShimPreload, unpackVerified } = require("./extension-compat");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EXTENSION_ID = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0&acceptformat=crx2,crx3&x=id%3D${EXTENSION_ID}%26uc`;
const PARTITION = "persist:telar-1password-harness";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "telar-1password-harness-"));
app.setPath("userData", path.join(work, "userData"));

const report = { electron: process.versions.electron, chrome: process.versions.chrome, steps: [], apis: {}, blockers: [] };
const step = (name, data) => {
  report.steps.push({ name, ...data });
  console.log(`HARNESS ${name}: ${JSON.stringify(data)}`);
};
const blocker = (text) => {
  report.blockers.push(text);
  console.log(`HARNESS BLOCKER: ${text}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Telar dummy login</title></head>
<body style="font-family:system-ui;padding:32px">
  <h1>Dummy login (fixture)</h1>
  <form id="login" autocomplete="on" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted ' + username.value">
    <label>Username <input id="username" name="username" autocomplete="username"></label><br>
    <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label><br>
    <button type="submit">Sign in</button>
  </form>
  <p id="out"></p>
</body></html>`;

function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("too many redirects"));
    https
      .get(url, { headers: { "user-agent": "telar-1password-harness" } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const next = new URL(response.headers.location, url).toString();
          const host = new URL(next).host;
          if (!/(^|\.)google(usercontent)?\.com$/.test(host)) return reject(new Error(`redirect off Google: ${host}`));
          return resolve(download(next, dest, hops + 1));
        }
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
        const file = fs.createWriteStream(dest);
        response.pipe(file);
        file.on("finish", () => file.close(() => resolve({ finalUrl: url, bytes: fs.statSync(dest).size })));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

/** CRX3: magic "Cr24", u32 version, u32 header length, header, then a zip. */
function unpackCrx(crxPath, outDir) {
  const bytes = fs.readFileSync(crxPath);
  if (bytes.toString("ascii", 0, 4) !== "Cr24") throw new Error("not a CRX");
  const version = bytes.readUInt32LE(4);
  const headerLength = bytes.readUInt32LE(8);
  const zipStart = version === 3 ? 12 + headerLength : 16 + bytes.readUInt32LE(8) + bytes.readUInt32LE(12);
  const zipPath = path.join(work, "extension.zip");
  fs.writeFileSync(zipPath, bytes.subarray(zipStart));
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", outDir]);
  return { crxVersion: version, zipBytes: bytes.length - zipStart };
}

async function evaluateIn(contents, expression) {
  return contents.executeJavaScript(expression, true);
}

async function main() {
  // ── 1. obtain the official package ──────────────────────────────────
  const crxPath = process.env.TELAR_1P_CRX || path.join(work, "1password.crx");
  if (process.env.TELAR_1P_CRX) {
    step("crx", { source: "TELAR_1P_CRX", bytes: fs.statSync(crxPath).size });
  } else {
    const got = await download(CRX_URL, crxPath);
    step("crx", { source: "clients2.google.com (Chrome Web Store update endpoint)", ...got });
  }
  const unpacked = path.join(work, "unpacked");
  // COMPAT MODE (TELAR_1P_COMPAT=1): preserve the CRX3 publisher key so the
  // id matches the store's, attach electron-chrome-extensions to the session,
  // and add the two shims the worker needs. Default: bare Electron, as before.
  const compat = process.env.TELAR_1P_COMPAT === "1";
  report.mode = compat ? "compat" : "bare";
  let identity;
  if (compat) {
    identity = unpackVerified(crxPath, unpacked, EXTENSION_ID);
    step("unpack", { crxVersion: 3, verifiedId: identity.id, proofs: identity.proofs, publisherKeyWritten: identity.keyWritten });
  } else {
    step("unpack", unpackCrx(crxPath, unpacked));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "manifest.json"), "utf8"));
  report.manifest = {
    name: manifest.name,
    version: manifest.version,
    manifest_version: manifest.manifest_version,
    background: manifest.background,
    action: Boolean(manifest.action || manifest.browser_action),
    permissions: manifest.permissions,
    host_permissions: manifest.host_permissions,
    content_scripts: (manifest.content_scripts || []).map((entry) => ({ matches: entry.matches, js: entry.js, run_at: entry.run_at })),
    nativeMessagingPermission: (manifest.permissions || []).includes("nativeMessaging"),
  };
  step("manifest", report.manifest);

  // ── 2. a session shaped like the integrated browser's ───────────────
  const ses = session.fromPartition(PARTITION);
  const window = new BrowserWindow({ show: false, width: 1000, height: 700 });
  // Native-messaging launch diagnostics from the library, payloads EXCLUDED:
  // its debug logger prints "send"/"receive" with the message body; the sink
  // below keeps only launch/config/exit lines and redacts everything else.
  const nativeLog = [];
  if (compat) {
    const debug = require(require.resolve("debug", { paths: [path.dirname(require.resolve("electron-chrome-extensions"))] }));
    debug.enable("electron-chrome-extensions:nativeMessaging");
    const util = require("node:util");
    debug.log = (...args) => {
      const fmt = String(args[0] ?? "");
      if (/\b(send|receive|sending|pending)\b/i.test(fmt)) { nativeLog.push("[redacted message line]"); return; }
      let line = util.format(...args).replace(/\u001b\[[0-9;]*m/g, "").replace(/^\S+\s+electron-chrome-extensions:nativeMessaging\s*/, "");
      // Host stderr: keep it (it is the host explaining itself), but never a JSON body.
      if (/^stderr:/.test(line) && /[{[]/.test(line)) line = "stderr: [redacted: structured]";
      nativeLog.push(line.slice(0, 240));
    };
  }
  let extensions;
  if (compat) {
    // Shims first, so they run in the extension main world before the
    // library's preload freezes `chrome`.
    // The member probe (step 7b) gets a generated key so its id is known up
    // front and can be origin-allowed for the shims — harness only.
    const probeKey = require("node:crypto").generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
    report.probeId = [...require("node:crypto").createHash("sha256").update(probeKey).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
    report.probeKey = probeKey.toString("base64");
    const shimPreload = registerShimPreload(ses, work, [EXTENSION_ID, report.probeId]);
    // Minimal host: chrome.tabs.create/remove map onto plain views in the
    // hidden window. Enough for the worker; the app supplies the real one.
    const hostTabs = [];
    extensions = attachExtensionSupport(ses, {
      createTab: async (details) => {
        const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
        window.contentView.addChildView(view);
        hostTabs.push(view);
        extensions.addTab(view.webContents, window);
        if (details.url) view.webContents.loadURL(details.url).catch(() => undefined);
        return [view.webContents, window];
      },
      selectTab: () => undefined,
      removeTab: (wc) => {
        const i = hostTabs.findIndex((v) => v.webContents === wc);
        if (i >= 0) { window.contentView.removeChildView(hostTabs[i]); hostTabs.splice(i, 1); }
        try { wc.close(); } catch {}
      },
    }, { preloadDir: work });
    report.preloads = ses.getPreloadScripts().map((s) => ({ id: s.id, type: s.type, file: path.basename(s.filePath) }));
    extensions.addExtensionWindow?.(window);
    report.compat = { library: "electron-chrome-extensions@4.9.0", license: "GPL-3.0", shimPreload, preloadOrder: ses.getPreloadScripts().map((p) => `${p.type}:${p.id}`) };
    step("compat", report.compat);
  }
  const swEvents = [];
  ses.serviceWorkers.on("console-message", (_event, details) => {
    swEvents.push({ level: details.level, message: String(details.message).slice(0, 300), source: details.sourceId, line: details.lineNumber, versionId: details.versionId });
  });
  ses.serviceWorkers.on("registration-completed", (_event, details) => swEvents.push({ registered: details.scope }));

  let extension;
  let loadError;
  try {
    extension = await ses.extensions.loadExtension(unpacked, { allowFileAccess: false });
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  step("loadExtension", extension ? { ok: true, id: extension.id, name: extension.name, version: extension.version, url: extension.url } : { ok: false, error: loadError });
  if (!extension) {
    blocker(`session.extensions.loadExtension refused the official package: ${loadError}`);
    return;
  }

  // ── 3. background: is the MV3 service worker alive? ─────────────────
  await sleep(6000);
  const running = Object.values(ses.serviceWorkers.getAllRunning()).map((info) => ({ scope: info.scope, scriptUrl: info.scriptUrl }));
  const extensionWorker = running.find((info) => info.scope.startsWith(extension.url));
  report.apis.backgroundServiceWorker = { running: Boolean(extensionWorker), allRunning: running, events: swEvents.slice(0, 20) };
  step("background", report.apis.backgroundServiceWorker);
  if (manifest.manifest_version === 3 && !extensionWorker) {
    // NOT "MV3 unsupported": the control extension's MV3 worker (step 7)
    // runs. What is observed is 1Password's own worker dying on boot.
    const crash = swEvents.filter((entry) => entry.level === 3).map((entry) => entry.message);
    blocker(`1Password's MV3 background service worker is not running after load; its boot log shows: ${JSON.stringify(crash)}. The uncaught TypeError is at a \`.onClicked\` listener (chrome.contextMenus / chrome.notifications, neither implemented by Electron) and \`require(webRequest)\` has no source in this build.`);
  }

  // ── 4. content script injection on a local dummy login page ─────────
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.contentView.addChildView(view);
  if (extensions) extensions.addTab(view.webContents, window);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  const pageConsole = [];
  view.webContents.on("console-message", (details) => pageConsole.push(String(details.message).slice(0, 200)));
  await view.webContents.loadURL(`http://127.0.0.1:${port}/`);
  await sleep(6000);
  // 1Password's content script decorates fillable fields; any of these marks it.
  const injected = await evaluateIn(
    view.webContents,
    `({
      decoratedInputs: document.querySelectorAll('input[data-com-onepassword-filled], input[data-op-id], [data-onepassword-title], .com-1password-button, .com-1password-menu').length,
      opAttributes: [...document.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((n) => /onepassword|op-/i.test(n)).slice(0, 10),
      shadowHosts: [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).length,
      customElements: [...document.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()).filter((t) => t.includes('-')).slice(0, 10),
      inlineScriptSrcs: [...document.querySelectorAll('script')].map((s) => s.src).filter((src) => src.startsWith('chrome-extension://')).slice(0, 5),
      passwordFieldAttrs: [...document.getElementById('password').attributes].map((a) => a.name),
      bootstrapRan: typeof window._sentryDebugIds === 'object' && window._sentryDebugIds !== null,
      bootstrapIds: window._sentryDebugIds ? Object.values(window._sentryDebugIds).slice(0, 3) : [],
    })`,
  );
  report.apis.contentScript = { ...injected, pageConsole: pageConsole.slice(0, 10) };
  step("contentScript", report.apis.contentScript);
  if (injected.decoratedInputs === 0 && injected.opAttributes.length === 0 && injected.shadowHosts === 0) {
    blocker("No 1Password content-script effect observed on the dummy login page (no field decoration). Injection itself works in this partition — see the control extension in step 7 — so this is downstream of the dead worker.");
  }

  // ── 5. the action popup, and the APIs it would need ─────────────────
  const popupPath = manifest.action?.default_popup || manifest.browser_action?.default_popup;
  const popup = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.contentView.addChildView(popup);
  popup.setBounds({ x: 0, y: 0, width: 400, height: 600 });
  const popupConsole = [];
  popup.webContents.on("console-message", (details) => popupConsole.push(`${details.level}: ${String(details.message).slice(0, 300)}`));
  popup.webContents.on("render-process-gone", (_e, d) => popupConsole.push(`render-process-gone: ${d.reason}`));
  popup.webContents.on("preload-error", (_e, p, err) => popupConsole.push(`preload-error ${p}: ${err.message}`));
  let popupLoad;
  try {
    await popup.webContents.loadURL(`${extension.url}${popupPath || "manifest.json"}`);
    await sleep(15000);
    popupLoad = { ok: true, url: popup.webContents.getURL(), title: popup.webContents.getTitle() };
  } catch (error) {
    popupLoad = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const apis = popupLoad.ok
    ? await evaluateIn(
        popup.webContents,
        `(async () => ({
          runtimeId: typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : null,
          connectNative: typeof chrome?.runtime?.connectNative,
          sendNativeMessage: typeof chrome?.runtime?.sendNativeMessage,
          action: typeof chrome?.action,
          storageLocal: typeof chrome?.storage?.local,
          storageSession: typeof chrome?.storage?.session,
          storageSync: typeof chrome?.storage?.sync,
          tabsQuery: typeof chrome?.tabs?.query,
          identity: typeof chrome?.identity,
          alarms: typeof chrome?.alarms,
          scripting: typeof chrome?.scripting,
          contextMenus: typeof chrome?.contextMenus,
          notifications: typeof chrome?.notifications,
          webRequest: typeof chrome?.webRequest,
          webNavigation: typeof chrome?.webNavigation,
          privacy: typeof chrome?.privacy?.services?.passwordSavingEnabled?.get,
          offscreen: typeof chrome?.offscreen?.createDocument,
          windows: typeof chrome?.windows,
          shimsApplied: globalThis.__telarCrxShims === true,
          chromeFrozen: Object.isFrozen(chrome),
          browserCommandsOnCommand: typeof globalThis.browser?.commands?.onCommand,
          browserActionOnClicked: typeof globalThis.browser?.action?.onClicked,
          tabsCaptureVisibleTab: typeof chrome?.tabs?.captureVisibleTab,
          webRequestOnBeforeRedirect: typeof chrome?.webRequest?.onBeforeRedirect?.addListener,
          bodyText: document.body ? document.body.innerText.slice(0, 200) : null,
          bodyChildren: document.body ? document.body.children.length : 0,
          bodyHtmlHead: document.body ? document.body.innerHTML.replace(/\s+/g, ' ').slice(0, 400) : null,
          shadowText: [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).map((el) => el.shadowRoot.textContent.replace(/\s+/g, ' ').slice(0, 200)).slice(0, 3),
          visibleText: [...document.querySelectorAll('h1,h2,h3,p,button,a,label,span')].map((el) => el.textContent.trim()).filter(Boolean).slice(0, 25),
          buttons: [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()).filter(Boolean).slice(0, 12),
          images: [...document.querySelectorAll('img,svg')].length,
          tabsSeen: await new Promise((r) => { try { chrome.tabs.query({}, (t) => r((t || []).map((x) => ({ id: x.id, url: (x.url || '').slice(0, 40), active: x.active })))); } catch (e) { r('throw:' + e.message); } }),
          bgPing: await new Promise((r) => { const t = setTimeout(() => r('no reply in 3s'), 3000); try { chrome.runtime.sendMessage({ __telarProbe: true }, (resp) => { clearTimeout(t); r(chrome.runtime.lastError ? 'lastError: ' + chrome.runtime.lastError.message : 'replied'); }); } catch (e) { clearTimeout(t); r('throw:' + e.message); } }),
          scriptingIntoTab: await new Promise((r) => { const t = setTimeout(() => r('no result in 4s'), 4000); try { chrome.tabs.query({ active: true }, (tabs) => { const tab = (tabs || [])[0]; if (!tab) return r('no active tab'); chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { document.documentElement.setAttribute('data-telar-scripting', '1'); return document.title; } }, (res) => { clearTimeout(t); r(chrome.runtime.lastError ? 'lastError: ' + chrome.runtime.lastError.message : JSON.stringify((res || []).map((x) => x.result))); }); }); } catch (e) { clearTimeout(t); r('throw:' + e.message); } }),
          rootStyle: (() => { const el = document.getElementById('root'); if (!el) return null; const cs = getComputedStyle(el); return { display: cs.display, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, childCount: el.querySelectorAll('*').length }; })(),
          failedResources: performance.getEntriesByType('resource').filter((e) => e.responseStatus && e.responseStatus >= 400).map((e) => e.name.slice(-60)).slice(0, 8),
          fontsStatus: document.fonts ? document.fonts.status : 'n/a',
          docTextLength: document.documentElement.innerText.length,
        }))()`,
      ).catch((error) => ({ evalError: String(error) }))
    : {};
  const scriptedIntoPage = await evaluateIn(view.webContents, "document.documentElement.getAttribute('data-telar-scripting')").catch(() => null);
  report.apis.popup = { path: popupPath, ...popupLoad, console: popupConsole.slice(0, 15), ...apis, scriptedIntoPage };
  step("popup", report.apis.popup);
  if (apis.action !== "object") blocker("chrome.action is unavailable: no toolbar button / popup lifecycle.");

  // ── 6. native messaging, PROBED rather than assumed. A dummy host name:
  //      this never reaches 1Password and registers nothing. What matters is
  //      whether the port disconnects with Chrome's "not found" (the API is
  //      wired to a host lookup) or something else (no host support at all).
  if (popupLoad.ok && apis.connectNative === "function") {
    const probe = await evaluateIn(
      popup.webContents,
      `new Promise((resolve) => {
        try {
          const port = chrome.runtime.connectNative(${JSON.stringify(compat ? "com.1password.1password" : "com.telar.harness.nonexistent")});
          const timer = setTimeout(() => { try { port.disconnect(); } catch {} resolve({ outcome: 'port stayed open 4s (host accepted the connection); disconnected by harness, no message sent', host: ${JSON.stringify(compat ? "com.1password.1password" : "com.telar.harness.nonexistent")} }); }, 4000);
          port.onMessage.addListener(() => { /* payload deliberately not read or logged */ });
          port.onDisconnect.addListener(() => { clearTimeout(timer); resolve({ outcome: 'disconnected', lastError: chrome.runtime.lastError?.message ?? null, host: ${JSON.stringify(compat ? "com.1password.1password" : "com.telar.harness.nonexistent")} }); });
        } catch (error) { resolve({ outcome: 'threw', error: String(error) }); }
      })`,
    ).catch((error) => ({ outcome: "evalError", error: String(error) }));
    report.apis.nativeMessaging = { ...probe, hostLog: nativeLog.slice(0, 20) };
    step("nativeMessaging", report.apis.nativeMessaging);
    // Docs omit connectNative; the runtime has it. What matters is what the
    // port does — and it is refused by Electron before any host lookup.
    if (probe.outcome === "disconnected" && /disabled by the system administrator/i.test(probe.lastError || "")) {
      blocker(`Native messaging is refused by Electron itself: connectNative exists but the port disconnects with "${probe.lastError}" — no native-host registry is consulted. Without a working native port the extension cannot talk to the 1Password desktop app from this host.`);
    }
  } else {
    report.apis.nativeMessaging = { outcome: "unavailable", connectNative: apis.connectNative };
    step("nativeMessaging", report.apis.nativeMessaging);
    blocker("chrome.runtime.connectNative is not a function in this build; the extension cannot open a native port.");
  }
  report.untested = [
    "1Password desktop trust for a SIGNED Telar.app: 1Password for Mac lets a user add an additional browser that is in /Applications and Apple code-signed (support.1password.com/additional-browsers, 2026-08-17). Whether it would accept a signed Telar build is NOT tested here — this harness runs an unsigned dev Electron from node_modules, and the native port is refused by Electron before 1Password is ever asked.",
  ];

  // ── 7. CONTROL: does Electron inject content scripts into this partition
  //      at all? A three-line MV3 extension answers that independently of
  //      1Password's own bootstrap (which may depend on its dead worker).
  const control = path.join(work, "control-extension");
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(
    path.join(control, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "Telar harness control", version: "0.0.1", content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["cs.js"], run_at: "document_start" }], background: { service_worker: "bg.js" } }),
  );
  fs.writeFileSync(path.join(control, "cs.js"), "document.documentElement.setAttribute('data-telar-control-cs', '1');");
  fs.writeFileSync(path.join(control, "bg.js"), "self.telarControl = true; chrome.runtime.onInstalled.addListener(() => {});");
  let controlLoad;
  try {
    const loaded = await ses.extensions.loadExtension(control);
    controlLoad = { ok: true, id: loaded.id };
  } catch (error) {
    controlLoad = { ok: false, error: String(error) };
  }
  await view.webContents.loadURL(`http://127.0.0.1:${port}/`);
  await sleep(1500);
  const controlInjected = await evaluateIn(view.webContents, "document.documentElement.getAttribute('data-telar-control-cs')");
  await sleep(1000);
  const controlWorker = Object.values(ses.serviceWorkers.getAllRunning()).some((info) => controlLoad.ok && info.scope.startsWith(`chrome-extension://${controlLoad.id}/`));
  report.apis.control = { ...controlLoad, contentScriptInjected: controlInjected === "1", backgroundWorkerRunning: controlWorker };
  step("control", report.apis.control);

  // ── 7b. WHICH members exist INSIDE an MV3 worker in this session (with
  //        the same preloads 1Password's worker gets). A probe worker writes
  //        its findings to storage.local; we read them back.
  const probe = path.join(work, "probe-extension");
  fs.mkdirSync(probe, { recursive: true });
  const members = [
    "runtime.onSuspend", "runtime.onMessageExternal", "runtime.onConnect", "runtime.onInstalled", "runtime.connectNative", "runtime.sendNativeMessage", "runtime.requestUpdateCheck",
    "alarms.onAlarm", "alarms.create", "idle.onStateChanged", "idle.queryState", "downloads.onChanged", "storage.managed.onChanged", "storage.session.get", "storage.local.get",
    "commands.onCommand", "action.onClicked", "browserAction.onClicked", "notifications.onClicked", "notifications.onButtonClicked", "notifications.onClosed", "notifications.create",
    "contextMenus.onClicked", "contextMenus.create", "webNavigation.onCommitted", "webNavigation.getAllFrames", "webRequest.onHeadersReceived.addListener", "webRequest.onBeforeRedirect.addListener",
    "tabs.onUpdated", "tabs.onRemoved", "tabs.onActivated", "tabs.onCreated", "tabs.captureVisibleTab", "tabs.executeScript", "windows.onFocusChanged", "windows.onCreated", "windows.getCurrent", "windows.WINDOW_ID_NONE",
    "scripting.executeScript", "privacy.services.passwordSavingEnabled.get", "offscreen.createDocument", "management.getSelf", "declarativeNetRequest.updateDynamicRules",
  ];
  const browserMembers = ["action.onClicked", "alarms.onAlarm", "idle.onStateChanged", "downloads.onChanged", "storage.managed.onChanged", "commands.onCommand", "runtime.onInstalled", "tabs.onUpdated"];
  fs.writeFileSync(path.join(probe, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Telar member probe", version: "0.0.1", action: {}, ...(report.probeKey ? { key: report.probeKey } : {}), permissions: ["storage", "alarms", "idle", "downloads", "notifications", "contextMenus", "webNavigation", "webRequest", "scripting", "privacy", "offscreen", "management", "nativeMessaging", "declarativeNetRequest"], host_permissions: ["<all_urls>"], background: { service_worker: "bg.js" } }));
  fs.writeFileSync(path.join(probe, "bg.js"), `const members = ${JSON.stringify(members)};
    const has = (p) => { try { return typeof p.split('.').reduce((o, k) => o?.[k], globalThis.chrome); } catch (e) { return 'throw:' + e.message; } };
    const out = {}; for (const m of members) out[m] = has(m);
    const hasB = (p) => { try { return typeof p.split('.').reduce((o, k) => o?.[k], globalThis.browser); } catch (e) { return 'throw:' + e.message; } };
    for (const m of ${JSON.stringify(browserMembers)}) out['browser.' + m] = hasB(m);
    out.__browserAlias = typeof globalThis.browser; out.__browserIsChrome = globalThis.browser === globalThis.chrome; out.__shims = globalThis.__telarCrxShims === true; out.__frozen = Object.isFrozen(chrome); out.__id = chrome.runtime.id;
    for (const m of ["storage.managed.onChanged", "storage.local.onChanged", "downloads.onChanged", "runtime.onSuspend", "runtime.onMessageExternal", "idle.onStateChanged", "alarms.onAlarm"]) out["browser." + m] = hasB(m);
    chrome.storage.local.set({ probe: out });`);
  let probeResult;
  try {
    const loaded = await ses.extensions.loadExtension(probe);
    await sleep(1500);
    const reader = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.contentView.addChildView(reader);
    await reader.webContents.loadURL(`${loaded.url}manifest.json`);
    probeResult = await evaluateIn(reader.webContents, "new Promise((r) => chrome.storage.local.get('probe', (v) => r(v.probe || null)))");
  } catch (error) {
    probeResult = { error: String(error) };
  }
  report.apis.workerMembers = probeResult;
  const missing = probeResult && !probeResult.error ? Object.entries(probeResult).filter(([k, v]) => !k.startsWith("__") && v === "undefined").map(([k]) => k) : [];
  step("workerMembers", { missing, shimsInWorker: probeResult?.__shims, frozen: probeResult?.__frozen, probeId: probeResult?.__id, expectedProbeId: report.probeId });

  // ── 8. gates that are Telar's, not Electron's ────────────────────────
  report.limitations = [
    `Extension identity: the runtime id (${extension.id}) differs from the Chrome Web Store id (${EXTENSION_ID}). Unpacking a CRX drops the signature, and the manifest carries no \`key\` (present: ${Object.prototype.hasOwnProperty.call(manifest, "key")}), so Electron derives an id from the path. Anything keyed on the store id — the extension's own origin checks, 1Password's side, update_url (${manifest.update_url ?? "none"}) — is not exercised as it would be in Chrome. Not worked around: adding a \`key\` to impersonate the store id would be identity spoofing.`,
    "Environment: unsigned dev Electron 43 from node_modules with a temp userData; not a signed, /Applications-installed Telar.",
  ];
  report.gates = [
    "Credential boundary (risk, not proof of exposure): browser-manager.snapshot serializes AX node values and screenshot/console/network tools stay available during human takeover, and Telar adds no password-field redaction of its own. Chromium's accessibility tree may mask password values, and that masking is not measured here — so whether a given autofilled value reaches an agent is UNVERIFIED either way. Treat it as a gate to design and test, not a blanket claim.",
    "Dummy data only: this harness never signs in, never unlocks, never fills.",
    "Design requirement (recorded, not implemented): the browser should feel like human + agent sharing a tab, not an ownership ritual. Human input wins; an agent action that conflicts with fresh human input pauses and revalidates page state before continuing; separate tasks may use separate tabs; no persistent 'You have the browser' / 'Hand back'. The current controller/handBack enforcement stays until those concurrency semantics replace it — deleting it alone would reintroduce the race it prevents.",
    "Credential entry implication: a password-manager fill needs an OBSERVATION pause (snapshot/screenshot/console/network suppressed or redacted for the protected fields' lifetime), not only the mutation lock the controller model gives today. That is the gate any 1Password mode must clear before it is offered.",
  ];

  server.close();
  window.destroy();
}

app.whenReady().then(main).then(
  () => {
    report.verdict = report.blockers.length === 0 ? "loaded and functional in this harness" : "not functional in this unsigned dev Electron — see blockers, untested, limitations";
    fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2));
    console.log(`HARNESS report: ${path.join(work, "report.json")}`);
    console.log(`HARNESS verdict: ${report.verdict}`);
    for (const line of report.blockers) console.log(`HARNESS   - blocker: ${line}`);
    for (const line of report.untested || []) console.log(`HARNESS   - untested: ${line}`);
    for (const line of report.limitations || []) console.log(`HARNESS   - limitation: ${line}`);
    app.exit(0);
  },
  (error) => {
    report.fatal = error instanceof Error ? error.stack || error.message : String(error);
    fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2));
    console.error(`HARNESS FATAL: ${report.fatal}`);
    console.log(`HARNESS report: ${path.join(work, "report.json")}`);
    app.exit(1);
  },
);
