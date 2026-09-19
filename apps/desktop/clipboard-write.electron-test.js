/**
 * EVERY SITE'S COPY BUTTON (#614), against a real Chromium.
 *
 * The bug was a permission: Chromium asks for `clipboard-sanitized-write` when
 * a page calls `navigator.clipboard.writeText`, that string was in
 * site-permissions.js's fail-closed bucket, and so every Copy button on the web
 * silently did nothing in Telar's browser. A unit test on the handler's return
 * value would prove only that we changed our minds about a string. What has to
 * be true is that a button a person clicks puts text on this Mac's clipboard,
 * so that is what this measures — with a real `WebContentsView`, the real
 * handlers, a real click, and a read of the real pasteboard.
 *
 * WHAT IT PINS, each one a thing that was assumed in the issue and is now known:
 *
 *   1. THE STRING IS `clipboard-sanitized-write`. Measured, not read off the
 *      docs — a rename in a future Electron puts the bug straight back, and
 *      this fails the moment it happens. No raw `clipboard-write` ever arrives.
 *   2. THE BUTTON WORKS: the click resolves and the OS clipboard holds the
 *      fixture's text. `navigator.permissions.query({name:"clipboard-write"})`
 *      reports "granted", which is what a site reads before offering the button.
 *   3. THE CONTROL ARM. The same page, same click, with only that one
 *      permission forced back to denied, fails with `Write permission denied` —
 *      so this test is sensitive to the bug it is here to catch, rather than
 *      passing for some unrelated reason.
 *   4. CHROMIUM'S OWN GATE IS THE FOCUSED DOCUMENT, and it is checked BEFORE
 *      our handler is consulted: an unfocused view gets `Document is not
 *      focused` even fully granted, and the permission handler is never called.
 *      That is the issue's second hypothesis, measured — it is Chromium's rule,
 *      identical in Chrome, and it bounds what the grant can ever mean.
 *   5. WRITING IS NOT READING. `navigator.clipboard.readText()` from the same
 *      page still raises Telar's prompt and is refused when the answer is Block.
 *
 * NO FOCUS IS TAKEN. The host window is only ever `showInactive()`n; the view is
 * focused within it. That is enough for Chromium — the window does not have to
 * be the key window — so a run never steals the frontmost app from anyone.
 *
 * IT TOUCHES THE REAL CLIPBOARD, because that is the only honest proof. The
 * text on it is read before and written back after; anything non-text on it
 * when the run starts is lost, which is the one cost of measuring this for real.
 *
 * Run: `bun run test:desktop:clipboard` (its own temp userData, its own
 * loopback fixture, no network).
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, WebContentsView, clipboard, session } = require("electron");
const { createPermissionHandlers, createSitePermissionStore, PermissionPrompts } = require("./site-permissions");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-clipboard-write-")));
// A destroyed window must not take the app with it; the run owns its own exit.
app.on("window-all-closed", () => {});

const COPIED = "telar-614-copy-button-works";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line) => console.log(`CLIPBOARD ${line}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * A page with the button every docs site has: a real <button>, a real click
 * handler, `navigator.clipboard.writeText`, and the rejection kept where a test
 * can read it — which is precisely what a real site throws away.
 */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Copy fixture</title></head>
<body style="font-family:system-ui;padding:24px">
  <pre id="token">${COPIED}</pre>
  <button id="copy" style="width:200px;height:48px">Copy</button>
  <p id="out"></p>
<script>
  window.__write = null;
  window.__read = null;
  document.getElementById("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById("token").textContent);
      window.__write = { ok: true };
    } catch (error) {
      window.__write = { ok: false, name: error && error.name, message: String(error && error.message) };
    }
    document.getElementById("out").textContent = JSON.stringify(window.__write);
  });
  window.readClipboard = async () => {
    try { window.__read = { ok: true, text: await navigator.clipboard.readText() }; }
    catch (error) { window.__read = { ok: false, name: error && error.name, message: String(error && error.message) }; }
  };
</script>
</body></html>`;

/**
 * The REAL handlers for one partition, with the two ports a shell supplies
 * faked: an ephemeral store (no userDataDir — nothing is read, nothing is
 * written) and a prompt registry that records every question and answers it
 * with `answer`. `denySanitizedWrite` is the control arm: the one permission
 * put back in the fail-closed bucket, and nothing else changed.
 */
function handlersFor(partition, { answer = "block", denySanitizedWrite = false } = {}) {
  const asked = [];
  const store = createSitePermissionStore(null);
  const prompts = new PermissionPrompts({
    deliver: (record) => {
      asked.push(record);
      queueMicrotask(() => prompts.answer(record.requestId, { decision: answer }));
    },
    timeoutMs: 5_000,
  });
  const real = createPermissionHandlers({
    partition,
    store,
    prompts,
    media: { ask: async () => true, status: () => "granted" },
  });
  const seen = [];
  const request = async (webContents, permission, callback, details) => {
    seen.push({ phase: "request", permission });
    if (denySanitizedWrite && permission === "clipboard-sanitized-write") return callback(false);
    return real.request(webContents, permission, callback, details);
  };
  const check = (webContents, permission, origin, details) => {
    if (denySanitizedWrite && permission === "clipboard-sanitized-write") {
      seen.push({ phase: "check", permission, answer: false });
      return false;
    }
    const answered = real.check(webContents, permission, origin, details);
    seen.push({ phase: "check", permission, answer: answered });
    return answered;
  };
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler(request);
  ses.setPermissionCheckHandler(check);
  ses.setDevicePermissionHandler(() => false);
  return { asked, seen, store };
}

/** A tab in the host window, loaded and (optionally) focused within it. */
async function openTab(host, partition, base, { focus }) {
  const view = new WebContentsView({
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
  await view.webContents.loadURL(base);
  if (focus) view.webContents.focus();
  await sleep(300);
  return view;
}

function closeTab(host, view) {
  host.contentView.removeChildView(view);
  view.webContents.close();
}

/**
 * Press the Copy button and wait for the page to record what happened.
 *
 * `via: "input"` is a real left click — the mouse events a person's click
 * produces, at the coordinates the page reports, which is the fidelity the
 * granted cases deserve. A window nobody can see has no visual viewport to
 * receive those, so the unfocused case dispatches the click in the page with a
 * user gesture instead; what it is measuring is Chromium's focus rule, and the
 * route the click took is not part of that.
 */
async function clickCopy(webContents, { via = "input" } = {}) {
  if (via === "script") {
    await webContents.executeJavaScript(`document.getElementById("copy").click()`, true);
  } else {
    const box = await webContents.executeJavaScript(
      `(() => { const r = document.getElementById("copy").getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    webContents.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
    webContents.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const settled = await webContents.executeJavaScript("window.__write");
    if (settled) return settled;
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  throw new Error("the Copy button never settled — the click did not reach the page");
}

async function main() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  note(`fixture ${base}`);

  const restore = clipboard.readText();
  const host = new BrowserWindow({ show: false, width: 900, height: 600 });
  host.showInactive();
  const report = {};

  try {
    /* 1 + 2. The fix: a focused tab, a real click, the real pasteboard. */
    const live = handlersFor("persist:telar-clipboard-write", { answer: "block" });
    const tab = await openTab(host, "persist:telar-clipboard-write", base, { focus: true });
    report.hasFocus = await tab.webContents.executeJavaScript("document.hasFocus()");
    assert(report.hasFocus, "the fixture tab was not focused — nothing below would mean anything");

    report.queryBeforeClick = await tab.webContents.executeJavaScript(
      `navigator.permissions.query({ name: "clipboard-write" }).then((s) => s.state, (e) => "query-threw:" + e.name)`,
    );
    note(`navigator.permissions.query({name:"clipboard-write"}) → ${report.queryBeforeClick}`);
    assert(report.queryBeforeClick === "granted", `a site reads this before it offers the button; it said ${report.queryBeforeClick}`);

    clipboard.writeText("telar-614-before-the-click");
    report.write = await clickCopy(tab.webContents);
    note(`writeText → ${JSON.stringify(report.write)}`);
    assert(report.write.ok, `the Copy button failed: ${report.write.name}: ${report.write.message}`);

    report.clipboard = clipboard.readText();
    assert(report.clipboard === COPIED, `the clipboard holds ${JSON.stringify(report.clipboard)}, not the copied text`);
    note("the OS clipboard holds what the page copied");

    /* 1. The string Chromium actually sends, and the one it never sends. */
    const strings = [...new Set(live.seen.map((entry) => entry.permission))];
    report.permissionStrings = strings;
    note(`permission strings seen: ${strings.join(", ")}`);
    assert(
      live.seen.some((entry) => entry.phase === "request" && entry.permission === "clipboard-sanitized-write"),
      `no clipboard-sanitized-write request arrived — Chromium's string may have changed (saw: ${strings.join(", ")})`,
    );
    assert(!strings.includes("clipboard-write"), "a raw clipboard-write reached the handler; it needs its own decision");

    /* 2. Granted without asking, and remembered nowhere. */
    assert(live.asked.length === 0, `a Copy button raised ${live.asked.length} prompt(s); it must not ask`);
    assert(live.store.list("persist:telar-clipboard-write").length === 0, "a clipboard write was written down; it is not a remembered decision");
    note("no prompt, nothing stored");

    /* 5. Writing is not reading: the read still asks, and Block still refuses. */
    await tab.webContents.executeJavaScript("readClipboard()", true);
    for (let attempt = 0; attempt < 50 && !(await tab.webContents.executeJavaScript("window.__read")); attempt += 1) await sleep(100);
    report.read = await tab.webContents.executeJavaScript("window.__read");
    note(`readText (answered Block) → ${JSON.stringify(report.read)}`);
    assert(live.asked.some((record) => record.kinds.includes("clipboard-read")), "clipboard-read did not raise a prompt — reading must stay a question");
    assert(report.read && report.read.ok === false, "a refused clipboard READ resolved anyway");
    closeTab(host, tab);

    /* 3. The control arm: only that permission denied, same page, same click. */
    handlersFor("persist:telar-clipboard-write-denied", { denySanitizedWrite: true });
    const denied = await openTab(host, "persist:telar-clipboard-write-denied", base, { focus: true });
    clipboard.writeText("telar-614-control-arm");
    report.control = await clickCopy(denied.webContents);
    note(`control arm (permission denied) → ${JSON.stringify(report.control)}`);
    assert(!report.control.ok, "the control arm SUCCEEDED with the permission denied — this test cannot see the bug it is for");
    assert(
      /permission denied/i.test(report.control.message),
      `the control arm failed for the wrong reason: ${report.control.message}`,
    );
    assert(clipboard.readText() === "telar-614-control-arm", "a denied write reached the clipboard anyway");
    closeTab(host, denied);

    /* 4. Chromium's own gate, and that it is checked before ours. */
    const unfocused = handlersFor("persist:telar-clipboard-write-unfocused");
    // ITS OWN WINDOW, NEVER SHOWN. A lone view in a visible window takes focus
    // whether or not it is asked to, so "unfocused" has to be a window nobody
    // can see — which is also the real case it stands for: a tab an agent is
    // driving while the panel is closed.
    const hidden = new BrowserWindow({ show: false, width: 900, height: 600 });
    const background = await openTab(hidden, "persist:telar-clipboard-write-unfocused", base, { focus: false });
    report.backgroundHasFocus = await background.webContents.executeJavaScript("document.hasFocus()");
    assert(report.backgroundHasFocus === false, "the background tab was focused after all; case 4 measures nothing");
    report.background = await clickCopy(background.webContents, { via: "script" });
    note(`unfocused tab, fully granted → ${JSON.stringify(report.background)}`);
    assert(!report.background.ok, "an unfocused document wrote the clipboard — Chromium's gate is not where we think");
    assert(
      /not focused/i.test(report.background.message),
      `an unfocused write failed for the wrong reason: ${report.background.message}`,
    );
    assert(
      !unfocused.seen.some((entry) => entry.phase === "request" && entry.permission === "clipboard-sanitized-write"),
      "Chromium consulted the permission handler for an unfocused document; the focus gate is not before ours",
    );
    note("Chromium refuses an unfocused document before asking us at all");
    closeTab(hidden, background);
    hidden.destroy();

    note(`OK — ${JSON.stringify(report)}`);
  } finally {
    clipboard.writeText(restore);
    host.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  return report;
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("CLIPBOARD_FAIL", error);
    app.exit(1);
  },
);
