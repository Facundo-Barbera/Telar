"use client";

import { useMemo, useState } from "react";
import { CheckIcon, ChevronRightIcon, CircleSlashIcon, ClockIcon, ExternalLinkIcon, GripVerticalIcon, XIcon } from "lucide-react";
import type { GitHubCheck } from "@telar/engine-client";
import { PanelDivider } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { checkReference, failingChecksReference, startReferenceDrag } from "@/lib/drag-reference";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { checkHeadline, checkSummary } from "../github-forge";
import { cn } from "@/lib/utils";
import { checkRunning, hasFailed, isNotable, type CheckLogState } from "../model";

const api = createEngineApi();

function CheckGlyph({ check }: { check: GitHubCheck }) {
  if (checkRunning(check)) return <ClockIcon className="size-3 text-primary" />;
  const conclusion = check.conclusion!.toUpperCase();
  if (conclusion === "SUCCESS") return <CheckIcon className="size-3 text-success" />;
  if (conclusion === "SKIPPED" || conclusion === "NEUTRAL" || conclusion === "CANCELLED") return <CircleSlashIcon className="size-3 text-muted-foreground" />;
  return <XIcon className="size-3 text-destructive" />;
}

const withLog = (check: GitHubCheck, log: CheckLogState | undefined) => ({
  ...check,
  ...(log && "lines" in log && log.lines ? { log: log.lines, logTruncated: log.truncated } : {}),
});

function CheckLog({ log }: { log: CheckLogState | undefined }) {
  if (log?.loading) {
    return (
      <p className="flex items-center gap-2 text-3xs text-muted-foreground">
        <Spinner className="size-3" /> reading the failing step…
      </p>
    );
  }
  if (log?.unavailable !== undefined) return <p className="text-3xs leading-snug text-muted-foreground">{log.unavailable}</p>;
  if (!log?.lines) return null;
  return (
    <>
      <pre className="max-h-64 overflow-auto rounded border border-border bg-card p-1.5 font-mono text-3xs leading-snug whitespace-pre-wrap">{log.lines.join("\n")}</pre>
      {log.truncated && <p className="mt-0.5 text-3xs text-muted-foreground">The last {log.lines.length} lines.</p>}
    </>
  );
}

/** Draggable; a failed check opens to the tail of its log, which the drag then carries. */
function CheckRow({ check, projectId, log, onLog }: { check: GitHubCheck; projectId: string; log: CheckLogState | undefined; onLog: (jobId: string, state: CheckLogState) => void }) {
  const [open, setOpen] = useState(false);
  const canOpen = hasFailed(check) && Boolean(check.jobId);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    const jobId = check.jobId;
    if (!next || !jobId || log) return;
    onLog(jobId, { loading: true });
    void api
      .projectCheckLog(projectId, jobId)
      .then((read) => onLog(jobId, "unavailable" in read.log ? { unavailable: read.log.unavailable } : { ...read.log }))
      .catch((cause) => onLog(jobId, { unavailable: cause instanceof EngineApiError ? cause.message : "The log could not be read." }));
  };

  return (
    <div className="min-w-0">
      <div
        draggable
        onDragStart={(event) => startReferenceDrag(event.dataTransfer, checkReference(withLog(check, log)))}
        title={`${check.workflow ? `${check.workflow} · ` : ""}${check.name} — drag into the message to reference it`}
        className="flex min-w-0 cursor-grab items-center gap-1.5 text-2xs active:cursor-grabbing"
      >
        <CheckGlyph check={check} />
        {canOpen ? (
          <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground">
            <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
            <span className="min-w-0 truncate">{check.name}</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate">{check.name}</span>
        )}
        {check.workflow && check.workflow !== check.name && <span className="max-w-24 shrink-0 truncate text-3xs text-muted-foreground">{check.workflow}</span>}
        {check.url && (
          <a
            href={check.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${check.name} on GitHub`}
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3" />
          </a>
        )}
      </div>
      {open && (
        <div className="mt-1 mb-2 ml-4">
          <CheckLog log={log} />
        </div>
      )}
    </div>
  );
}

/** The head commit's checks: failing and unfinished ones open, green ones behind a disclosure. */
export function ChecksBlock({ checks, projectId }: { checks: readonly GitHubCheck[]; projectId: string }) {
  const summary = useMemo(() => checkSummary(checks), [checks]);
  const notable = checks.filter(isNotable);
  const quiet = checks.filter((check) => !isNotable(check));
  const failing = checks.filter(hasFailed);
  const [showAll, setShowAll] = useState(false);
  // Keyed by job id so a log survives the disclosure collapsing and the drag can still send it.
  const [logs, setLogs] = useState<Record<string, CheckLogState>>({});
  const noteLog = (jobId: string, state: CheckLogState) => setLogs((current) => ({ ...current, [jobId]: state }));
  const logOf = (check: GitHubCheck) => (check.jobId ? logs[check.jobId] : undefined);

  return (
    <>
      <PanelDivider label="checks" />
      {summary.total === 0 ? (
        <p className="px-3 pb-3 text-2xs text-muted-foreground">No checks ran on this commit.</p>
      ) : (
        <div className="flex flex-col gap-1 px-3 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <p className={cn("min-w-0 flex-1 truncate text-2xs", summary.failed > 0 ? "text-destructive" : "text-muted-foreground")}>{checkHeadline(summary)}</p>
            {failing.length > 0 && (
              <span
                draggable
                onDragStart={(event) => startReferenceDrag(event.dataTransfer, failingChecksReference(failing.map((check) => withLog(check, logOf(check)))))}
                title={`Drag ${failing.length === 1 ? "this failure" : `all ${failing.length} failures`} into the message`}
                className="inline-flex shrink-0 cursor-grab items-center gap-1 rounded border border-destructive/40 px-1 py-0 text-4xs text-destructive active:cursor-grabbing"
              >
                <GripVerticalIcon className="size-2.5" />
                {failing.length === 1 ? "drag the failure" : `drag all ${failing.length}`}
              </span>
            )}
          </div>
          {notable.map((check, at) => (
            <CheckRow key={`${check.name}-${at}`} check={check} projectId={projectId} log={logOf(check)} onLog={noteLog} />
          ))}
          {quiet.length > 0 &&
            (showAll ? (
              quiet.map((check, at) => <CheckRow key={`quiet-${check.name}-${at}`} check={check} projectId={projectId} log={undefined} onLog={noteLog} />)
            ) : (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="self-start text-3xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                show {quiet.length} that {quiet.length === 1 ? "passed or was skipped" : "passed or were skipped"}
              </button>
            ))}
        </div>
      )}
    </>
  );
}
