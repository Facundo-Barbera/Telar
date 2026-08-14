#!/usr/bin/env bun
import { spawn } from "node:child_process";
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
  webDevCommand,
} from "./dev-lifecycle.mjs";

const repoDir = path.resolve(import.meta.dirname, "..");
const defaultTelarHome = path.join(os.homedir(), ".telar-dogfood");
/** What the dogfood home was called while this app was still named vNext. */
const previousTelarHome = path.join(os.homedir(), ".telar-vnext-dogfood");
const legacyHomes = new Set([path.join(os.homedir(), ".telar"), path.join(os.homedir(), ".telar-dev")]);
const children = [];
let stopping = false;

function resolveTelarHome(env = process.env) {
  const selected = env.TELAR_HOME?.trim() || defaultTelarHome;
  if (!path.isAbsolute(selected)) throw new Error("TELAR_HOME for Telar must be an absolute dedicated directory.");
  const resolved = path.resolve(selected);
  if (legacyHomes.has(resolved)) {
    throw new Error(`Refusing to use legacy TELAR_HOME ${resolved}. Set TELAR_HOME to a dedicated dogfood directory.`);
  }
  return resolved;
}

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
  if (home !== defaultTelarHome) return;
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
  await Promise.all(ownedChildrenForShutdown(children).map((tracked) => stopChild(tracked)));
  process.exit(exitCode);
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

async function main() {
  const telarHome = resolveTelarHome();
  migrateDefaultHome(telarHome);
  const engineRoot = path.join(telarHome, "engine");
  const env = childEnv(telarHome);
  const launchDesktop = shouldLaunchDesktop(process.argv.slice(2));
  const webPort = resolveWebPort(env);
  const webHost = resolveWebHost(env);
  const cockpitUrl = makeCockpitUrl(webPort, webHost);
  await assertWebPortAvailable(webPort, webHost);
  process.stdout.write(`[telar] TELAR_HOME=${telarHome}\n`);
  // Printed BEFORE anything starts listening, and to stderr: a warning about
  // exposing a shell should not be the line that scrolls past in a happy log.
  const exposure = describeWebExposure(webHost, webPort);
  if (exposure) console.error(`[telar] WARNING: ${exposure}`);

  let health = await probeEngine(engineRoot);
  const engineAction = decideEngineStart(health ? "healthy" : "unreachable");
  if (engineAction === "spawn") {
    const engine = spawnOwned("engine", process.execPath, ["run", "--cwd", "apps/engine", "dev"], { env });
    engine.child.once("exit", (code, signal) => {
      if (!stopping) {
        console.error(`[telar] owned engine exited before shutdown (code=${code} signal=${signal}).`);
        void stop(code || 1);
      }
    });
    health = await waitForHealth(engineRoot, () => true);
    process.stdout.write("[telar] started engine\n");
  } else {
    process.stdout.write("[telar] attached to existing engine (it will not be stopped here)\n");
  }

  if (!health) throw new Error("engine did not return health after startup.");
  const workerAction = decideWorkerStart(health.worker);
  let workerExited = false;
  let workerRegistered = health.worker.registered;
  if (workerAction === "spawn") {
    const worker = spawnOwned("worker", process.execPath, ["run", "--cwd", "apps/engine", "worker"], { env });
    // Attach this handler before waiting for registration.  It both makes an
    // early death fatal and prevents this function from reaching web startup.
    const workerExit = new Promise((resolve) => worker.child.once("exit", (code, signal) => {
      workerExited = true;
      if (!stopping) {
        console.error(`[telar] owned worker exited (code=${code} signal=${signal}).`);
        void stop(code || 1);
      }
      resolve({ code, signal });
    }));
    try {
      await Promise.race([
        waitForHealth(engineRoot, (nextHealth) => nextHealth.worker.registered).then((nextHealth) => {
          workerRegistered = nextHealth.worker.registered;
        }),
        workerExit.then(({ code, signal }) => Promise.reject(new Error(`worker exited before registration (code=${code} signal=${signal})`))),
      ]);
    } catch (error) {
      const outcome = decideWorkerFailure();
      if (outcome.fatal) throw error;
    }
    process.stdout.write("[telar] started worker\n");
  } else {
    process.stdout.write(`[telar] attached to existing worker ${health.worker.workerId ?? "(registered)"} (it will not be stopped here)\n`);
  }

  if (!canLaunchCockpit({ workerAction, workerExited, workerRegistered })) {
    throw new Error("worker is not live and registered; refusing to start the cockpit.");
  }

  // The web client discovers the engine from TELAR_HOME on each server request.
  // Do not pass host, port, token, or a discovery snapshot: an engine restart must
  // be discoverable rather than pinning web to stale credentials.
  const webCommand = webDevCommand(webPort, webHost);
  const web = spawnOwned(webCommand.label, process.execPath, webCommand.args, { env });
  web.child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[telar] web cockpit exited (code=${code} signal=${signal}).`);
      void stop(code || 1);
    }
  });
  process.stdout.write(`[telar] cockpit: ${cockpitUrl}\n`);

  if (launchDesktop) {
    const desktopCommand = desktopDevCommand(cockpitUrl);
    const desktop = spawnOwned(desktopCommand.label, process.execPath, desktopCommand.args, {
      env: { ...env, ...desktopCommand.env },
    });
    desktop.child.once("exit", (code, signal) => {
      if (!stopping) {
        console.error(`[telar] owned desktop exited (code=${code} signal=${signal}).`);
        void stop(code || 1);
      }
    });
    process.stdout.write(`[telar] desktop: ${cockpitUrl}\n`);
  }
}

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));
void main().catch((error) => {
  console.error(`[telar] ${error instanceof Error ? error.message : String(error)}`);
  void stop(1);
});
