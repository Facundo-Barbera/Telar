/**
 * Long-running toolchain work — building an environment, installing a package
 * set, fetching a Python — as JOBS a client polls, rather than as an HTTP
 * request that blocks for two minutes and then says "ok".
 *
 * A job is a list of subprocess steps run in order. Every line either writes
 * lands in a bounded log; a step that exits non-zero fails the job and the
 * rest is skipped. Finished jobs stay readable for ten minutes so a page that
 * was mid-poll when the last line arrived can still show it. No journal event:
 * these are project-scoped and short-lived, and the settings page is already
 * on a timer while a drawer is open.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export type JobStep = {
  /** Shown above the step's output. */
  title: string;
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type JobStatus = "running" | "ok" | "failed" | "cancelled";

export type JobRead = {
  jobId: string;
  kind: string;
  status: JobStatus;
  /** Lines after `after`, oldest first. */
  lines: string[];
  /** Pass back as `after` to read only what is new. */
  cursor: number;
  /** Set when the job finished well: whatever the starter attached. */
  result?: unknown;
  /** Set when it did not. */
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

type Job = {
  jobId: string;
  kind: string;
  /** What two jobs must not share: "<projectId>:<kind>" or similar. */
  lock?: string;
  status: JobStatus;
  lines: string[];
  /** Index of `lines[0]` in the full stream — the ring buffer's offset. */
  dropped: number;
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  child?: ChildProcess;
  cancel: () => void;
};

const MAX_LINES = 2000;
const KEEP_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 4;

export type StartJob = {
  kind: string;
  lock?: string;
  steps: JobStep[];
  /** Runs after the last step succeeds; its return is the job's `result`. */
  onDone?: () => Promise<unknown> | unknown;
};

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  start(input: StartJob): { jobId: string } {
    this.sweep();
    const running = [...this.jobs.values()].filter((job) => job.status === "running");
    if (running.length >= MAX_CONCURRENT) throw new Error(`${MAX_CONCURRENT} environment jobs are already running; wait for one to finish`);
    if (input.lock && running.some((job) => job.lock === input.lock)) throw new Error("a job on this environment is already running");

    const jobId = `job_${randomBytes(6).toString("hex")}`;
    let cancelled = false;
    const job: Job = {
      jobId,
      kind: input.kind,
      ...(input.lock ? { lock: input.lock } : {}),
      status: "running",
      lines: [],
      dropped: 0,
      startedAt: this.now(),
      cancel: () => {
        cancelled = true;
        job.child?.kill("SIGTERM");
      },
    };
    this.jobs.set(jobId, job);

    void (async () => {
      try {
        for (const step of input.steps) {
          if (cancelled) break;
          this.log(job, `$ ${[step.file, ...step.args].join(" ")}`);
          const status = await this.runStep(job, step);
          if (cancelled) break;
          if (status !== 0) {
            job.status = "failed";
            job.error = `${step.title} failed (exit ${status})`;
            job.finishedAt = this.now();
            return;
          }
        }
        if (cancelled) {
          job.status = "cancelled";
          job.error = "cancelled";
        } else {
          job.result = await input.onDone?.();
          job.status = "ok";
        }
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        this.log(job, job.error);
      } finally {
        job.finishedAt = this.now();
        job.child = undefined;
      }
    })();

    return { jobId };
  }

  read(jobId: string, after = 0): JobRead {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("no such job (it may have expired)");
    const start = Math.max(0, after - job.dropped);
    const lines = job.lines.slice(start);
    return {
      jobId,
      kind: job.kind,
      status: job.status,
      lines,
      cursor: job.dropped + job.lines.length,
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    };
  }

  /** Waits for a job to leave `running`. For the agent's tool, which wants an answer, not a cursor. */
  async wait(jobId: string, timeoutMs: number): Promise<JobRead> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const read = this.read(jobId);
      if (read.status !== "running") return read;
      if (this.now() >= deadline) {
        this.cancel(jobId);
        throw new Error(`gave up after ${Math.round(timeoutMs / 1000)} s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  cancel(jobId: string): void {
    this.jobs.get(jobId)?.cancel();
  }

  /** Every job still readable, newest first. */
  list(): JobRead[] {
    this.sweep();
    return [...this.jobs.keys()].map((id) => this.read(id)).sort((a, b) => b.startedAt - a.startedAt);
  }

  disposeAll(): void {
    for (const job of this.jobs.values()) if (job.status === "running") job.cancel();
  }

  private runStep(job: Job, step: JobStep): Promise<number> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(step.file, step.args, {
          cwd: step.cwd,
          env: { ...process.env, ...step.env, PYTHONUNBUFFERED: "1", UV_NO_PROGRESS: "1", CONDA_ALWAYS_YES: "true" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        this.log(job, error instanceof Error ? error.message : String(error));
        resolve(127);
        return;
      }
      job.child = child;
      const pump = (chunk: Buffer, carry: { text: string }) => {
        carry.text += chunk.toString("utf8");
        const parts = carry.text.split(/\r?\n|\r/);
        carry.text = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) this.log(job, line);
      };
      const out = { text: "" };
      const errCarry = { text: "" };
      child.stdout?.on("data", (chunk: Buffer) => pump(chunk, out));
      child.stderr?.on("data", (chunk: Buffer) => pump(chunk, errCarry));
      child.on("error", (error) => {
        this.log(job, error.message);
        resolve(127);
      });
      child.on("close", (code) => {
        for (const carry of [out, errCarry]) if (carry.text.trim()) this.log(job, carry.text);
        resolve(code ?? 1);
      });
    });
  }

  private log(job: Job, line: string): void {
    job.lines.push(line.length > 4000 ? `${line.slice(0, 4000)}…` : line);
    if (job.lines.length > MAX_LINES) {
      const excess = job.lines.length - MAX_LINES;
      job.lines.splice(0, excess);
      job.dropped += excess;
    }
  }

  private sweep(): void {
    const cutoff = this.now() - KEEP_MS;
    for (const [id, job] of this.jobs) if (job.finishedAt && job.finishedAt < cutoff) this.jobs.delete(id);
  }
}
