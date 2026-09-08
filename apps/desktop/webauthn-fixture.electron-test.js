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
 *   D. PER PROFILE. The same probe in a SECOND partition — a second named
 *      browser profile — so "profiles are separate identities" is measured for
 *      WebAuthn too: each profile loads its own extension instance, into its
 *      own storage, and one profile's state is not the other's.
 *
 * WHAT THIS DOES NOT SHOW, STATED SO NOBODY READS IT AS MORE. It says whether
 * 1Password's interception CODE is present. It says nothing about whether a
 * passkey can be used, and NOTHING here makes one usable unattended: a
 * remembered login authorization (secrets/login-grants.ts) covers vault FIELDS
 * a person approved — username, password, a one-time code — and no part of it
 * reaches `navigator.credentials`. The account on a profile is intent, not a
 * verified login, and this fixture pairs with nothing and signs into nothing.
 *
 * No pairing, no vault, no real site. Fixture: http://localhost:<port>/
 * (1Password's script matches http://localhost/*).
 *
 *   TELAR_1P_CRX=<crx> env -u ELECTRON_RUN_AS_NODE electron ./webauthn-fixture.electron-test.js
 *
 * Or, with no packaged crx to hand, against the app's OWN verified install —
 * read-only, copied into a temp dir before anything loads it:
 *
 *   TELAR_1P_UNPACKED="$HOME/Library/Application Support/Telar/extensions/aeblfdkhhhdcdjpifhhbdiojplfjncoa/<version>" \
 *     env -u ELECTRON_RUN_AS_NODE electron ./webauthn-fixture.electron-test.js
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { attachExtensionSupport, registerShimPreload, unpackVerified } = require("./extension-compat");
const { ONE_PASSWORD } = require("./extension-host");

const PARTITION = "persist:telar-webauthn-fixture";
/** A SECOND named profile: its own partition, its own extension instance. */
const PARTITION_B = "persist:telar-webauthn-fixture-b";
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

/**
 * The extension bundle to probe, COPIED INTO THE TEMP DIR before it is loaded.
 * Either a packaged crx (verified on unpack, the original path) or an already
 * unpacked directory — the app's own verified install is the practical source,
 * and it is READ, never loaded from in place and never written to.
 */
function stageExtension(work) {
  const crx = process.env.TELAR_1P_CRX;
  const unpacked = path.join(work, "ext");
  if (crx && fs.existsSync(crx)) {
    unpackVerified(crx, unpacked, ONE_PASSWORD.id);
    return { source: "crx", dir: unpacked };
  }
  const already = process.env.TELAR_1P_UNPACKED;
  if (already && fs.existsSync(path.join(already, "manifest.json"))) {
    fs.cpSync(already, unpacked, { recursive: true });
    return { source: "unpacked", dir: unpacked };
  }
  throw new Error("Set TELAR_1P_CRX to the packaged extension, or TELAR_1P_UNPACKED to a verified unpacked one.");
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "telar-webauthn-"));
  const note = (line) => console.log(`WEBAUTHN ${line}`);
  const report = {};

  const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(FIXTURE); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://localhost:${server.address().port}/`;

  const staged = stageExtension(work);
  const unpacked = staged.dir;
  report.extensionSource = staged.source;
  note(`extension source: ${staged.source}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "manifest.json"), "utf8"));
  report.manifestWebauthnScripts = manifest.content_scripts.filter((c) => c.js.some((j) => /webauthn/.test(j))).map((c) => ({ js: c.js, world: c.world || "(default ISOLATED)", run_at: c.run_at, all_frames: c.all_frames }));
  note(`manifest webauthn scripts: ${JSON.stringify(report.manifestWebauthnScripts)}`);

  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData();
  const window = new BrowserWindow({ show: false, width: 1000, height: 700 });
  const openTab = (partition = PARTITION) => {
    const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
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

  /**
   * D. A SECOND PROFILE. Named profiles are separate `persist:` partitions, so
   * a second one gets its own extension instance and its own storage. Probed
   * here so the WebAuthn half of "profiles are separate identities" is
   * measured rather than assumed — and so the reverse claim is visible too: an
   * extension loaded in profile A installs NOTHING in profile B until B loads
   * it as well.
   */
  const sesB = session.fromPartition(PARTITION_B);
  await sesB.clearStorageData();
  const viewB = openTab(PARTITION_B);
  await viewB.webContents.loadURL(base);
  await sleep(500);
  report.probeSecondProfileBeforeLoad = await viewB.webContents.executeJavaScript(PROBE, true);
  note(`probe (second profile, extension NOT loaded there): ${JSON.stringify(report.probeSecondProfileBeforeLoad)}`);
  registerShimPreload(sesB, work, [ONE_PASSWORD.id]);
  const extensionsB = attachExtensionSupport(sesB, {
    createTab: async () => { throw new Error("fixture opens no tabs"); }, selectTab: () => undefined, removeTab: () => undefined,
  }, { preloadDir: work, window });
  await sesB.extensions.loadExtension(unpacked, { allowFileAccess: false });
  await sleep(2500);
  const viewB2 = openTab(PARTITION_B);
  extensionsB.addTab(viewB2.webContents, window);
  await viewB2.webContents.loadURL(base);
  await sleep(1500);
  report.probeSecondProfileAfterLoad = await viewB2.webContents.executeJavaScript(PROBE, true);
  report.secondProfileHookInstalled =
    report.probeSecondProfileAfterLoad.credentialsGet.own && report.probeSecondProfileAfterLoad.credentialsGet.accessor;
  note(`second profile hook installed after its own load: ${report.secondProfileHookInstalled}`);
  // Storage is per profile: what one profile's extension wrote is not the
  // other's. Checked through the page's own localStorage, which shares the
  // partition — a cheap, honest proxy for "separate jar".
  await view.webContents.executeJavaScript("localStorage.setItem('telar-probe','profile-a'), true", true);
  report.secondProfileSeesFirstsStorage = await viewB2.webContents.executeJavaScript("localStorage.getItem('telar-probe')", true);
  note(`second profile reads first profile's storage: ${JSON.stringify(report.secondProfileSeesFirstsStorage)}`);
  if (report.secondProfileSeesFirstsStorage !== null) throw new Error("two profiles shared storage — they are not separate identities");

  fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2));
  note(`report ${path.join(work, "report.json")}`);
  window.destroy();
  await new Promise((resolve) => server.close(resolve));
  return report;
}

app.whenReady().then(main).then(() => app.exit(0), (error) => { console.error("WEBAUTHN_FAIL", error); app.exit(1); });
