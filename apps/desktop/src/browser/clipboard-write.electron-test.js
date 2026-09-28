const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, WebContentsView, clipboard, session } = require("electron");
const { createPermissionHandlers, createSitePermissionStore, PermissionPrompts } = require("./site-permissions");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-clipboard-write-")));

app.on("window-all-closed", () => {});

const COPIED = "telar-614-copy-button-works";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line) => console.log(`CLIPBOARD ${line}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

async function openTab(host, partition, base, { focus }) {
  const view = new WebContentsView({
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
  await view.webContents.loadURL(base);
  if (focus) view.webContents.focus();
  await sleep(300);
  if (focus) {
    const started = Date.now();
    // eslint-disable-next-line no-await-in-loop
    while (!(await view.webContents.executeJavaScript("document.hasFocus()"))) {
      if (Date.now() - started >= 3_000) {
        throw new Error(
          `the fixture tab never took focus: document.hasFocus() was still false ${Date.now() - started} ms after webContents.focus()`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
  }
  return view;
}

function closeTab(host, view) {
  host.contentView.removeChildView(view);
  view.webContents.close();
}

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

async function clipboardBecomes(expected, { timeoutMs = 5_000, what }) {
  const started = Date.now();
  for (let polls = 1; ; polls += 1) {
    const text = clipboard.readText();
    if (text === expected) return { text, polls, waitedMs: Date.now() - started };
    const waitedMs = Date.now() - started;
    if (waitedMs >= timeoutMs) {
      throw new Error(
        `${what}: the clipboard holds ${JSON.stringify(text)}, not the copied text, ${waitedMs} ms and ${polls} reads after the page's writeText() resolved`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
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

    report.clipboardWait = await clipboardBecomes(COPIED, {
      what: "the Copy button resolved but its write never reached the OS pasteboard",
    });
    report.clipboard = report.clipboardWait.text;
    note(
      `the OS clipboard holds what the page copied, polls=${report.clipboardWait.polls} ` +
        `(${report.clipboardWait.waitedMs} ms) after writeText() resolved`,
    );

    const strings = [...new Set(live.seen.map((entry) => entry.permission))];
    report.permissionStrings = strings;
    note(`permission strings seen: ${strings.join(", ")}`);
    assert(
      live.seen.some((entry) => entry.phase === "request" && entry.permission === "clipboard-sanitized-write"),
      `no clipboard-sanitized-write request arrived — Chromium's string may have changed (saw: ${strings.join(", ")})`,
    );
    assert(!strings.includes("clipboard-write"), "a raw clipboard-write reached the handler; it needs its own decision");

    assert(live.asked.length === 0, `a Copy button raised ${live.asked.length} prompt(s); it must not ask`);
    assert(live.store.list("persist:telar-clipboard-write").length === 0, "a clipboard write was written down; it is not a remembered decision");
    note("no prompt, nothing stored");

    await tab.webContents.executeJavaScript("readClipboard()", true);
    for (let attempt = 0; attempt < 50 && !(await tab.webContents.executeJavaScript("window.__read")); attempt += 1) await sleep(100);
    report.read = await tab.webContents.executeJavaScript("window.__read");
    note(`readText (answered Block) → ${JSON.stringify(report.read)}`);
    assert(live.asked.some((record) => record.kinds.includes("clipboard-read")), "clipboard-read did not raise a prompt — reading must stay a question");
    assert(report.read && report.read.ok === false, "a refused clipboard READ resolved anyway");
    closeTab(host, tab);

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

    let waitOnDenied = null;
    try {
      await clipboardBecomes(COPIED, { timeoutMs: 500, what: "the control arm's clipboard" });
    } catch (error) {
      waitOnDenied = error;
    }
    assert(
      waitOnDenied,
      "the bounded clipboard wait RETURNED for a clipboard that never received the text — it can no longer go red, so it has replaced a real failure with a slow pass",
    );
    assert(
      /not the copied text/.test(waitOnDenied.message),
      `the bounded wait gave up for the wrong reason: ${waitOnDenied.message}`,
    );
    note(`the bounded wait still fails when the write never lands → ${waitOnDenied.message}`);
    assert(clipboard.readText() === "telar-614-control-arm", "a denied write reached the clipboard anyway");
    closeTab(host, denied);

    const unfocused = handlersFor("persist:telar-clipboard-write-unfocused");

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
