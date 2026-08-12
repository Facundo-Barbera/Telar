import net from "node:net";

/**
 * Pure decisions used by the vNext development supervisor.
 *
 * Keeping these separate from child-process code makes the important ownership
 * rules cheap to test: a discovered, healthy engine is attached, never owned.
 */
export function decideEngineStart(probe) {
  return probe === "healthy" ? "attach" : "spawn";
}

const DEFAULT_VNEXT_WEB_PORT = 43125;

/**
 * Pick one explicit loopback port for this invocation.  Next must receive this
 * exact value: relying on its automatic 3001/3002 fallback would point the
 * desktop shell at the wrong cockpit.
 */
export function resolveVnextWebPort(env = process.env) {
  const raw = env.TELAR_VNEXT_WEB_PORT?.trim();
  if (!raw) return DEFAULT_VNEXT_WEB_PORT;
  if (!/^[0-9]+$/.test(raw)) throw new Error("TELAR_VNEXT_WEB_PORT must be an integer between 1 and 65535.");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TELAR_VNEXT_WEB_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export function vnextCockpitUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

/** Make Next bind to the same deterministic port advertised to the desktop. */
export function webDevCommand(port) {
  return {
    label: "web",
    args: ["run", "--cwd", "apps/vnext-web", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    owned: true,
  };
}

/**
 * Check the explicit loopback port before any owned process starts.  Next is
 * still given `--port`, so a later bind race causes a supervised fatal exit
 * rather than a silent automatic fallback.
 */
export async function assertVnextWebPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`vNext web port ${port} is unavailable: ${error.message}`));
    });
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

/** The ordinary vNext door remains browser-only; desktop is explicitly opt-in. */
export function shouldLaunchDesktop(args) {
  return args.includes("--desktop");
}

/**
 * Start the existing desktop dev runner without giving it permission to create
 * another Next server. The supervisor owns this process only after it elects
 * this plan, so an independently running desktop is never a shutdown target.
 */
export function desktopDevCommand(cockpitUrl) {
  return {
    label: "desktop",
    args: ["run", "--cwd", "apps/desktop", "dev"],
    env: { TELAR_DESKTOP_URL: cockpitUrl },
    owned: true,
  };
}

/** Only processes spawned by this invocation are eligible for shutdown. */
export function ownedChildrenForShutdown(children) {
  return children.filter((child) => child.owned);
}

/** A worker is mandatory for the supported cockpit door; do not start web without it. */
export function decideWorkerFailure() {
  return { fatal: true, startWeb: false };
}

/** An engine worker is globally registered, so attaching must never duplicate it. */
export function decideWorkerStart(worker) {
  return worker.registered ? "attach" : "spawn";
}

/** Web can start only after the selected worker is known live and registered. */
export function canLaunchCockpit({ workerAction, workerExited, workerRegistered }) {
  return workerAction === "attach" ? workerRegistered : !workerExited && workerRegistered;
}
