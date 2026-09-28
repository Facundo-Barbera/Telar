const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { fork } = require("node:child_process");
const { app, dialog } = require("electron");
const { DEV_BUILD, SMOKE } = require("./flags");
const { bundledPlaywrightMcpCli, nodeExecPath, resolveEngineJs } = require("./bundle-paths");
const { logShell, shellLogPath } = require("./shell-log");
const { HOST_TOKEN } = require("./ui-server");

const ENGINE_EXIT_LOCK_HELD = 3;

let mainWindowShown = false;
let startupFailureReported = false;

function reportStartupFailure(title, detail) {
  if (mainWindowShown || startupFailureReported) return;
  startupFailureReported = true;
  dialog.showErrorBox(title, detail);
}

function markMainWindowShown() {
  mainWindowShown = true;
}

let engineChild = null;

function engineLockOwnerPid(home) {
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(home, "engine", "engine.lock"), "utf8"))?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function onEngineExit(home, code, signal) {
  engineChild = null;

  if (SMOKE || app.isQuitting) return;
  logShell("error", `engine exited (code=${code} signal=${signal})`);

  if (code === ENGINE_EXIT_LOCK_HELD && !mainWindowShown && !startupFailureReported) {
    startupFailureReported = true;
    const pid = engineLockOwnerPid(home);
    dialog.showMessageBoxSync({
      type: "warning",
      title: "Telar is already running",
      message: "Another Telar is using this store.",
      detail:
        `A Telar daemon${pid === null ? "" : ` (pid ${pid})`} already holds ${home}.\n\n` +
        "Switch to the Telar that is already open, or quit it before launching this one.",
      buttons: ["Quit"],
    });
    app.quit();
    return;
  }

  reportStartupFailure(
    "Telar's engine stopped",
    `The engine exited (code=${code} signal=${signal}) before Telar could open.\n\n` +
      `There is more in ${shellLogPath()}.`,
  );
  app.quit();
}

function startEngineChild(home, env) {
  const engineJs = resolveEngineJs();
  engineChild = fork(engineJs, [], {
    cwd: path.dirname(engineJs),
    execPath: nodeExecPath(),

    execArgv: ["--require", path.join(__dirname, "..", "preload", "server-preload.js")],
    env: {
      ...env,
      TELAR_HOST_TOKEN: HOST_TOKEN,
      TELAR_PROCESS_TITLE: DEV_BUILD ? "telar-engine-dev" : "telar-engine",
      NODE_ENV: "production",

      ...(app.isPackaged && !process.env.TELAR_PLAYWRIGHT_MCP_BIN
        ? { TELAR_PLAYWRIGHT_MCP_BIN: bundledPlaywrightMcpCli() }
        : {}),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  engineChild.on("exit", (code, signal) => onEngineExit(home, code, signal));
  return engineChild;
}

function stopEngineChild() {
  if (!engineChild || engineChild.killed) return;
  try {
    engineChild.kill("SIGTERM");
  } catch {
  }
  engineChild = null;
}

function engineDiscoveryFile(home) {
  return path.join(home, "engine", "engine.json");
}

function readDiscovery(discoveryFile) {
  try {
    return JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
  } catch {
    return null;
  }
}

function probeHealth(discovery, requireWorker, { resolve, retry }) {
  const request = http.request(
    {
      host: discovery.host || "127.0.0.1",
      port: discovery.port,
      path: "/v2/health",
      headers: { authorization: `Bearer ${discovery.token}` },
      timeout: 2_000,
    },
    (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return retry();
      }
      if (!requireWorker) {
        response.resume();
        return resolve(discovery);
      }
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (raw += chunk));
      response.on("end", () => {
        let health = null;
        try {
          health = JSON.parse(raw);
        } catch {
        }
        if (health?.worker?.registered === true) return resolve({ ...discovery, workerId: health.worker.workerId });
        retry();
      });
    },
  );
  request.on("error", retry);
  request.on("timeout", () => {
    request.destroy();
    retry();
  });
  request.end();
}

function waitForEngine(home, { timeoutMs = 30_000, intervalMs = 150, requireWorker = false } = {}) {
  const discoveryFile = engineDiscoveryFile(home);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const discovery = readDiscovery(discoveryFile);
      if (discovery?.port && discovery?.token) probeHealth(discovery, requireWorker, { resolve, retry });
      else retry();
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`engine did not become ${requireWorker ? "healthy with a registered worker" : "healthy"} within ${timeoutMs}ms`));
      } else setTimeout(tick, intervalMs);
    };
    tick();
  });
}

let engineDiscovery = null;
let discoveryReadAt = 0;

function rememberEngine(discovery) {
  engineDiscovery = discovery;
}

function currentEngineDiscovery(home) {
  if (!engineDiscovery && Date.now() - discoveryReadAt > 5_000) {
    discoveryReadAt = Date.now();
    engineDiscovery = readDiscovery(engineDiscoveryFile(home));
  }
  return engineDiscovery;
}

function postToEngine(home, routePath, body) {
  const discovery = currentEngineDiscovery(home);
  if (!discovery?.port || !discovery?.token) return;
  const payload = JSON.stringify(body ?? {});
  const request = http.request({
    host: discovery.host || "127.0.0.1",
    port: discovery.port,
    path: routePath,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${discovery.token}`,
      "content-length": Buffer.byteLength(payload),
    },
    timeout: 2_000,
  });
  request.on("error", () => {});
  request.on("timeout", () => request.destroy());
  request.end(payload);
}

module.exports = {
  engineDiscoveryFile,
  markMainWindowShown,
  onEngineExit,
  postToEngine,
  rememberEngine,
  reportStartupFailure,
  startEngineChild,
  stopEngineChild,
  waitForEngine,
};
