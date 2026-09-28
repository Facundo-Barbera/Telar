import { spawn, spawnSync } from "node:child_process";

export type GitResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** Set when the child was killed for outrunning its bound rather than exiting on its own. */
  timedOut?: true;
  overflowed?: true;
  killedPid?: number;
};
export type GitRunOptions = {
  timeoutMs?: number;
  admissionMs?: number;

  env?: Record<string, string>;
};
/** Injectable so tests never need a real repository. */
export type GitRunner = (cwd: string, args: string[], options?: GitRunOptions) => GitResult;

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** The status a timed-out child reports — coreutils' `timeout` convention. */
export const GIT_TIMEOUT_STATUS = 124;

export const DEFAULT_GIT_ADMISSION_MS = 60_000;

export type GitRunnerDeps = {
  /** Which binary to run; `git` from PATH by default. Tests point it at a stalled fake. */
  gitBin?: string;
  defaultTimeoutMs?: number;
  /** ASYNC RUNNER ONLY — how long a call of this pool's may wait for a slot.
   *  See `DEFAULT_GIT_ADMISSION_MS`. */
  defaultAdmissionMs?: number;
};

export function createGitRunner(deps: GitRunnerDeps = {}): GitRunner {
  const gitBin = deps.gitBin ?? "git";
  return (cwd, args, options) => {
    const timeout = Math.max(1, options?.timeoutMs ?? deps.defaultTimeoutMs ?? gitTimeoutFromEnv());
    const run = spawnSync(gitBin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      timeout,
      // SIGKILL, NOT SIGTERM: the stall this guards against is a child stuck
      // in a syscall, and a signal git may handle politely is a signal it may
      // never get around to handling.
      killSignal: "SIGKILL",
    });
    const failure = run.error as { code?: string } | undefined;
    if (failure?.code === "ENOBUFS") {
      return {
        status: 1,
        stdout: run.stdout ?? "",
        stderr: `git ${args.join(" ")} in ${cwd} wrote more than this runner's output bound`,
        overflowed: true,
      };
    }
    // The second clause is the one `execFileSync` used to need and is kept: a
    // child that died on SIGKILL with no status is one this runner killed, even
    // where the platform did not also hand back an ETIMEDOUT.
    if (failure?.code === "ETIMEDOUT" || (run.status == null && run.signal === "SIGKILL")) {
      const killed = typeof run.pid === "number" && run.pid > 0 ? run.pid : undefined;
      return {
        status: GIT_TIMEOUT_STATUS,
        stdout: run.stdout ?? "",
        stderr:
          `git ${args.join(" ")} in ${cwd} did not finish within ${timeout}ms and was killed` +
          (killed === undefined ? "" : ` (pid ${killed})`),
        timedOut: true,
        killedPid: killed,
      };
    }
    if (run.status === 0) return { status: 0, stdout: run.stdout ?? "", stderr: "" };
    return {
      status: run.status ?? 1,
      stdout: run.stdout ?? "",
      // `spawnSync` reports a failure to START in `error` with no stderr at all —
      // a missing binary arrives as ENOENT and `stderr: null` — so the error is
      // what stands in for a message the child never got to write.
      stderr: run.stderr || (run.error ? String(run.error) : `git ${args.join(" ")} in ${cwd} exited with status ${run.status}`),
    };
  };
}

function gitTimeoutFromEnv(): number {
  const raw = Number(process.env.TELAR_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
}

export const defaultGitRunner: GitRunner = createGitRunner();

export type AsyncGitRunner = (cwd: string, args: string[], options?: GitRunOptions) => Promise<GitResult>;

const MAX_GIT_OUTPUT_CHARS = 1024 * 1024;

function killGroup(child: { pid?: number; kill: (signal: NodeJS.Signals) => boolean } | undefined): number | undefined {
  const pid = child?.pid;
  if (child === undefined || typeof pid !== "number" || pid <= 0) return undefined;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return pid;
}

export function createAsyncGitRunner(deps: GitRunnerDeps & { concurrency?: number } = {}): AsyncGitRunner {
  const requestedLimit = deps.concurrency ?? 4;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 4;
  let active = 0;
  const queue: Array<() => void> = [];
  return (cwd, args, options) => new Promise((resolve) => {
    const requested = options?.timeoutMs ?? deps.defaultTimeoutMs ?? gitTimeoutFromEnv();
    const timeout = Number.isFinite(requested) ? Math.max(1, requested) : DEFAULT_GIT_TIMEOUT_MS;
    const requestedAdmission = options?.admissionMs ?? deps.defaultAdmissionMs ?? DEFAULT_GIT_ADMISSION_MS;
    const admission = Number.isFinite(requestedAdmission) ? Math.max(1, requestedAdmission) : DEFAULT_GIT_ADMISSION_MS;
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    let runTimer: ReturnType<typeof setTimeout> | undefined;
    /** Armed ONLY when this call is actually queued — see the bottom of this
     *  function. A call that gets a slot immediately never waited for one. */
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(admissionTimer);
      clearTimeout(runTimer);
      resolve(result);
    };
    let acquired = false;
    let released = false;
    const release = () => {
      if (!acquired || released) return;
      released = true;
      active--;
      queue.shift()?.();
    };
    const expireAdmission = () => {
      const index = queue.indexOf(start);
      if (index !== -1) queue.splice(index, 1);
      // Nothing to kill and nothing to release: this call never held a slot.
      finish({
        status: GIT_TIMEOUT_STATUS,
        stdout: "",
        stderr: `git ${args.join(" ")} in ${cwd} waited ${admission}ms for a slot and never started`,
        timedOut: true,
      });
    };
    const start = () => {
      if (settled) return;
      clearTimeout(admissionTimer);
      runTimer = setTimeout(() => {
        const killed = killGroup(child);
        release();
        finish({
          status: GIT_TIMEOUT_STATUS,
          stdout: "",
          stderr:
            `git ${args.join(" ")} in ${cwd} did not finish within ${timeout}ms and was killed` +
            (killed === undefined ? "" : ` (pid ${killed})`),
          timedOut: true,
          killedPid: killed,
        });
      }, timeout);
      active++;
      acquired = true;
      try {
        child = spawn(deps.gitBin ?? "git", args, {
          cwd,
          // Merged over the engine's own, never replacing it — see the note on
          // `GitRunOptions.env` and the synchronous runner above.
          ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
          // THE ONE LINE THIS ISSUE IS ABOUT: git leads its own process group, so
          // the timeout path can reap what git spawned. `execFile` accepts this
          // option and ignores it (see the header) — the spawn is the fix.
          detached: true,
          // `ignore` matches the synchronous runner: nothing here feeds git on
          // stdin, and /dev/null turns a would-be prompt into an immediate EOF.
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let overflowed = false;
        const collect = (into: "stdout" | "stderr") => (chunk: string) => {
          if (overflowed) return;
          if ((into === "stdout" ? stdout : stderr).length + chunk.length > MAX_GIT_OUTPUT_CHARS) {
            overflowed = true;
            killGroup(child);
            return;
          }
          if (into === "stdout") stdout += chunk;
          else stderr += chunk;
        };
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", collect("stdout"));
        child.stderr?.on("data", collect("stderr"));
        // Anything that goes wrong before the child exists — a missing binary,
        // an unreadable cwd — arrives here rather than as a throw.
        child.on("error", (error) => {
          release();
          finish({ status: 1, stdout, stderr: stderr || String(error) });
        });
        // `close` rather than `exit`: it waits for the stdio pipes as `execFile`'s
        // callback did, which is the semantics every caller was written against.
        // The difference is that a timed-out read no longer waits here at all.
        child.on("close", (code) => {
          release();
          if (overflowed) {
            finish({
              status: 1,
              stdout,
              stderr: `git ${args.join(" ")} in ${cwd} wrote more than ${MAX_GIT_OUTPUT_CHARS} characters`,
              overflowed: true,
            });
            return;
          }
          finish({ status: code ?? 1, stdout, stderr });
        });
      } catch (error) {
        release();
        finish({ status: 1, stdout: "", stderr: String(error) });
      }
    };
    if (active < limit) start();
    else {
      queue.push(start);
      admissionTimer = setTimeout(expireAdmission, admission);
    }
  });
}

export const defaultAsyncGitRunner: AsyncGitRunner = createAsyncGitRunner();
