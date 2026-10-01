import { spawn } from "node:child_process";

/** lsof's stdout, or undefined when it cannot run or times out. */
export function lsof(args: readonly string[], timeoutMs = 30_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("lsof", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    // lsof exits 1 when some process could not be read, or nothing matched; the rest is still an answer.
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve(status === 0 || status === 1 ? out : undefined);
    });
  });
}
