import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordDaemonId, removeHost, renameHost, upsertHost, type Host, type HostsFile } from "./book";

const EMPTY: HostsFile = { version: 1, hosts: [] };

export function publicHost({ id, name, baseUrl, daemonId, addedAt }: Host) {
  return { id, name, baseUrl, ...(daemonId ? { daemonId } : {}), addedAt };
}

export function createHostsStore(dir: string) {
  const file = path.join(dir, "hosts.json");

  function read(): HostsFile {
    if (!fs.existsSync(file)) return { ...EMPTY, hosts: [] };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as HostsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) return { ...EMPTY, hosts: [] };
    return parsed;
  }

  function write(next: HostsFile): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    path: file,
    read,
    find: (id: string): Host | undefined => read().hosts.find((host) => host.id === id),

    add(input: { baseUrl: string; deviceToken: string; name?: string; daemonId?: string }): Host {
      const current = read();
      const { hosts, result } = upsertHost(current.hosts, input, Date.now(), () => "host_" + crypto.randomBytes(8).toString("hex"));
      const next = input.daemonId ? recordDaemonId(hosts, result.host.id, input.daemonId).hosts : hosts;
      write({ ...current, hosts: next });
      return next.find((host) => host.daemonId === input.daemonId || host.id === result.host.id) ?? result.host;
    },

    rename(id: string, name: string): Host | undefined {
      const current = read();
      if (!current.hosts.some((host) => host.id === id)) return undefined;
      const hosts = renameHost(current.hosts, id, name);
      write({ ...current, hosts });
      return hosts.find((host) => host.id === id);
    },

    remove(id: string): boolean {
      const current = read();
      if (!current.hosts.some((host) => host.id === id)) return false;
      write({ ...current, hosts: removeHost(current.hosts, id) });
      return true;
    },
  };
}

export type HostsStore = ReturnType<typeof createHostsStore>;
