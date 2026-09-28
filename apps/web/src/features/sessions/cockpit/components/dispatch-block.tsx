"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRightIcon, UsersIcon } from "lucide-react";
import { notificationHead, ROW } from "@/features/transcript";
import { MessageResponse } from "@/ui/message";
import { cn } from "@/ui/utils";
import { sessionHref } from "../../session-list";
import { dispatchSummary, type DispatchBlock, type DispatchWorker, type WorkerState } from "../dispatch";

export type SessionDirectory = ReadonlyMap<string, { title?: string; projectId?: string }>;

const STATE_TONE: Record<WorkerState, string> = {
  working: "text-muted-foreground",
  result: "text-muted-foreground",
  blocker: "text-warning",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

function WorkerLine({ worker, directory, hostId, projectId }: { worker: DispatchWorker; directory: SessionDirectory; hostId?: string; projectId?: string }) {
  const [open, setOpen] = useState(false);
  const known = directory.get(worker.sessionId);
  const title = known?.title?.trim() || `session …${worker.sessionId.slice(-6)}`;
  const head = notificationHead(worker.message);
  const home = known?.projectId ?? projectId;
  return (
    <li className="min-w-0" aria-label={`Session ${title}`}>
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" className={cn(ROW, "min-w-0 flex-1")} disabled={!worker.message} aria-expanded={worker.message ? open : undefined} onClick={() => setOpen((current) => !current)}>
          <span className="min-w-0 max-w-[40%] shrink-0 truncate">{title}</span>
          <span className={cn("shrink-0 text-2xs", STATE_TONE[worker.state])}>{worker.state}</span>
          {head && <span className="min-w-0 truncate text-2xs text-muted-foreground">{head}</span>}
          {worker.message && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
        </button>
        {home && (
          <Link
            href={sessionHref({ id: worker.sessionId, projectId: home, ...(hostId ? { hostId } : {}) })}
            className="shrink-0 rounded px-1 text-3xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Open ▸
          </Link>
        )}
      </div>
      {open && worker.message && (
        <div className="ml-3 max-h-96 overflow-auto border-l border-border/70 py-1 pr-1.5 pl-3 text-xs">
          <MessageResponse streaming={false}>{worker.message}</MessageResponse>
        </div>
      )}
    </li>
  );
}

export function DispatchBlockView({ block, directory, hostId, projectId }: { block: DispatchBlock; directory: SessionDirectory; hostId?: string; projectId?: string }) {
  return (
    <section className="mx-auto w-full min-w-0 max-w-[50rem] rounded-md border border-border/60 py-1" aria-label="Dispatched sessions">
      <p className="flex items-center gap-1.5 px-1.5 py-1 text-xs">
        <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span>{dispatchSummary(block.workers)}</span>
      </p>
      <ul>
        {block.workers.map((worker) => (
          <WorkerLine key={worker.sessionId} worker={worker} directory={directory} {...(hostId ? { hostId } : {})} {...(projectId ? { projectId } : {})} />
        ))}
      </ul>
    </section>
  );
}
