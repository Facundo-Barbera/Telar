/**
 * THE HOST HEADER, MEASURED IN A REAL ELECTRON — against the exact shape that
 * un-paired the app (issue #259) rather than against a mock of it.
 *
 * The failure was not hypothetical and not visible from a unit test: the shell
 * seats its secret as a session cookie on `http://127.0.0.1:<port>`, the
 * external-link policy treats `localhost:<port>` as the same server so a link
 * spelled that way stays in the window, and a cookie is per-origin — so the
 * host's own window arrived at its own server carrying nothing, was answered
 * 401, and was sent to the pairing page.
 *
 * So this navigates to `localhost`, deliberately, with the cookie seated on
 * `127.0.0.1` exactly as createWindow seats it, and asserts what the SERVER
 * received:
 *
 *   1. the header is there;
 *   2. the cookie is NOT — the old carrier really does go missing on this
 *      navigation, which is what makes the header load-bearing rather than
 *      redundant;
 *   3. a second server on another loopback port does not get the header. The
 *      scoping is the security property: same scheme, same port, loopback
 *      host, and nothing else is handed this app's launcher secret. It DOES
 *      get the cookie, because a cookie has no port in its scope — measured
 *      here, and the sharpest argument for the header there is.
 *
 * Nothing here reaches the network; both fixtures are local and the temp
 * userData is removed at the end.
 *
 * Run: `bun run test:desktop:host-header`.
 */
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { HOST_HEADER, attachHostHeader } = require("./host-header");
const { removeUserData } = require("./electron-test-teardown");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-host-header-"));
app.setPath("userData", userData);

const HOST_TOKEN = "tlr_" + "z".repeat(43);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Records what the last request carried, then answers a trivial page. */
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

  // What createWindow is given: the app's own URL, always spelled 127.0.0.1.
  const appUrl = `http://127.0.0.1:${port}/`;

  // ── the two things createWindow does before its first loadURL ────────────
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
    // ── 1 + 2. the other spelling of the same server ──────────────────────
    await window.loadURL(`http://localhost:${port}/`);
    const arrived = own.seen.at(-1);
    assert(arrived, "the fixture saw no request at all");
    note(`localhost navigation carried header=${arrived.host ? "yes" : "no"} cookie=${arrived.cookie ?? "none"}`);
    assert(arrived.host === HOST_TOKEN, `the host header did not arrive at localhost:${port}: ${arrived.host}`);
    assert(
      !(arrived.cookie ?? "").includes("telar_device"),
      `the cookie DID arrive at localhost — this test no longer reproduces the origin gap: ${arrived.cookie}`,
    );

    // The cookie's own origin still works, so the belt was not broken by the
    // strap: a first navigation to 127.0.0.1 carries both.
    await window.loadURL(appUrl);
    const both = own.seen.at(-1);
    note(`127.0.0.1 navigation carried header=${both.host ? "yes" : "no"} cookie=${both.cookie ?? "none"}`);
    assert(both.host === HOST_TOKEN, "the host header did not arrive at the app's own spelling");
    assert((both.cookie ?? "").includes(`telar_device=${HOST_TOKEN}`), "the cookie stopped arriving at its own origin");

    // ── 3. another loopback port is somebody else's app ───────────────────
    await window.loadURL(`http://127.0.0.1:${otherPort}/`);
    const stranger = other.seen.at(-1);
    assert(stranger, "the second fixture saw no request");
    note(`another loopback port carried header=${stranger.host ? "yes" : "no"} cookie=${stranger.cookie ?? "none"}`);
    assert(stranger.host === null || stranger.host === undefined, `the secret leaked to another loopback port: ${stranger.host}`);

    /**
     * AND THE HEADER IS THE TIGHTER CARRIER OF THE TWO, measured rather than
     * argued: a cookie's scope is the HOST, not the origin — RFC 6265 gives
     * cookies no port component at all — so the secret seated on 127.0.0.1
     * goes to every server on 127.0.0.1, including this unrelated one. The
     * header's rule is scheme + port + loopback host, so it does not.
     *
     * Asserted in this direction on purpose. The day Chromium starts scoping
     * cookies by port, this line fails and someone reads the paragraph above
     * instead of quietly losing the distinction it is drawing.
     */
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
