import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { remoteHome } from "@/lib/remote/store";
import { recordDaemonId, removeHost, renameHost, upsertHost, type Host, type HostsFile } from "./book";

/**
 * WHERE THE OTHER MACS LIVE: `$TELAR_HOME/remote/hosts.json`, beside the
 * pairing store, because it is the same kind of fact — who this cockpit is
 * connected to — read by the same process.
 *
 * SERVER-SIDE, IN THE LOCAL NEXT PROCESS, and that is the design decision of
 * this feature. The browser never holds a remote's device token: every call to
 * another Mac goes through this cockpit's own `/api/hosts/:id/…` proxy, which
 * adds the bearer. That keeps the token out of the renderer, keeps the desktop
 * shell's per-launch host cookie the only credential a window carries, and
 * sidesteps CORS entirely — a remote cockpit never sees a cross-origin request.
 *
 * The token is stored in the clear, with the same reasoning as the engine's
 * own `engine.json`: this directory is mode 0700 on a machine the person owns,
 * and hashing it would leave nothing to send.
 */
export function hostsPath(): string {
  return path.join(remoteHome(), "hosts.json");
}

const EMPTY: HostsFile = { version: 1, hosts: [] };

export function readHosts(): HostsFile {
  const file = hostsPath();
  if (!fs.existsSync(file)) return { ...EMPTY, hosts: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as HostsFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) return { ...EMPTY, hosts: [] };
  return parsed;
}

export function writeHosts(file: HostsFile): void {
  const target = hostsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function findHost(id: string): Host | undefined {
  return readHosts().hosts.find((host) => host.id === id);
}

export function addHost(input: { baseUrl: string; deviceToken: string; name?: string; daemonId?: string }): Host {
  const file = readHosts();
  const { hosts, result } = upsertHost(file.hosts, input, Date.now(), () => "host_" + crypto.randomBytes(8).toString("hex"));
  let next = hosts;
  // A daemonId learned at pairing may name a Mac already in the book under
  // another address — fold the two rows into one before writing.
  if (input.daemonId) next = recordDaemonId(next, result.host.id, input.daemonId).hosts;
  writeHosts({ ...file, hosts: next });
  return next.find((host) => host.daemonId === input.daemonId || host.id === result.host.id) ?? result.host;
}

export function learnDaemonId(id: string, daemonId: string): void {
  const file = readHosts();
  const { hosts, merged } = recordDaemonId(file.hosts, id, daemonId);
  const before = file.hosts.find((host) => host.id === id);
  if (!merged && before?.daemonId === daemonId) return;
  writeHosts({ ...file, hosts });
}

export function renameStoredHost(id: string, name: string): Host | undefined {
  const file = readHosts();
  if (!file.hosts.some((host) => host.id === id)) return undefined;
  const hosts = renameHost(file.hosts, id, name);
  writeHosts({ ...file, hosts });
  return hosts.find((host) => host.id === id);
}

export function removeStoredHost(id: string): boolean {
  const file = readHosts();
  if (!file.hosts.some((host) => host.id === id)) return false;
  writeHosts({ ...file, hosts: removeHost(file.hosts, id) });
  return true;
}

/** What a browser may know about a host: everything but the token. */
export function publicHost({ id, name, baseUrl, daemonId, addedAt }: Host) {
  return { id, name, baseUrl, ...(daemonId ? { daemonId } : {}), addedAt };
}
export type PublicHost = ReturnType<typeof publicHost>;
