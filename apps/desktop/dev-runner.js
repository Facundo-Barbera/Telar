const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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

function waitForServer(url, timeoutMs = 60_000) {
  const target = new URL(url);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: target.hostname, port });
      let settled = false;
      const retryOnce = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        retry();
      };
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve();
      });
      socket.once("error", retryOnce);
      socket.setTimeout(2_000, retryOnce);
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

function startElectron(url, debuggingPort, controlPort, controlToken) {
  if (electron || stopping) return;
  electronConfig = { url, debuggingPort, controlPort, controlToken };
  const env = {
    ...process.env,
    TELAR_DESKTOP_URL: url,
    TELAR_DESKTOP_REMOTE_DEBUGGING_PORT: String(debuggingPort),
    TELAR_DESKTOP_BROWSER_CONTROL_PORT: String(controlPort),
    TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: controlToken,
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
          startElectron(
            electronConfig.url,
            electronConfig.debuggingPort,
            electronConfig.controlPort,
            electronConfig.controlToken,
          );
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
  // Prefer the pair dev.mjs minted and already handed to the engine — that is
  // what lets the engine's BrowserRouter find THIS desktop. Standalone runs
  // (bun run dev in apps/desktop) still mint their own.
  const configuredPort = Number(process.env.TELAR_DESKTOP_BROWSER_CONTROL_PORT);
  const controlPort = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : await firstFreePort(19223);
  const controlToken = process.env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN?.trim() || randomUUID();
  const sharedEnv = {
    ...process.env,
    TELAR_DESKTOP_BROWSER_CONTROL_PORT: String(controlPort),
    TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: controlToken,
  };
  let url = process.env.TELAR_DESKTOP_URL?.trim();
  if (!url) {
    const requested = Number(process.env.TELAR_DESKTOP_PORT || 3000);
    const port = await firstFreePort(Number.isInteger(requested) ? requested : 3000);
    url = `http://127.0.0.1:${port}`;
    web = trackedSpawn(
      process.execPath,
      ["run", "--cwd", webDir, "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: repoDir, env: sharedEnv },
    );
    web.once("exit", (code) => {
      web = null;
      if (!stopping) void stop(code || 1);
    });
  }

  await waitForServer(url);
  const requestedDebugPort = Number(process.env.TELAR_DESKTOP_REMOTE_DEBUGGING_PORT || 9223);
  const debuggingPort = await firstFreePort(Number.isInteger(requestedDebugPort) ? requestedDebugPort : 9223);
  console.log(`[telar-desktop] app=${url} devtools=http://127.0.0.1:${debuggingPort}`);
  startElectron(url, debuggingPort, controlPort, controlToken);

  for (const file of ["main.js", "preload.js", "browser-manager.js", "browser-control-server.js"]) {
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
