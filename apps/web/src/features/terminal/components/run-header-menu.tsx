"use client";

import { CircleStopIcon, Loader2Icon, PlusIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RunGlyph } from "../run/icons";
import { openCount, statusDetail, statusLabel, statusTone, terminalTitle, type RunTone } from "../run/presentation";
import type { RunConfigurationView, RunView } from "../run/types";
import type { RunHeader } from "../hooks/use-run-header";
import { RunConfigEditor } from "./run-config-editor";

export const TONE_DOT: Record<RunTone, string> = {
  idle: "bg-muted-foreground/40",
  working: "bg-warning",
  good: "bg-success",
  bad: "bg-destructive",
};

const heading = "px-2 pt-1 text-3xs font-medium tracking-wide text-muted-foreground uppercase";

/** One open terminal with End. A warning shows in full here, the one place with room for the engine's sentence. */
function OpenTerminalRow({ view, config, busy, onEnd }: { view: RunView; config: RunConfigurationView | undefined; busy: boolean; onEnd: () => void }) {
  const title = terminalTitle(view);
  return (
    <div className="flex flex-col gap-0.5 rounded-md px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[statusTone(view.status)])} />
        <RunGlyph icon={config?.icon} className="size-3.5 shrink-0 opacity-80" />
        <span className="min-w-0 flex-1 truncate text-sm" title={view.command}>
          {title}
        </span>
        <span className="shrink-0 text-3xs text-muted-foreground">{statusLabel(view)}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`End ${title}`} title="End — stops it and closes its terminal" disabled={busy} onClick={onEnd}>
          <CircleStopIcon />
        </Button>
      </div>
      {view.warning && (
        <p className="flex items-start gap-1 pl-3.5 text-2xs leading-snug text-warning">
          <TriangleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
          <span>{statusDetail(view)}</span>
        </p>
      )}
      {view.readinessUrl && !view.warning && (
        <a href={view.readinessUrl} target="_blank" rel="noreferrer" className="truncate pl-3.5 text-2xs text-muted-foreground underline-offset-2 hover:underline">
          {view.readinessUrl}
        </a>
      )}
    </div>
  );
}

function StartRow({ header, config }: { header: RunHeader; config: RunConfigurationView }) {
  const count = openCount(header.terminals, config.id);
  return (
    <div className="group/run flex items-center gap-1">
      <button
        type="button"
        disabled={header.busy}
        aria-label={count > 0 ? `Start another ${config.name}` : `Start ${config.name}`}
        title={count > 0 ? "Opens one more terminal running this; the open ones keep going" : "Opens a new terminal running this"}
        onClick={() => header.start(config.id)}
        className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60", header.busy && "opacity-60")}
      >
        <RunGlyph icon={config.icon} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{config.name}</span>
        {count > 0 && <span className="shrink-0 text-3xs text-muted-foreground">{count} open</span>}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Edit ${config.name}`}
        title="Edit"
        disabled={header.busy}
        className="shrink-0 opacity-0 group-hover/run:opacity-70 focus-visible:opacity-100"
        onClick={() => header.setEditing({ config })}
      >
        <SlidersHorizontalIcon />
      </Button>
    </div>
  );
}

/** "Open" is what runs now, each with End; "Start" always opens another terminal and never replaces one. */
export function RunHeaderMenu({ header, onWatchOutput }: { header: RunHeader; onWatchOutput: (() => void) | undefined }) {
  const { terminals, configs, busy, error } = header;
  return (
    <>
      {terminals.length > 0 && (
        <section aria-label="Open terminals" className="flex max-h-56 flex-col gap-0.5 overflow-y-auto border-b border-border p-1">
          <h3 className={cn("flex items-center gap-2", heading)}>
            Open
            {busy && <Loader2Icon className="size-3 animate-spin" />}
          </h3>
          {terminals.map((view) => (
            <OpenTerminalRow key={view.terminalId} view={view} config={configs?.find((config) => config.id === view.configId)} busy={busy} onEnd={() => header.end(view)} />
          ))}
        </section>
      )}
      <section aria-label="Start a terminal" className="flex min-h-0 max-h-72 flex-col gap-0.5 overflow-y-auto p-1">
        <h3 className={heading}>Start</h3>
        {configs === undefined ? (
          <p className="px-2 py-1.5 text-2xs text-muted-foreground">Reading configurations…</p>
        ) : configs.length === 0 ? (
          <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">No run configuration yet. Add one to give this project a start command.</p>
        ) : (
          configs.map((config) => <StartRow key={config.id} header={header} config={config} />)
        )}
      </section>
      {error && <p className="border-t border-border px-3 py-1.5 text-2xs leading-snug text-destructive">{error}</p>}
      <div className="flex items-center gap-1 border-t border-border p-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => header.setEditing({})}>
          <PlusIcon className="size-3.5" />
          New configuration
        </Button>
        <div className="flex-1" />
        {onWatchOutput && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => {
              header.setOpen(false);
              onWatchOutput();
            }}
          >
            Show terminals
          </Button>
        )}
      </div>
    </>
  );
}

/** The panel's own configuration form, inline. */
export function RunHeaderEditor({ header }: { header: RunHeader }) {
  const { editing, busy, error } = header;
  if (!editing) return null;
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <SlidersHorizontalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{editing.config ? `Edit ${editing.config.name}` : "New run configuration"}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <RunConfigEditor
          {...(editing.config ? { config: editing.config } : {})}
          busy={busy}
          {...(error ? { error } : {})}
          onSave={header.save}
          onCancel={() => header.setEditing(undefined)}
        />
      </div>
    </div>
  );
}
