const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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
  const browserControlPort = await freePort();
  const browserControlToken = randomUUID();
  const browserControlEnv = {
    TELAR_DESKTOP_BROWSER_CONTROL_PORT: String(browserControlPort),
    TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: browserControlToken,
  };
  let appUrl = process.env.TELAR_DESKTOP_URL?.replace(/\/$/, "");
  let webChild = null;
  let isolatedHome = null;
  let isolatedDistDir = null;
  let webOutput = "";
  if (!appUrl) {
    const bunPath = process.env.TELAR_BUN_BINARY;
    assert(bunPath, "test:desktop:e2e must be launched through desktop-e2e-launcher.js.");
    const webPort = await freePort();
    appUrl = `http://127.0.0.1:${webPort}`;
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "telar-desktop-e2e-"));
    isolatedDistDir = `.next-desktop-e2e-${process.pid}`;
    webChild = spawn(
      bunPath,
      ["run", "--cwd", webDir, "dev", "--", "--hostname", "127.0.0.1", "--port", String(webPort)],
      {
        cwd: path.resolve(desktopDir, "../.."),
        env: {
          ...process.env,
          ...browserControlEnv,
          TELAR_HOME: isolatedHome,
          NEXT_DIST_DIR: isolatedDistDir,
        },
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
    if (isolatedDistDir) {
      fs.rmSync(path.join(webDir, isolatedDistDir), { recursive: true, force: true });
    }
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
  const desktopUserData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-electron-e2e-"));
  let output = "";
  const childEnv = {
    ...process.env,
    ...browserControlEnv,
    TELAR_DESKTOP_URL: appUrl,
    TELAR_DESKTOP_REMOTE_DEBUGGING_PORT: String(debuggingPort),
    TELAR_DESKTOP_E2E_USER_DATA: desktopUserData,
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

    await page.evaluate(async () => {
      window.__telarDesktopPointerEvents = [];
      window.__telarDesktopPointerCleanup = window.telarDesktop.browser.onPointer((event) => {
        window.__telarDesktopPointerEvents.push(event);
      });
      await window.telarDesktop.browser.setBounds("e2e", { x: 0, y: 0, width: 800, height: 600 });
      await window.telarDesktop.browser.setVisible("e2e", true);
    });

    const agentRoute = await fetch(`${appUrl}/api/browser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopeKey: "e2e", action: "new", url: fixtureUrl }),
    });
    const agentState = await agentRoute.json();
    assert(agentRoute.ok, `Agent-to-Electron browser route failed: ${JSON.stringify(agentState)}`);
    assert(agentState.tabs?.some((tab) => tab.url === fixtureUrl),
      "The agent browser route did not open the fixture in Electron.");

    const snapshot = await page.evaluate(() => window.telarDesktop.browser.callTool("e2e", "browser_snapshot", {}));
    const snapshotText = textOf(snapshot);
    const target = snapshotText.match(/button\s+"Count 0".*\[ref=(e\d+)\]/)?.[1];
    assert(target, `The Electron-owned fixture was not exposed in the accessibility snapshot:\n${snapshotText}`);

    const clicked = await page.evaluate((ref) => window.telarDesktop.browser.callTool("e2e", "browser_click", {
      target: ref,
      element: "Count 0 button",
    }), target);
    assert(!clicked.isError, `Desktop browser click failed: ${textOf(clicked)}`);

    const after = await page.evaluate(() => window.telarDesktop.browser.callTool("e2e", "browser_snapshot", {}));
    assert(textOf(after).includes('button "Count 1"'), "The Electron browser click did not update the fixture page.");
    const isolatedState = await page.evaluate(() => window.telarDesktop.browser.getState("other-session"));
    assert(isolatedState.tabs.length === 0, "A second session could see the first session's browser tab.");
    const isolatedSnapshot = await page.evaluate(() =>
      window.telarDesktop.browser.callTool("other-session", "browser_snapshot", {}));
    assert(isolatedSnapshot.isError, "A second session could inspect the first session's browser tab.");
    const pointerEvents = await page.evaluate(() => {
      window.__telarDesktopPointerCleanup?.();
      return window.__telarDesktopPointerEvents;
    });
    assert(pointerEvents.some((event) => event.phase === "move"), "The agent cursor never emitted a move event.");
    assert(pointerEvents.some((event) => event.phase === "click"), "The agent cursor never emitted a click event.");

    // A renderer reload is the production path that originally left a native
    // WebContentsView visible and then called setVisible without a scope. The
    // tab should hibernate during reload and wake under the same session only.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.telarDesktop?.isDesktop === true, null, { timeout: 15_000 });
    const resumed = await page.evaluate(() => window.telarDesktop.browser.callTool("e2e", "browser_snapshot", {}));
    assert(textOf(resumed).includes('button "Count 1"'), "The scoped browser did not resume after renderer reload.");
    await page.evaluate(() => window.telarDesktop.browser.releaseScope("e2e", true));
    const released = await page.evaluate(() => window.telarDesktop.browser.getState("e2e"));
    assert(released.tabs.length === 0, "Explicit session cleanup left browser tabs behind.");
    assert(!/uncaught|unhandled|fatal|segmentation fault/i.test(output), `Electron reported a fatal error:\n${output}`);
    console.log("DESKTOP_E2E_OK agent-route scoped-tab snapshot click cursor reload cleanup");
  } finally {
    await browser?.close().catch(() => {});
    await stopChild(child);
    await new Promise((resolve) => fixture.close(resolve));
    await stopChild(webChild);
    if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
    if (isolatedDistDir) {
      fs.rmSync(path.join(webDir, isolatedDistDir), { recursive: true, force: true });
    }
    fs.rmSync(desktopUserData, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("DESKTOP_E2E_FAIL", error);
  process.exitCode = 1;
});
