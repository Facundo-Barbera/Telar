// Telar run initializer (docs/loom-model.md D13, deferred-then-unblocked
// minimal version): a bundle loom's Critic Panel drives "the running
// product" (§4), but a shared, hardcoded `manifest.urls.dev` collides across
// concurrent looms. This gives each loom that has NO static url its own
// throwaway dev server on a free port, and a way to tear it down. No
// worktree isolation yet — D13 names that as a later step; this is the
// minimal "spin up on a free port at loom start, tear down at end" unblock.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import net from "node:net";

export type StartedServer = { url: string; port: number; stop: () => Promise<void> };

export type StartProjectServerOpts = {
  timeoutMs?: number;
  abort?: AbortController;
  // Test seams (never used outside tests): swap the real spawn/poll for
  // fakes so tests never spawn a real long-running process. Default to the
  // real implementations below.
  spawnFn?: (command: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  pollFn?: (url: string, signal: AbortSignal) => Promise<boolean>;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const POLL_ATTEMPT_TIMEOUT_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Bind to port 0 so the OS assigns a free ephemeral port, read it back, then
// release it immediately — there is an inherent (tiny) race between release
// and the child binding, the same tradeoff every "find a free port" helper
// makes.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => (port ? resolve(port) : reject(new Error("could not determine a free port"))));
    });
  });
}

function defaultSpawn(command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  // detached => own process group, so stop() can kill the whole tree
  // (same pattern as gates.ts:runGate).
  return nodeSpawn(command, { shell: true, cwd, env, detached: true, stdio: "ignore" });
}

async function defaultPoll(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { signal });
    return true; // any response (including a non-2xx status) means "up"
  } catch {
    return false;
  }
}

// Kill the whole process group (SIGTERM, then SIGKILL if it doesn't exit in
// time). Falls back to killing just the child when the group kill fails
// (e.g. a fake/non-detached child in tests, or a process that already
// exited) — mirrors gates.ts's timeout-kill fallback.
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      resolve();
    };
    child.once("exit", finish);

    const term = () => {
      try {
        if (!child.pid) throw new Error("no pid");
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          finish(); // nothing left to kill
        }
      }
    };
    term();

    const escalate = setTimeout(() => {
      try {
        if (!child.pid) throw new Error("no pid");
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      // Safety net in case 'exit' never fires for a fake/detached child.
      setTimeout(finish, 200);
    }, 3_000);
  });
}

/**
 * Start `devCommand` in `root` on a free port and wait until it answers.
 * Returns the url/port plus a `stop()` that tears down the whole process
 * tree. Throws (after tearing the process down) if it never answers within
 * `timeoutMs` (default 60s).
 */
export async function startProjectServer(
  root: string,
  devCommand: string,
  opts: StartProjectServerOpts = {},
): Promise<StartedServer> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const pollFn = opts.pollFn ?? defaultPoll;
  const abortSignal = opts.abort?.signal;

  const port = await findFreePort();
  const url = `http://localhost:${port}`;
  const child = spawnFn(devCommand, root, { ...process.env, PORT: String(port) });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await killTree(child);
  };

  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      await stop();
      throw new Error(`startProjectServer: aborted while waiting for "${devCommand}" at ${url}`);
    }
    if (spawnError) {
      const message = (spawnError as Error).message;
      await stop();
      throw new Error(`startProjectServer: failed to spawn "${devCommand}": ${message}`);
    }

    const attemptAbort = new AbortController();
    const onOuterAbort = () => attemptAbort.abort();
    abortSignal?.addEventListener("abort", onOuterAbort);
    const attemptTimer = setTimeout(() => attemptAbort.abort(), POLL_ATTEMPT_TIMEOUT_MS);
    const ready = await pollFn(url, attemptAbort.signal);
    clearTimeout(attemptTimer);
    abortSignal?.removeEventListener("abort", onOuterAbort);

    if (ready) return { url, port, stop };
    await sleep(POLL_INTERVAL_MS);
  }

  await stop();
  throw new Error(`startProjectServer: "${devCommand}" did not respond at ${url} within ${timeoutMs}ms`);
}
