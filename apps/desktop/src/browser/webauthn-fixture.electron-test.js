const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { attachExtensionSupport, registerShimPreload, unpackVerified } = require("./extension-compat");
const { ONE_PASSWORD } = require("./extension-host");

const PARTITION = "persist:telar-webauthn-fixture";

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

  const bare = openTab();
  await bare.webContents.loadURL(base);
  report.baselineNoExtension = await bare.webContents.executeJavaScript(BASELINE, true);
  report.probeNoExtension = await bare.webContents.executeJavaScript(PROBE, true);
  note(`baseline (no extension) get(): ${JSON.stringify(report.baselineNoExtension)}`);
  note(`probe (no extension): ${JSON.stringify(report.probeNoExtension)}`);
  bare.webContents.close();

  registerShimPreload(ses, work, [ONE_PASSWORD.id]);
  const extensions = attachExtensionSupport(ses, {
    createTab: async () => { throw new Error("fixture opens no tabs"); }, selectTab: () => undefined, removeTab: () => undefined,
  }, { preloadDir: work, window });
  const extension = await ses.extensions.loadExtension(unpacked, { allowFileAccess: false });
  await sleep(2500);

  const view = openTab();
  extensions.addTab(view.webContents, window);
  await view.webContents.loadURL(base);
  await sleep(1500);
  report.probeWithExtension = await view.webContents.executeJavaScript(PROBE, true);
  note(`probe (extension loaded): ${JSON.stringify(report.probeWithExtension)}`);
  const hookInstalled = report.probeWithExtension.credentialsGet.own && report.probeWithExtension.credentialsGet.accessor;
  report.mainWorldHookInstalled = hookInstalled;
  note(`MAIN-world 1Password WebAuthn hook installed: ${hookInstalled}`);

  report.baselineWithExtension = await view.webContents.executeJavaScript(BASELINE, true);
  note(`get() with extension loaded (unpaired): ${JSON.stringify(report.baselineWithExtension)}`);

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
