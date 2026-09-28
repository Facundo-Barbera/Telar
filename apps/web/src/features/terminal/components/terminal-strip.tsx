"use client";

import { PlusIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunGlyph } from "../run/icons";
import { isOpenTerminal, statusDetail, statusLabel, statusTone, type RunTone } from "../run/presentation";
import { activateShell, addShell, shellLabel, type TerminalShell } from "../workspace";
import type { ShellStrip } from "../hooks/use-shell-strip";

// The masthead pill's five-tone vocabulary, so the two never disagree about what green means.
const RUN_TONE_DOT: Record<RunTone, string> = {
  idle: "bg-muted-foreground/40",
  working: "bg-warning",
  good: "bg-success",
  bad: "bg-destructive",
};

const chipButton = "shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground";

function ShellChip({ strip, shell, sessionId }: { strip: ShellStrip; shell: TerminalShell; sessionId: string | undefined }) {
  const { workspace, setWorkspace, run: runs, closeOne } = strip;
  const on = shell.id === workspace.active;
  const label = shellLabel(workspace, shell.id);
  const run = shell.run ? runs.runsById.get(shell.run.runId) : undefined;
  const icon = shell.run ? runs.configs?.find((config) => config.id === shell.run!.configId)?.icon : undefined;
  return (
    <div
      data-testid={shell.run ? "run-tab" : "terminal-tab"}
      className={cn("flex min-w-0 max-w-44 shrink-0 items-center gap-1 rounded-md px-2 py-1", on ? "bg-muted" : "hover:bg-muted/50")}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        void closeOne(shell.id);
      }}
    >
      {shell.run && (
        <>
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", RUN_TONE_DOT[run ? statusTone(run.status) : "idle"])} />
          <RunGlyph icon={icon} className="size-3 shrink-0 opacity-80" />
        </>
      )}
      <button
        type="button"
        role="tab"
        aria-selected={on}
        className="min-w-0 flex-1 truncate text-left text-xs"
        title={run ? `${label} — ${statusLabel(run)}${run.command ? ` · ${run.command}` : ""}` : label}
        onClick={() => setWorkspace(activateShell(workspace, shell.id))}
      >
        {label}
      </button>
      {run?.warning && isOpenTerminal(run) && (
        // A busy port warns and never blocks; the engine's own sentence explains it.
        <span role="img" aria-label={statusDetail(run)} title={statusDetail(run)} className="shrink-0 text-warning">
          <TriangleAlertIcon className="size-3" />
        </span>
      )}
      {shell.run && run && (
        <button
          type="button"
          aria-label={`Restart ${label}`}
          title="Restart — end this and start the same command again"
          className={chipButton}
          onClick={(event) => {
            event.stopPropagation();
            runs.actOnRun(() => runs.runApi.restart(sessionId!, shell.run!.runId));
          }}
        >
          <RotateCwIcon className="size-3" />
        </button>
      )}
      <button
        type="button"
        aria-label={`Close ${label}`}
        title="Close — ends what is running in it"
        className={chipButton}
        onClick={(event) => {
          event.stopPropagation();
          void closeOne(shell.id);
        }}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

/** The browser strip's markup, deliberately: one control learned once. */
export function TerminalStrip({ strip, sessionId }: { strip: ShellStrip; sessionId: string | undefined }) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" role="tablist" aria-label="Terminal tabs">
      {strip.workspace.shells.map((shell) => (
        <ShellChip key={shell.id} strip={strip} shell={shell} sessionId={sessionId} />
      ))}
      <button
        type="button"
        aria-label="New shell"
        title="New shell"
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => strip.setWorkspace(addShell(strip.workspace))}
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}
