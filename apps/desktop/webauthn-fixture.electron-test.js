/**
 * PASSKEY REPRODUCTION — does 1Password's WebAuthn interception install in
 * this Electron? Measured, not assumed:
 *
 *   A. Is the manifest content script declared `"world": "MAIN"`
 *      (inline/injected/webauthn-listeners.js) actually running in the
 *      PAGE's main world? Its hook redefines `navigator.credentials.get`
 *      and `PublicKeyCredential.getClientCapabilities` as OWN accessor
 *      properties (defineProperty with get/set) — normally these live on
 *      the prototype. Own-descriptor shape is the probe; no values read.
 *   B. Is the isolated-world half (webauthn.js) present? It listens for
 *      window "message" and replies to the MAIN half's syn with syn-ack.
 *      We do not send 1Password's messages; we only check the listener
 *      count is not zero via a no-op probe is impossible without payloads,
 *      so B is inferred from A + the content-script list Electron reports.
 *   C. Baseline: what does Chromium's OWN WebAuthn do here for a get()
 *      with a random challenge on a localhost RP — resolve, reject (name),
 *      or hang past 4 s? Classification only.
 *
 * No pairing, no vault, no real site. Fixture: http://localhost:<port>/
 * (1Password's script matches http://localhost/*).
 *
 *   TELAR_1P_CRX=<crx> env -u ELECTRON_RUN_AS_NODE electron ./webauthn-fixture.electron-test.js
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { attachExtensionSupport, registerShimPreload, unpackVerified } = require("./extension-compat");
const { ONE_PASSWORD } = require("./extension-host");

const PARTITION = "persist:telar-webauthn-fixture";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FIXTURE = `<!doctype html><title>WebAuthn fixture</title><h1>WebAuthn fixture</h1><input autocomplete="username webauthn">`;

const PROBE = `(() => {
  const own = (obj, key) => { const d = obj && Object.getOwnPropertyDescriptor(obj, key); return d ? { own: true, accessor: typeof d.get === "function", configurable: d.configurable } : { own: false }; };
  return {
    credentialsGet: own(navigator.credentials, "get"),
    credentialsCreate: own(navigator.credentials, "create"),
    pkcGetClientCapabilities: own(window.PublicKeyCredential, "getClientCapabilities"),
    pkcIsUVPAA: own(window.PublicKeyCredential, "isUserVerifyingPlatformAuthenticatorAvailable"),
    hasPublicKeyCredential: typeof window.PublicKeyCredential === "function",
    hasCredentials: typeof navigator.credentials === "object",
  };
})()`;

const BASELINE = `(async () => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const timeout = new Promise((r) => setTimeout(() => r({ outcome: "hang>4s" }), 4000));
  const call = navigator.credentials.get({ publicKey: { challenge, rpId: "localhost", timeout: 3000, userVerification: "preferred", allowCredentials: [] } })
    .then(() => ({ outcome: "resolved" }), (e) => ({ outcome: "rejected", name: e && e.name, messageClass: /not allowed|cancel/i.test(String(e && e.message)) ? "not-allowed/cancelled" : "other" }));
  return Promise.race([call, timeout]);
})()`;

async function main() {
  const crx = process.env.TELAR_1P_CRX;
  if (!crx || !fs.existsSync(crx)) throw new Error("TELAR_1P_CRX must point at the cached official package");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "telar-webauthn-"));
  const note = (line) => console.log(`WEBAUTHN ${line}`);
  const report = {};

  const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(FIXTURE); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://localhost:${server.address().port}/`;

  const unpacked = path.join(work, "ext");
  unpackVerified(crx, unpacked, ONE_PASSWORD.id);
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "manifest.json"), "utf8"));
  report.manifestWebauthnScripts = manifest.content_scripts.filter((c) => c.js.some((j) => /webauthn/.test(j))).map((c) => ({ js: c.js, world: c.world || "(default ISOLATED)", run_at: c.run_at, all_frames: c.all_frames }));
  note(`manifest webauthn scripts: ${JSON.stringify(report.manifestWebauthnScripts)}`);

  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData();
  const window = new BrowserWindow({ show: false, width: 1000, height: 700 });
  const openTab = (url) => {
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
    return view;
  };

  // C0. Baseline WITHOUT the extension: Chromium's own WebAuthn in Electron.
  const bare = openTab();
  await bare.webContents.loadURL(base);
  report.baselineNoExtension = await bare.webContents.executeJavaScript(BASELINE, true);
  report.probeNoExtension = await bare.webContents.executeJavaScript(PROBE, true);
  note(`baseline (no extension) get(): ${JSON.stringify(report.baselineNoExtension)}`);
  note(`probe (no extension): ${JSON.stringify(report.probeNoExtension)}`);
  bare.webContents.close();

  // Load 1Password (unpaired; content scripts run regardless of pairing).
  registerShimPreload(ses, work, [ONE_PASSWORD.id]);
  const extensions = attachExtensionSupport(ses, {
    createTab: async () => { throw new Error("fixture opens no tabs"); }, selectTab: () => undefined, removeTab: () => undefined,
  }, { preloadDir: work, window });
  const extension = await ses.extensions.loadExtension(unpacked, { allowFileAccess: false });
  await sleep(2500);

  // A. Fresh page with the extension loaded: is the MAIN-world hook installed?
  const view = openTab();
  extensions.addTab(view.webContents, window);
  await view.webContents.loadURL(base);
  await sleep(1500);
  report.probeWithExtension = await view.webContents.executeJavaScript(PROBE, true);
  note(`probe (extension loaded): ${JSON.stringify(report.probeWithExtension)}`);
  const hookInstalled = report.probeWithExtension.credentialsGet.own && report.probeWithExtension.credentialsGet.accessor;
  report.mainWorldHookInstalled = hookInstalled;
  note(`MAIN-world 1Password WebAuthn hook installed: ${hookInstalled}`);

  // C. With the extension loaded (unpaired), what does get() do?
  report.baselineWithExtension = await view.webContents.executeJavaScript(BASELINE, true);
  note(`get() with extension loaded (unpaired): ${JSON.stringify(report.baselineWithExtension)}`);

  fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2));
  note(`report ${path.join(work, "report.json")}`);
  window.destroy();
  await new Promise((resolve) => server.close(resolve));
  return report;
}

app.whenReady().then(main).then(() => app.exit(0), (error) => { console.error("WEBAUTHN_FAIL", error); app.exit(1); });
