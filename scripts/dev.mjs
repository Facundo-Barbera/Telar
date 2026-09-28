#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
// Root scripts are outside an individual workspace package, so resolve this
// first-party client directly rather than relying on a hoisted workspace link.
// `/node` rather than the root barrel: discovery reads the filesystem and the
// root export is bundled into browser client components.
import { connectEngine } from "../packages/engine-client/src/node.ts";
import {
  decideEngineStart,
  decideWorkerFailure,
  decideWorkerStart,
  canLaunchCockpit,
  assertWebPortAvailable,
  describeWebExposure,
  resolveWebHost,
  desktopDevCommand,
  ownedChildrenForShutdown,
  resolveWebPort,
  shouldLaunchDesktop,
  cockpitUrl as makeCockpitUrl,
  describeRemotePosture,
  defaultTelarHome,
  resolveTelarHome,
  webDevCommand,
} from "./dev-lifecycle.mjs";
import { httpsBaseUrl, probeServe, readStatus, serveTarget, startServe, stopServe } from "./tailscale.mjs";
// THE ONE DEFINITION OF THE remote.json READ RULE (#627), imported rather than
// restated. The direction is what makes this safe where the `tailscale.mjs`
// twin had to be duplicated: a dev script may depend on the desktop app, which
// is always in the repo; the packaged shell must never depend on `scripts/`,
// which cannot be required from an asar.
import { gateWillRequireAuth, tailscaleServeRequested } from "../apps/desktop/src/main/remote-file.js";

const repoDir = path.resolve(import.meta.dirname, "..");
/** What the dogfood home was called while this app was still named vNext. */
const previousTelarHome = path.join(os.homedir(), ".telar-vnext-dogfood");
const children = [];
let stopping = false;
let serveStarted = false;

/**
 * Carry the dogfood home across the rename, once.
 *
 * ONLY THE DEFAULT, and only when the new name is free: an explicit TELAR_HOME
 * is a decision, and moving a directory somebody named themselves would be this
 * script overruling them. Rename rather than copy — atomic, and there is never a
 * moment where two homes both look current.
 *
 * The engine performs the SECOND half of this (`vnext/` → `engine/` inside the
 * home) when it boots. Two migrations, because they belong to two different
 * owners; a launcher that reached inside the store would be renaming a directory
 * the daemon locks.
 */
function migrateDefaultHome(home) {
  if (home !== defaultTelarHome()) return;
  if (fs.existsSync(home) || !fs.existsSync(previousTelarHome)) return;
  fs.renameSync(previousTelarHome, home);
  process.stdout.write(`[telar] moved the dogfood home ${previousTelarHome} -> ${home}\n`);
}

function childEnv(telarHome) {
  // Next's global instrumentation belongs to the legacy product surface. The
  // door must make its client-only role explicit before that hook runs.
  return { ...process.env, TELAR_HOME: telarHome, TELAR_COCKPIT: "1" };
}

function spawnOwned(label, command, args, options = {}) {
  const child = spawn(command, args, { cwd: repoDir, stdio: "inherit", ...options });
  const tracked = { label, child, owned: true };
  children.push(tracked);
  child.once("exit", () => {
    const index = children.indexOf(tracked);
    if (index >= 0) children.splice(index, 1);
  });
  return tracked;
}

async function stopChild(tracked, timeoutMs = 1_500) {
  const child = tracked.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  // Best-effort: a stale serve mapping outlives the process it proxied to.
  if (serveStarted) await stopServe(443).catch(() => undefined);
  await Promise.all(ownedChildrenForShutdown(children).map((tracked) => stopChild(tracked)));
  process.exit(exitCode);
}

/**
 * requireAuth as the GATE will apply it — for the posture line only.
 *
 * A MISSING FILE IS A FRESH STORE, WHICH REQUIRES PAIRING. Mirrors `FRESH` in
 * apps/web/src/features/remote/server/store.ts; without this the warning line would announce an
 * unguarded cockpit on the one install that is guarded by default. An unknown
 * version mirrors `RESET` and reads as OFF, so the line warns about a file the
 * gate has given up on rather than repeating the file's own claim (#627).
 */
function readRequireAuth(telarHome) {
  return gateWillRequireAuth(telarHome);
}

/** The Settings toggle's persisted wish — honoured only with pairing on and a
 *  version this build knows, the same rule the packaged shell applies. */
function readTailscaleServe(telarHome) {
  return tailscaleServeRequested(telarHome);
}

async function probeEngine(engineRoot) {
  try {
    return await (await connectEngine(engineRoot)).health();
  } catch {
    return undefined;
  }
}

async function waitForHealth(engineRoot, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await (await connectEngine(engineRoot)).health();
      if (predicate(health)) return health;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for engine${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

// This script spawns engine, worker, web and desktop, so it alone can hand them one
// browser-control pair and host secret. The pair is minted fresh, never inherited:
// a Telar-inside-Telar shell carries its parent app's.
function mintSharedSecrets(env, launchDesktop) {
  delete env.TELAR_DESKTOP_BROWSER_CONTROL_PORT;
  delete env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN;
  if (launchDesktop) {
    env.TELAR_DESKTOP_BROWSER_CONTROL_PORT = String(19223 + Math.floor(Math.random() * 400));
    env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN = randomBytes(16).toString("hex");
  }
  env.TELAR_HOST_TOKEN = env.TELAR_HOST_TOKEN || "tlr_" + randomBytes(32).toString("base64url");
  env.TELAR_HOST_CLIENT = env.TELAR_HOST_CLIENT || "Telar (dev)";
}

// Read before the web child spawns: its env carries the ts.net origin and endpoint.
// Never spawned unless serve was requested — App Store Tailscale re-prompts TCC per spawn.
async function resolveTailscale(env, serveRequested) {
  if (!serveRequested) return null;
  const tailscale = await readStatus();
  if (!tailscale) {
    console.error("[telar] WARNING: TELAR_TAILSCALE_SERVE=1 but tailscale is not installed or not running; serve skipped.");
    return null;
  }
  if (tailscale.certDomains.length === 0) {
    console.error(
      "[telar] WARNING: this tailnet has HTTPS certificates disabled (enable them at login.tailscale.com/admin/dns); serve skipped.",
    );
    return null;
  }
  env.TELAR_TAILSCALE_URL = httpsBaseUrl(tailscale.certDomains[0]);
  const origins = env.TELAR_WEB_ALLOWED_ORIGINS?.trim();
  env.TELAR_WEB_ALLOWED_ORIGINS = origins ? `${origins},${tailscale.certDomains[0]}` : tailscale.certDomains[0];
  return tailscale;
}

function stopWhenExits(owned, label) {
  owned.child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[telar] ${label} (code=${code} signal=${signal}).`);
      void stop(code || 1);
    }
  });
}

async function startEngine(engineRoot, env) {
  const health = await probeEngine(engineRoot);
  if (decideEngineStart(health ? "healthy" : "unreachable") !== "spawn") {
    process.stdout.write("[telar] attached to existing engine (it will not be stopped here)\n");
    return health;
  }
  stopWhenExits(spawnOwned("engine", process.execPath, ["run", "--cwd", "apps/engine", "dev"], { env }), "owned engine exited before shutdown");
  const started = await waitForHealth(engineRoot, () => true);
  process.stdout.write("[telar] started engine\n");
  return started;
}

async function startWorker(engineRoot, env, health) {
  const workerAction = decideWorkerStart(health.worker);
  const state = { workerAction, workerExited: false, workerRegistered: health.worker.registered };
  if (workerAction !== "spawn") {
    process.stdout.write(`[telar] attached to existing worker ${health.worker.workerId ?? "(registered)"} (it will not be stopped here)\n`);
    return state;
  }
  const worker = spawnOwned("worker", process.execPath, ["run", "--cwd", "apps/engine", "worker"], { env });
  // Attached before waiting for registration, so an early death is fatal and never reaches web startup.
  const workerExit = new Promise((resolve) => worker.child.once("exit", (code, signal) => {
    state.workerExited = true;
    if (!stopping) {
      console.error(`[telar] owned worker exited (code=${code} signal=${signal}).`);
      void stop(code || 1);
    }
    resolve({ code, signal });
  }));
  try {
    await Promise.race([
      waitForHealth(engineRoot, (nextHealth) => nextHealth.worker.registered).then((nextHealth) => {
        state.workerRegistered = nextHealth.worker.registered;
      }),
      workerExit.then(({ code, signal }) => Promise.reject(new Error(`worker exited before registration (code=${code} signal=${signal})`))),
    ]);
  } catch (error) {
    if (decideWorkerFailure().fatal) throw error;
  }
  process.stdout.write("[telar] started worker\n");
  return state;
}

// One-shot: `serve --bg` writes the mapping and exits; its failure must not take down the stack.
async function startTailnetEndpoint(tailscale, webHost, webPort) {
  const outcome = await startServe(443, serveTarget(webHost, webPort));
  if (outcome !== "none") {
    console.error(`[telar] WARNING: tailscale serve failed (${outcome}); the ts.net endpoint is down.`);
    return;
  }
  serveStarted = true;
  const tsUrl = httpsBaseUrl(tailscale.certDomains[0]);
  const reachable = await probeServe(tsUrl);
  process.stdout.write(`[telar] tailnet: ${tsUrl}/ ${reachable ? "" : "(registered; not answering yet)"}\n`);
}

async function main() {
  const telarHome = resolveTelarHome();
  migrateDefaultHome(telarHome);
  const engineRoot = path.join(telarHome, "engine");
  const env = childEnv(telarHome);
  const launchDesktop = shouldLaunchDesktop(process.argv.slice(2));
  mintSharedSecrets(env, launchDesktop);

  const webPort = resolveWebPort(env);
  const webHost = resolveWebHost(env);
  const cockpitUrl = makeCockpitUrl(webPort, webHost);
  // Either the env flag or the Settings toggle asks for a ts.net endpoint.
  const serveRequested = env.TELAR_TAILSCALE_SERVE === "1" || readTailscaleServe(telarHome);
  await assertWebPortAvailable(webPort, webHost);
  process.stdout.write(`[telar] TELAR_HOME=${telarHome}\n`);
  // Printed BEFORE anything starts listening, and to stderr: a warning about
  // exposing a shell should not be the line that scrolls past in a happy log.
  const exposure = describeWebExposure(webHost, webPort);
  if (exposure) console.error(`[telar] WARNING: ${exposure}`);
  const posture = describeRemotePosture({
    host: webHost,
    port: webPort,
    serveRequested,
    requireAuth: readRequireAuth(telarHome),
  });
  if (posture) console.error(`[telar] WARNING: ${posture}`);

  const tailscale = await resolveTailscale(env, serveRequested);
  const health = await startEngine(engineRoot, env);
  if (!health) throw new Error("engine did not return health after startup.");
  if (!canLaunchCockpit(await startWorker(engineRoot, env, health))) {
    throw new Error("worker is not live and registered; refusing to start the cockpit.");
  }

  // The web client discovers the engine from TELAR_HOME on each server request.
  // Do not pass host, port, token, or a discovery snapshot: an engine restart must
  // be discoverable rather than pinning web to stale credentials.
  const webCommand = webDevCommand(webPort, webHost);
  stopWhenExits(spawnOwned(webCommand.label, process.execPath, webCommand.args, { env }), "web cockpit exited");
  process.stdout.write(`[telar] cockpit: ${cockpitUrl}\n`);

  if (tailscale) await startTailnetEndpoint(tailscale, webHost, webPort);

  if (launchDesktop) {
    const desktopCommand = desktopDevCommand(cockpitUrl);
    const desktop = spawnOwned(desktopCommand.label, process.execPath, desktopCommand.args, {
      env: { ...env, ...desktopCommand.env },
    });
    stopWhenExits(desktop, "owned desktop exited");
    process.stdout.write(`[telar] desktop: ${cockpitUrl}\n`);
  }
}

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));
void main().catch((error) => {
  console.error(`[telar] ${error instanceof Error ? error.message : String(error)}`);
  void stop(1);
});
