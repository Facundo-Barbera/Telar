import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { remoteHome } from "@/lib/remote/store";
import { recordDaemonId, removeHost, renameHost, upsertHost, type Host, type HostsFile } from "./book";

/**
 * `$TELAR_HOME/remote/hosts.json`, read only by the local Next process: the
 * browser never holds a remote's token, since every call goes through the
 * `/api/hosts/:id/…` proxy. Stored in the clear in a 0700 directory, like `engine.json`.
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

function writeHosts(file: HostsFile): void {
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
  // A learned daemonId may match a Mac already in the book under another address.
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

export function publicHost({ id, name, baseUrl, daemonId, addedAt }: Host) {
  return { id, name, baseUrl, ...(daemonId ? { daemonId } : {}), addedAt };
}
export type PublicHost = ReturnType<typeof publicHost>;
