import { spawnSync } from "node:child_process";

export type RunKill = (pid: number, signal: NodeJS.Signals | 0) => void;

type GroupLiveness = "alive" | "gone" | "unanswerable";

export type RunProcessGroup = {
  readonly detached: boolean;
  stop(pid: number, force: boolean, signal?: NodeJS.Signals): void;
  emptied(pid: number): boolean;
  liveness(pid: number): GroupLiveness;
};

export function posixProcessGroup(kill: RunKill): RunProcessGroup {
  const liveness = (pid: number): GroupLiveness => {
    try {
      kill(-pid, 0);
      return "alive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "alive";
    }
  };
  return {
    detached: true,
    stop(pid, force, signal) {
      try {
        kill(-pid, force ? "SIGKILL" : (signal ?? "SIGTERM"));
      } catch (error) {
        // macOS answers EPERM for a group whose members have all died but are not reaped yet:
        // there is nothing left to signal. Our own spawned group cannot belong to another user.
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    },
    emptied: (pid) => liveness(pid) === "gone",
    liveness,
  };
}

export type RunTaskkill = (args: readonly string[]) => { status: number | null; stderr: string };

const TASKKILL_NOT_FOUND = 128;

export function windowsProcessGroup(taskkill: RunTaskkill = systemTaskkill): RunProcessGroup {
  const terminated = new Set<number>();
  const remember = (pid: number) => {
    if (terminated.size >= 256) terminated.delete(terminated.values().next().value!);
    terminated.add(pid);
  };
  return {
    detached: false,
    stop(pid, force) {
      const result = taskkill(force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"]);
      if (result.status === 0) {
        if (force) remember(pid);
        return;
      }
      if (result.status === TASKKILL_NOT_FOUND) {
        const gone = new Error(`there is no process ${pid} to stop`) as NodeJS.ErrnoException;
        gone.code = "ESRCH";
        throw gone;
      }
      if (!force) return;
      throw new Error(`taskkill could not stop the process tree led by ${pid}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
    },
    emptied: () => false,
    liveness: (pid) => (terminated.has(pid) ? "gone" : "unanswerable"),
  };
}

const systemTaskkill: RunTaskkill = (args) => {
  const result = spawnSync("taskkill", [...args], { encoding: "utf8", windowsHide: true });
  if (result.error) return { status: 1, stderr: result.error.message };
  return { status: result.status, stderr: result.stderr ?? "" };
};

export function processGroupFor(platform: NodeJS.Platform, kill: RunKill): RunProcessGroup {
  return platform === "win32" ? windowsProcessGroup() : posixProcessGroup(kill);
}
