/**
 * REAL-ELECTRON EVIDENCE for the credential boundary's frame coverage
 * (browser-tab-preload.js + DesktopBrowserManager.tabHoldsCredentials):
 *
 *   1. a password field INSIDE AN IFRAME getting a value begins privacy
 *      (the preload runs in subframes);
 *   2. Resume is refused while an OTP field with type=text (autocomplete
 *      one-time-code) in that iframe is filled — a username alone is not
 *      blocking;
 *   3. once the fields are cleared Resume goes through.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE electron ./credential-frames.electron-test.js
 * Prints CREDENTIAL_FRAMES_OK on success. No real site, no vault.
 */
const http = require("node:http");
const { app, BrowserWindow, ipcMain } = require("electron");
const { DesktopBrowserManager } = require("./browser-manager");

const OUTER = (port) => `<!doctype html><title>Outer</title><h1>Outer page</h1>
<input id="user" autocomplete="username" value="">
<iframe id="login" src="http://127.0.0.1:${port}/frame" width="400" height="200"></iframe>`;
const FRAME = `<!doctype html><title>Login frame</title>
<input id="u" autocomplete="username"><input id="p" type="password"><input id="otp" type="text" autocomplete="one-time-code">`;

function assert(condition, message) { if (!condition) throw new Error(message); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, tries = 40) {
  for (let i = 0; i < tries; i += 1) { if (await check()) return; await sleep(50); }
  throw new Error(message);
}

async function main() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(request.url === "/frame" ? FRAME : OUTER(server.address().port));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const note = (line) => console.log(`FRAMES ${line}`);

  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  const manager = new DesktopBrowserManager(window);
  ipcMain.on("telar:browser:credential-field", (event, detail) => manager.noteCredentialFieldFromWebContents(event.sender, detail || {}));
  const scope = "frames";
  manager.declareProfile(scope, "none"); // per-project profiles fail closed
  try {
    await manager.callTool(scope, "browser_tabs", { action: "new", url: `${base}/` });
    const tab = manager.activeTab(scope);
    const wc = tab.view.webContents;
    await until(() => wc.mainFrame.framesInSubtree.length === 2 && !wc.isLoading(), "iframe did not load");
    const frame = wc.mainFrame.framesInSubtree.find((f) => f !== wc.mainFrame);
    note(`frames=${wc.mainFrame.framesInSubtree.length} probe(main)=${await wc.mainFrame.executeJavaScript("typeof __telarProtectedFieldsFilled")} probe(iframe)=${await frame.executeJavaScript("typeof __telarProtectedFieldsFilled")}`);
    assert((await frame.executeJavaScript("typeof __telarProtectedFieldsFilled")) === "function", "the probe is missing in the iframe (preload did not run there)");

    // Baseline: nothing filled, not private.
    assert(!manager.privacy.isActive(), "privacy active before any field was touched");
    assert((await manager.tabHoldsCredentials(tab)) === "clear", "empty page reported as holding credentials");

    // 1. A value lands in the IFRAME's password field (a fill: no key events).
    await frame.executeJavaScript(`(() => { const p = document.getElementById("p"); p.value = "fixture-only"; p.dispatchEvent(new Event("input", { bubbles: true })); })()`, true);
    await until(() => manager.privacy.isActive(), "a fill in the iframe's password field did not begin privacy");
    note(`after iframe fill: privacy=${JSON.stringify(manager.privacy.state())}`);
    assert(manager.privacy.state().reason === "credentials filled", `unexpected reason ${manager.privacy.state().reason}`);
    let resume = await manager.resumeFromPrivate();
    note(`resume with iframe password filled: ${resume.refused ? "REFUSED" : "allowed"}`);
    assert(resume.refused, "resume allowed while the iframe's password field is filled");

    // 2. Clear the password; fill the type=text OTP field instead. Still refused.
    await frame.executeJavaScript(`(() => { document.getElementById("p").value = ""; document.getElementById("otp").value = "123456"; })()`, true);
    resume = await manager.resumeFromPrivate();
    note(`resume with type=text OTP filled: ${resume.refused ? "REFUSED" : "allowed"}`);
    assert(resume.refused, "resume allowed while a type=text one-time-code field is filled");

    // 3. Only usernames filled (outer + iframe): not blocking.
    await frame.executeJavaScript(`(() => { document.getElementById("otp").value = ""; document.getElementById("u").value = "telar-test"; })()`, true);
    await wc.mainFrame.executeJavaScript(`document.getElementById("user").value = "telar-test"`, true);
    resume = await manager.resumeFromPrivate();
    note(`resume with only usernames filled: ${resume.refused ? "REFUSED" : "allowed"} private=${resume.private}`);
    assert(!resume.refused && resume.private === false, "resume refused although only username fields are filled");

    // Every tool the agent tries next is stale until it looks again.
    const stale = await manager.callTool(scope, "browser_click", { target: "e1" });
    assert(stale.isError, "a mutation after resume was not stale");
    console.log("CREDENTIAL_FRAMES_OK");
  } finally {
    try { manager.releaseScope(scope, true); } catch {}
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

app.whenReady().then(main).then(() => app.exit(0), (error) => { console.error("CREDENTIAL_FRAMES_FAIL", error); app.exit(1); });
