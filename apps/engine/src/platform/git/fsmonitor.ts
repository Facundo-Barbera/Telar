import { lsof } from "../process/lsof";
import type { AsyncGitRunner } from "./runner";

const SOCKET = "fsmonitor--daemon.ipc";

type Daemon = { socket: boolean; root?: { fd: number; name: string } };

// A daemon chdirs to $HOME and binds its socket by basename when the path is long, so
// neither names the checkout. The watcher opens the checkout first, then its ancestors.
export function fsmonitorCheckouts(listing: string): string[] {
  const daemons = new Map<string, Daemon>();
  let current: Daemon | undefined;
  let fd: number | undefined;
  let type: string | undefined;
  for (const line of listing.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) {
      current = { socket: false };
      daemons.set(value, current);
    } else if (line.startsWith("f")) {
      fd = /^\d+$/.test(value) ? Number(value) : undefined;
      type = undefined;
    } else if (line.startsWith("t")) type = value;
    else if (line.startsWith("n") && current && fd !== undefined) {
      if (type === "unix" && value.split("/").pop() === SOCKET) current.socket = true;
      else if (type === "DIR" && (!current.root || fd < current.root.fd)) current.root = { fd, name: value };
    }
  }
  return [...daemons.values()].flatMap((daemon) => (daemon.socket && daemon.root ? [daemon.root.name] : []));
}

export async function liveFsmonitorCheckouts(deps: { platform?: NodeJS.Platform; lsof?: () => Promise<string | undefined> } = {}): Promise<string[] | undefined> {
  if ((deps.platform ?? process.platform) === "win32") return undefined;
  const listing = await (deps.lsof ?? (() => lsof(["-n", "-P", "-w", "-c", "git", "-F", "pftn"], 10_000)))();
  return listing === undefined ? undefined : fsmonitorCheckouts(listing);
}

export async function stopFsmonitor(git: AsyncGitRunner, checkout: string): Promise<void> {
  await git(checkout, ["fsmonitor--daemon", "stop"], { timeoutMs: 5_000 }).catch(() => undefined);
}
