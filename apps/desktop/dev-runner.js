const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const desktopDir = __dirname;
const repoDir = path.resolve(desktopDir, "../..");
const webDir = path.join(repoDir, "apps/web");
const electronPath = require("electron");
const children = new Set();
const expectedElectronExits = new WeakSet();
const watchers = [];
let electron = null;
let web = null;
let stopping = false;
let restartTimer = null;
let restartQueue = Promise.resolve();
let electronConfig = null;

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function firstFreePort(start) {
  for (let port = start; port < start + 1000; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new Error(`No free port found after ${start}.`);
}

function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) resolve();
        else retry();
      });
      request.once("error", retry);
      request.setTimeout(2_000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${url}.`));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

function trackedSpawn(command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stopChild(child, timeoutMs = 1_500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

function startElectron(url, debuggingPort) {
  if (electron || stopping) return;
  electronConfig = { url, debuggingPort };
  const env = {
    ...process.env,
    TELAR_DESKTOP_URL: url,
    TELAR_DESKTOP_REMOTE_DEBUGGING_PORT: String(debuggingPort),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = trackedSpawn(electronPath, [desktopDir], { cwd: desktopDir, env });
  electron = app;
  app.once("exit", (code, signal) => {
    if (electron === app) electron = null;
    if (!stopping && !expectedElectronExits.has(app) && (code !== 0 || signal)) {
      console.error(`[telar-desktop] Electron exited (code=${code} signal=${signal}).`);
      scheduleElectronRestart();
    }
  });
}

async function stopElectron() {
  const app = electron;
  if (!app) return;
  electron = null;
  expectedElectronExits.add(app);
  await stopChild(app);
}

function scheduleElectronRestart() {
  if (stopping || !electronConfig) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch((error) => {
        console.error("[telar-desktop] previous Electron restart failed:", error);
      })
      .then(async () => {
        await stopElectron();
        if (!stopping && electronConfig) {
          startElectron(electronConfig.url, electronConfig.debuggingPort);
        }
      });
  }, 150);
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  for (const watcher of watchers) watcher.close();
  await restartQueue.catch(() => undefined);
  await stopElectron();
  await Promise.all([...children].map((child) => stopChild(child)));
  process.exit(exitCode);
}

async function main() {
  let url = process.env.TELAR_DESKTOP_URL?.trim();
  if (!url) {
    const requested = Number(process.env.TELAR_DESKTOP_PORT || 3000);
    const port = await firstFreePort(Number.isInteger(requested) ? requested : 3000);
    url = `http://127.0.0.1:${port}`;
    const devHome = process.env.TELAR_HOME?.trim() || path.join(repoDir, ".telar-desktop-dev");
    web = trackedSpawn(
      process.execPath,
      ["--cwd", webDir, "run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: repoDir, env: { ...process.env, TELAR_HOME: devHome } },
    );
    web.once("exit", (code) => {
      web = null;
      if (!stopping) void stop(code || 1);
    });
  }

  await waitForUrl(url);
  const requestedDebugPort = Number(process.env.TELAR_DESKTOP_REMOTE_DEBUGGING_PORT || 9223);
  const debuggingPort = await firstFreePort(Number.isInteger(requestedDebugPort) ? requestedDebugPort : 9223);
  console.log(`[telar-desktop] app=${url} devtools=http://127.0.0.1:${debuggingPort}`);
  startElectron(url, debuggingPort);

  for (const file of ["main.js", "preload.js", "browser-manager.js"]) {
    watchers.push(
      fs.watch(path.join(desktopDir, file), { persistent: true }, () =>
        scheduleElectronRestart(),
      ),
    );
  }
}

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));
void main().catch((error) => {
  console.error("[telar-desktop] dev runner failed:", error);
  void stop(1);
});
