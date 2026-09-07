"use client";

/**
 * A TOOLCHAIN JOB'S LOG, AS IT HAPPENS. Installing pandas takes forty seconds
 * and fetching a Python takes two minutes; a button that spins for that long
 * and then says "done" (or "failed") is a button nobody trusts. So every job
 * opens this: the engine's line-by-line log, polled by cursor while the job
 * runs, with the status line on top and Cancel while it can still be
 * cancelled. A failure stays on screen until dismissed — the last lines are
 * the diagnosis.
 */
import { useEffect, useRef, useState } from "react";
import { CheckIcon, CircleXIcon, XIcon } from "lucide-react";
import type { DataScienceJob } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createEngineApi();

export type JobHandle = { jobId: string; title: string };

/** Which job endpoints a log polls. Data science is the default; the LaTeX
 *  section passes its own pair — the component is otherwise identical. */
export type JobIo = {
  read: (jobId: string, after: number) => Promise<{ job: DataScienceJob }>;
  cancel: (jobId: string) => Promise<unknown>;
};

const DS_IO: JobIo = {
  read: (jobId, after) => api.dataScienceJob(jobId, after),
  cancel: (jobId) => api.dataScienceCancelJob(jobId),
};

/** Polls the job; calls `onDone` once with the final read. */
export function useJob(handle: JobHandle | undefined, onDone?: (job: DataScienceJob) => void, io: JobIo = DS_IO) {
  const [job, setJob] = useState<DataScienceJob>();
  const [lines, setLines] = useState<string[]>([]);
  // The latest `onDone` without re-arming the poll: written in an effect, read by the tick.
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!handle) return;
    let cursor = 0;
    let cancelled = false;
    let timer: number | undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new job resets the log
    setLines([]);
    setJob(undefined);
    const tick = async () => {
      try {
        const { job: read } = await io.read(handle.jobId, cursor);
        if (cancelled) return;
        cursor = read.cursor;
        if (read.lines.length) setLines((prev) => [...prev, ...read.lines].slice(-2000));
        setJob(read);
        if (read.status === "running") timer = window.setTimeout(() => void tick(), 500);
        else done.current?.(read);
      } catch (error) {
        if (cancelled) return;
        setJob({ jobId: handle.jobId, kind: "?", status: "failed", lines: [], cursor, error: error instanceof Error ? error.message : "lost the job", startedAt: 0 });
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `io` is a stable endpoint pair, not state
  }, [handle]);

  return { job, lines };
}

export function JobLog({ handle, onDone, onDismiss, className, io = DS_IO }: { handle: JobHandle; onDone?: (job: DataScienceJob) => void; onDismiss: () => void; className?: string; io?: JobIo }) {
  const { job, lines } = useJob(handle, onDone, io);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    pre.current?.scrollTo({ top: pre.current.scrollHeight });
  }, [lines.length]);

  const running = !job || job.status === "running";
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-md border border-border bg-muted/20", className)} role="status" aria-live="polite">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
        {running ? <Spinner className="size-3" /> : job.status === "ok" ? <CheckIcon className="size-3 text-success" /> : <CircleXIcon className="size-3 text-destructive" />}
        <span className="min-w-0 flex-1 truncate font-medium">{handle.title}</span>
        <span className="text-muted-foreground">{running ? "Running…" : job.status === "ok" ? "Done" : job.status === "cancelled" ? "Cancelled" : job.error ?? "Failed"}</span>
        {running ? (
          <Button variant="ghost" size="xs" onClick={() => void io.cancel(handle.jobId)}>Cancel</Button>
        ) : (
          <button type="button" aria-label="Dismiss" onClick={onDismiss} className="rounded p-0.5 text-muted-foreground hover:text-foreground"><XIcon className="size-3" /></button>
        )}
      </div>
      <pre ref={pre} className="m-0 max-h-48 min-h-16 overflow-auto px-3 py-2 font-mono text-[0.625rem] leading-[1.5] whitespace-pre-wrap text-muted-foreground">
        {lines.length ? lines.join("\n") : running ? "Starting…" : ""}
      </pre>
    </div>
  );
}
