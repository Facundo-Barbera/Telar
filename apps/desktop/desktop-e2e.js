const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const desktopDir = __dirname;
const webDir = path.resolve(desktopDir, "../web");
const electronPath = process.env.TELAR_ELECTRON_BINARY || require("electron");
// Use the same Playwright build as Telar's browser MCP. It tracks the Chromium
// version bundled by current Electron more closely than the stable test peer.
const playwrightMcpDir = fs.realpathSync(path.join(webDir, "node_modules", "@playwright", "mcp"));
const { chromium } = require(path.resolve(playwrightMcpDir, "../..", "playwright"));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForUrl(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryRequest = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) resolve(response);
        else retry();
      });
      request.once("error", retry);
      request.setTimeout(2_000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${url}.`));
      else setTimeout(tryRequest, 200);
    };
    tryRequest();
  });
}

function fixtureServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><title>Telar Browser Fixture</title></head>
      <body style="font-family:system-ui;padding:40px">
        <h1>Desktop browser fixture</h1>
        <button id="counter" onclick="this.textContent='Count 1'">Count 0</button>
      </body></html>`);
  });
  return server;
}

function textOf(result) {
  return (result?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function main() {
  let appUrl = process.env.TELAR_DESKTOP_URL?.replace(/\/$/, "");
  let webChild = null;
  let isolatedHome = null;
  let webOutput = "";
  if (!appUrl) {
    const bunPath = process.env.TELAR_BUN_BINARY;
    assert(bunPath, "test:desktop:e2e must be launched through desktop-e2e-launcher.js.");
    const webPort = await freePort();
    appUrl = `http://127.0.0.1:${webPort}`;
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "telar-desktop-e2e-"));
    webChild = spawn(
      bunPath,
      ["run", "--cwd", webDir, "dev", "--", "--hostname", "127.0.0.1", "--port", String(webPort)],
      {
        cwd: path.resolve(desktopDir, "../.."),
        env: { ...process.env, TELAR_HOME: isolatedHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    webChild.stdout.on("data", (chunk) => { webOutput = `${webOutput}${chunk}`.slice(-20_000); });
    webChild.stderr.on("data", (chunk) => { webOutput = `${webOutput}${chunk}`.slice(-20_000); });
  }

  try {
    await waitForUrl(appUrl, 90_000);
  } catch (error) {
    await stopChild(webChild);
    if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${webOutput}`);
  }

  const fixture = fixtureServer();
  const fixturePort = await freePort();
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(fixturePort, "127.0.0.1", resolve);
  });
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
  const debuggingPort = await freePort();
  let output = "";
  const childEnv = {
    ...process.env,
    TELAR_DESKTOP_URL: appUrl,
    TELAR_DESKTOP_REMOTE_DEBUGGING_PORT: String(debuggingPort),
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [desktopDir], {
    cwd: desktopDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });

  let browser;
  try {
    await waitForUrl(`http://127.0.0.1:${debuggingPort}/json/version`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
    const context = browser.contexts()[0];
    assert(context, "Electron did not expose a CDP browser context.");
    const page = context.pages().find((candidate) => candidate.url().startsWith(appUrl))
      || await context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
    assert(page, `Could not find Telar's renderer at ${appUrl}.`);
    await page.waitForFunction(() => window.telarDesktop?.isDesktop === true, null, { timeout: 15_000 });

    await page.evaluate(async (url) => {
      window.__telarDesktopPointerEvents = [];
      window.__telarDesktopPointerCleanup = window.telarDesktop.browser.onPointer((event) => {
        window.__telarDesktopPointerEvents.push(event);
      });
      await window.telarDesktop.browser.setBounds({ x: 0, y: 0, width: 800, height: 600 });
      await window.telarDesktop.browser.setVisible(true);
      await window.telarDesktop.browser.action({ action: "new", url });
    }, fixtureUrl);

    const snapshot = await page.evaluate(() => window.telarDesktop.browser.callTool("browser_snapshot", {}));
    const snapshotText = textOf(snapshot);
    const target = snapshotText.match(/button\s+"Count 0".*\[ref=(e\d+)\]/)?.[1];
    assert(target, `The Electron-owned fixture was not exposed in the accessibility snapshot:\n${snapshotText}`);

    const clicked = await page.evaluate((ref) => window.telarDesktop.browser.callTool("browser_click", {
      target: ref,
      element: "Count 0 button",
    }), target);
    assert(!clicked.isError, `Desktop browser click failed: ${textOf(clicked)}`);

    const after = await page.evaluate(() => window.telarDesktop.browser.callTool("browser_snapshot", {}));
    assert(textOf(after).includes('button "Count 1"'), "The Electron browser click did not update the fixture page.");
    const pointerEvents = await page.evaluate(() => {
      window.__telarDesktopPointerCleanup?.();
      void window.telarDesktop.browser.setVisible(false);
      return window.__telarDesktopPointerEvents;
    });
    assert(pointerEvents.some((event) => event.phase === "move"), "The agent cursor never emitted a move event.");
    assert(pointerEvents.some((event) => event.phase === "click"), "The agent cursor never emitted a click event.");
    assert(!/uncaught|unhandled|fatal|segmentation fault/i.test(output), `Electron reported a fatal error:\n${output}`);
    console.log("DESKTOP_E2E_OK shared-tab snapshot click cursor");
  } finally {
    await browser?.close().catch(() => {});
    await stopChild(child);
    await new Promise((resolve) => fixture.close(resolve));
    await stopChild(webChild);
    if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("DESKTOP_E2E_FAIL", error);
  process.exitCode = 1;
});
