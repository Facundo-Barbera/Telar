const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const { fork } = require("node:child_process");
const { app, session } = require("electron");
const { attachHostHeader } = require("./host-header");
const remoteFile = require("./remote-file");
const { jsonPrefs } = require("./prefs");

const HOST_TOKEN = process.env.TELAR_HOST_TOKEN || "tlr_" + randomBytes(32).toString("base64url");

let serverChild = null;

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// The renderer's localStorage is scoped to the window's origin, so the port is
// reused across launches while it is still free.
const portPrefs = jsonPrefs(
  "server-port.json",
  null,
  (data) => {
    const port = Number(data.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  },
  "port",
);

async function getStablePort() {
  const stored = portPrefs.read();
  if (stored !== null && (await isPortFree(stored))) return stored;
  const fresh = await findFreePort();
  portPrefs.write({ port: fresh });
  return fresh;
}

function resolveServerJs() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "standalone", "apps", "web", "server.js")]
    : [path.join(__dirname, "..", "..", "..", "web", ".next-desktop", "standalone", "apps", "web", "server.js")];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `standalone server.js not found (looked in: ${candidates.join(", ")}). ` +
      `Run \`bun run build:app\` first.`,
  );
}

function seatHostHeader(url) {
  if (!attachHostHeader(session.defaultSession, { appUrl: url, token: HOST_TOKEN })) {
    console.error(`[telar-desktop] could not attach the host header for ${url}; the window falls back to its cookie.`);
  }
}

async function seatHostCookie(url) {
  try {
    const { protocol, host } = new URL(url);
    await session.defaultSession.cookies.set({
      url: `${protocol}//${host}`,
      name: "telar_device",
      value: HOST_TOKEN,
      httpOnly: true,
      sameSite: "lax",
    });
  } catch {
  }
}

/** Forks the UI server. `env` is the caller's environment; the server's own keys are laid over it. */
function startServer(port, home, { execPath, env, onExit }) {
  const serverJs = resolveServerJs();
  serverChild = fork(serverJs, [], {
    cwd: path.dirname(serverJs),
    execPath,
    execArgv: ["--require", path.join(__dirname, "..", "preload", "server-preload.js")],
    env: {
      ...env,
      PORT: String(port),
      HOSTNAME: remoteFile.serverBindHost(home),
      TELAR_HOST_TOKEN: HOST_TOKEN,
      TELAR_HOST_CLIENT: app.getName(),
      NODE_ENV: "production",
      TELAR_COCKPIT: "1",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  serverChild.on("exit", (code, signal) => {
    serverChild = null;
    onExit(code, signal);
  });
  return serverChild;
}

function stopServer() {
  if (!serverChild || serverChild.killed) return;
  try {
    serverChild.kill("SIGTERM");
  } catch {
  }
  serverChild = null;
}

function waitForServer(port, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve(port);
        } else {
          retry();
        }
      });
      req.on("error", retry);
      req.setTimeout(2_000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`server did not answer on :${port} within ${timeoutMs}ms`));
      } else {
        setTimeout(tick, intervalMs);
      }
    };
    tick();
  });
}

module.exports = {
  findFreePort,
  getStablePort,
  seatHostHeader,
  seatHostCookie,
  startServer,
  stopServer,
  waitForServer,
};
