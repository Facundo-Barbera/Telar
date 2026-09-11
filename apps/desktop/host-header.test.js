// THE HEADER NAME IS A CONTRACT BETWEEN TWO LANGUAGES, AND NOTHING ELSE
// CHECKS IT.
//
// The shell writes `x-telar-host` from CommonJS; the gate reads it from
// TypeScript in another app. Neither half can import the other's constant, so a
// rename on one side is not a type error, not a lint error, and not a failing
// route test — it is the desktop app quietly deciding it is a stranger to its
// own server again (issue #259), which is exactly the failure that took months
// to name the first time.
//
// Same idea as packaging.test.js: read the source of the thing that must agree
// and assert it does.

const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const { HOST_HEADER, isOwnServer, attachHostHeader } = require("./host-header");

const hostTokenTs = path.join(__dirname, "..", "web", "lib", "remote", "host-token.ts");

describe("the shell and the gate name the same header", () => {
  test("host-token.ts declares the header this module exports", () => {
    const source = fs.readFileSync(hostTokenTs, "utf8");
    const declared = source.match(/export const HOST_HEADER = "([^"]+)"/)?.[1];
    expect(declared).toBeDefined();
    expect(declared).toBe(HOST_HEADER);
  });

  test("the name is lower-case — the shell writes it verbatim and Headers.get is not", () => {
    // Electron's requestHeaders is a plain object with no case folding of its
    // own, so a mixed-case key here would arrive as a header the runtime's
    // lower-cased lookup on the web side still finds — but the two would only
    // agree by accident. Pinned so the agreement is on purpose.
    expect(HOST_HEADER).toBe(HOST_HEADER.toLowerCase());
  });
});

describe("only the app's own server is handed the secret", () => {
  const app = "http://127.0.0.1:57547/";

  test("every spelling of this machine, on the same port, is the same server", () => {
    for (const url of [
      "http://127.0.0.1:57547/",
      "http://localhost:57547/api/sessions/live",
      "http://[::1]:57547/",
    ]) {
      expect(isOwnServer(url, app)).toBe(true);
    }
  });

  test("another port on loopback is somebody else's app", () => {
    // A Vite dev server, another Telar, a random tool — a different server, and
    // the one case a widened rule would leak the launcher secret to.
    expect(isOwnServer("http://127.0.0.1:5173/", app)).toBe(false);
    expect(isOwnServer("http://localhost/", app)).toBe(false);
  });

  test("a different scheme is a different server", () => {
    expect(isOwnServer("https://127.0.0.1:57547/", app)).toBe(false);
  });

  test("the open web never matches, however it is spelled", () => {
    for (const url of [
      "https://example.com/",
      "http://127.0.0.1.example.com:57547/",
      "http://notlocalhost:57547/",
      "not a url",
      "",
    ]) {
      expect(isOwnServer(url, app)).toBe(false);
    }
  });

  test("an app URL that is not a URL matches nothing", () => {
    expect(isOwnServer("http://127.0.0.1:57547/", "")).toBe(false);
  });
});

describe("attachHostHeader", () => {
  const fakeSession = () => {
    const listeners = [];
    return { listeners, webRequest: { onBeforeSendHeaders: (fn) => listeners.push(fn) } };
  };
  const send = (session, url) =>
    new Promise((resolve) => session.listeners.at(-1)({ url, requestHeaders: { accept: "*/*" } }, resolve));

  test("the header is added to the app's own server and to nothing else", async () => {
    const session = fakeSession();
    expect(attachHostHeader(session, { appUrl: "http://127.0.0.1:4321/", token: "tlr_secret" })).toBe(true);

    const mine = await send(session, "http://localhost:4321/api/sessions/live");
    expect(mine.requestHeaders[HOST_HEADER]).toBe("tlr_secret");
    expect(mine.requestHeaders.accept).toBe("*/*");

    const theirs = await send(session, "https://example.com/callback");
    expect(theirs.requestHeaders[HOST_HEADER]).toBeUndefined();
  });

  test("no token means no listener claimed, rather than a listener that proves nothing", () => {
    const session = fakeSession();
    expect(attachHostHeader(session, { appUrl: "http://127.0.0.1:4321/", token: "" })).toBe(false);
    expect(attachHostHeader(session, { appUrl: "nonsense", token: "tlr_secret" })).toBe(false);
    expect(session.listeners).toHaveLength(0);
  });
});

describe("main.js wires it to the default session only", () => {
  /**
   * THE SCOPE IS THE SECURITY PROPERTY. `session.defaultSession` is the app's
   * own window; the integrated browser's tabs live in `persist:` partitions and
   * point at the open web. A call that passed a partition here would hand this
   * app's launcher secret to whatever page an agent had open.
   */
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

  test("attachHostHeader is called with session.defaultSession and the host token", () => {
    expect(main).toMatch(/attachHostHeader\(session\.defaultSession, \{ appUrl: url, token: HOST_TOKEN \}\)/);
    expect(main.match(/attachHostHeader\(/g)).toHaveLength(1);
  });
});
