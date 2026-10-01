import type { ChildProcess } from "node:child_process";

/** Spawn option: the child leads its own process group, so `signalGroup` reaches what it spawns. */
export const OWN_GROUP = process.platform !== "win32";

export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (OWN_GROUP && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

/** SIGTERM the child's group, then SIGKILL it after `graceMs`: a grandchild can outlive the leader. */
export function stopGroup(child: ChildProcess, graceMs = 2_000): void {
  signalGroup(child, "SIGTERM");
  setTimeout(() => signalGroup(child, "SIGKILL"), graceMs).unref();
}
