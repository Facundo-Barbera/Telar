const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { HOST_HEADER, attachHostHeader } = require("./host-header");
const { removeUserData } = require("../../test/electron/electron-test-teardown");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-host-header-"));
app.setPath("userData", userData);

const HOST_TOKEN = "tlr_" + "z".repeat(43);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fixture() {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ host: request.headers[HOST_HEADER] ?? null, cookie: request.headers.cookie ?? null });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>host-header fixture</title><body>ok</body>");
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function main() {
  const own = fixture();
  const other = fixture();
  const port = await listen(own.server);
  const otherPort = await listen(other.server);
  const note = (line) => console.log(`HOST_HEADER ${line}`);

  const appUrl = `http://127.0.0.1:${port}/`;

  assert(attachHostHeader(session.defaultSession, { appUrl, token: HOST_TOKEN }), "the header listener did not attach");
  await session.defaultSession.cookies.set({
    url: `http://127.0.0.1:${port}`,
    name: "telar_device",
    value: HOST_TOKEN,
    httpOnly: true,
    sameSite: "lax",
  });

  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await window.loadURL(`http://localhost:${port}/`);
    const arrived = own.seen.at(-1);
    assert(arrived, "the fixture saw no request at all");
    note(`localhost navigation carried header=${arrived.host ? "yes" : "no"} cookie=${arrived.cookie ?? "none"}`);
    assert(arrived.host === HOST_TOKEN, `the host header did not arrive at localhost:${port}: ${arrived.host}`);
    assert(
      !(arrived.cookie ?? "").includes("telar_device"),
      `the cookie DID arrive at localhost — this test no longer reproduces the origin gap: ${arrived.cookie}`,
    );

    await window.loadURL(appUrl);
    const both = own.seen.at(-1);
    note(`127.0.0.1 navigation carried header=${both.host ? "yes" : "no"} cookie=${both.cookie ?? "none"}`);
    assert(both.host === HOST_TOKEN, "the host header did not arrive at the app's own spelling");
    assert((both.cookie ?? "").includes(`telar_device=${HOST_TOKEN}`), "the cookie stopped arriving at its own origin");

    await window.loadURL(`http://127.0.0.1:${otherPort}/`);
    const stranger = other.seen.at(-1);
    assert(stranger, "the second fixture saw no request");
    note(`another loopback port carried header=${stranger.host ? "yes" : "no"} cookie=${stranger.cookie ?? "none"}`);
    assert(stranger.host === null || stranger.host === undefined, `the secret leaked to another loopback port: ${stranger.host}`);

    assert(
      (stranger.cookie ?? "").includes("telar_device"),
      "the cookie no longer reaches another port on the same loopback host — see the note above; the header's advantage may need restating",
    );

    console.log("HOST_HEADER_OK");
  } finally {
    window.destroy();
    await new Promise((resolve) => own.server.close(resolve));
    await new Promise((resolve) => other.server.close(resolve));
    await removeUserData(userData);
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error("HOST_HEADER_FAIL", error);
    app.exit(1);
  },
);
