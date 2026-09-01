import net from "node:net";

/**
 * Pure decisions used by the Telar development supervisor.
 *
 * Keeping these separate from child-process code makes the important ownership
 * rules cheap to test: a discovered, healthy engine is attached, never owned.
 */
export function decideEngineStart(probe) {
  return probe === "healthy" ? "attach" : "spawn";
}

/**
 * Next's own default, because this is a Next app and muscle memory should work.
 *
 * IT IS SAFE TO SIT ON THE CROWDED PORT ONLY BECAUSE OF `assertPortFree` BELOW.
 * The reason this used to be a high, unlikely-to-collide number is that Next
 * silently walks to 3001/3002 when 3000 is taken, which would leave the desktop
 * shell and every printed URL pointing at a cockpit that is not the one running.
 * Binding the port ourselves first turns that into a loud "port 3000 is
 * unavailable" instead of a quiet mismatch — so the collision risk is now a
 * clear error rather than a wrong answer. `TELAR_WEB_PORT` overrides.
 */
const DEFAULT_WEB_PORT = 3000;

/** Pick one explicit loopback port for this invocation. Next must receive this
 *  exact value rather than being left to choose. */
export function resolveWebPort(env = process.env) {
  const raw = env.TELAR_WEB_PORT?.trim();
  if (!raw) return DEFAULT_WEB_PORT;
  if (!/^[0-9]+$/.test(raw)) throw new Error("TELAR_WEB_PORT must be an integer between 1 and 65535.");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TELAR_WEB_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export const DEFAULT_WEB_HOST = "127.0.0.1";

/**
 * Which interface the cockpit listens on.
 *
 * LOOPBACK BY DEFAULT, AND THAT DEFAULT IS A SECURITY BOUNDARY RATHER THAN A
 * CONVENIENCE. The cockpit has no authentication of its own: its route handlers
 * proxy to the engine with a token they read server-side, and a session's
 * default runtime mode is `auto`. So whoever can open this port can run shell
 * commands and write files on this machine. Reaching it from another device is
 * a legitimate thing to want — set this to the address of ONE private interface
 * (a Tailscale 100.x.y.z, say) so the tailnet is the boundary.
 *
 * `0.0.0.0` IS ACCEPTED AND IS ALMOST CERTAINLY WRONG. It binds every network
 * the machine is attached to, including whatever café or hotel wifi it joins
 * next. `describeWebExposure` exists to say so out loud at startup rather
 * than leaving it to be discovered.
 */
export function resolveWebHost(env = process.env) {
  const raw = env.TELAR_WEB_HOST?.trim();
  if (!raw) return DEFAULT_WEB_HOST;
  // Deliberately permissive about the FORM (v4, v6, a hostname) and strict
  // about shell-hostile characters: this value is passed to a child process.
  if (!/^[A-Za-z0-9._:\-[\]]+$/.test(raw)) {
    throw new Error("TELAR_WEB_HOST must be a bare host or IP address.");
  }
  return raw;
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** The warning a non-loopback bind earns, or null. Returned rather than printed
 *  so the supervisor decides where it goes and a test can assert it exists. */
export function describeWebExposure(host, port) {
  if (isLoopbackHost(host)) return null;
  const reach = host === "0.0.0.0" || host === "::"
    ? "EVERY network this machine is attached to, including untrusted wifi"
    : `anything that can route to ${host}`;
  return `The cockpit is listening on ${host}:${port}, reachable by ${reach}. It has no login, and sessions run tools without asking by default — treat this port as a shell on this machine.`;
}

/**
 * The louder sibling of `describeWebExposure`, aware of the two facts that
 * change the story: TAILSCALE SERVE COUNTS AS REACHABILITY EVEN ON A LOOPBACK
 * BIND (serve proxies the tailnet straight to 127.0.0.1 — inferring posture
 * from the bind host alone is the mistake t3code ships), and pairing auth is
 * what retires the warning. Returned, not printed, like its sibling.
 */
export function describeRemotePosture({ host, port, serveRequested = false, requireAuth = false }) {
  const remotelyReachable = !isLoopbackHost(host) || serveRequested;
  if (!remotelyReachable) return null;
  if (requireAuth) return null;
  const via = isLoopbackHost(host)
    ? `via Tailscale Serve (the bind is loopback, but the tailnet is proxied to it)`
    : `on ${host}:${port}`;
  return `The cockpit is remotely reachable ${via} with pairing OFF. Enable "Require pairing" in Settings → Remote access, or treat this port as a shell on this machine.`;
}

export function cockpitUrl(port, host = DEFAULT_WEB_HOST) {
  // A bare IPv6 address needs brackets to be a URL authority at all.
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${port}/`;
}

/** Make Next bind to the same deterministic host and port advertised to the desktop. */
export function webDevCommand(port, host = DEFAULT_WEB_HOST) {
  return {
    label: "web",
    args: ["run", "--cwd", "apps/web", "dev", "--", "--hostname", host, "--port", String(port)],
    owned: true,
  };
}

/**
 * Check the explicit port before any owned process starts.  Next is still given
 * `--port`, so a later bind race causes a supervised fatal exit rather than a
 * silent automatic fallback.
 *
 * BOUND ON THE SAME HOST Next will use, not on loopback: a port can be free on
 * 127.0.0.1 and taken on the interface that actually matters, and checking the
 * wrong one reports success and then fails at launch.
 */
export async function assertWebPortAvailable(port, host = DEFAULT_WEB_HOST) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`web port ${port} is unavailable on ${host}: ${error.message}`));
    });
    server.listen({ host, port }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

/** The ordinary door remains browser-only; desktop is explicitly opt-in. */
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
