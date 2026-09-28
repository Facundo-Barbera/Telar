"use client";

import { ChevronDownIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { RunGlyph } from "../run/icons";
import { runSummary } from "../run/presentation";
import type { RunApi } from "../run/api";
import type { RunView } from "../run/types";
import { headerMode, useRunHeader } from "../hooks/use-run-header";
import { RunHeaderEditor, RunHeaderMenu, TONE_DOT } from "./run-header-menu";

/** The masthead's run pill: setup, start and end. Watching output lives in the panel's Terminal tab. */
export function RunHeaderControl({
  sessionId,
  hostId,
  api,
  onWatchOutput,
  onTerminals,
}: {
  sessionId: string;
  /** Which Mac this session lives on. Absent means the local one. */
  hostId?: string;
  /** Injected by tests and the fixture; production builds a pinned client. */
  api?: RunApi;
  /** Opens the right panel's Terminal tab. */
  onWatchOutput?: () => void;
  /** Every status answer, shared with whoever reveals new terminals so the feed is not read twice. */
  onTerminals?: (terminals: readonly RunView[]) => void;
}) {
  const header = useRunHeader({ sessionId, hostId, api, onTerminals });
  const { terminals, configs, editing } = header;
  const summary = runSummary(terminals);
  const setup = headerMode(configs, terminals[0]) === "setup";
  // One open terminal wears its recipe's glyph; several do not share one.
  const only = terminals.length === 1 ? terminals[0] : undefined;
  const onlyConfig = only ? configs?.find((config) => config.id === only.configId) : undefined;
  const warned = terminals.some((view) => view.warning);
  const label = setup
    ? "Run — set up a configuration"
    : terminals.length === 0
      ? "Run this project"
      : `Run: ${summary.label}${summary.detail ? `, ${summary.detail}` : ""}${warned ? ", with a warning" : ""}`;

  return (
    <Popover
      open={header.open}
      onOpenChange={(next: boolean) => {
        header.setOpen(next);
        // Straight into the editor when there is nothing to pick; cancelling then shows the empty menu.
        if (next && setup) header.setEditing({});
        if (!next) header.setEditing(undefined);
      }}
    >
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" size="sm" aria-label={label} className="h-7 gap-1.5 px-2 text-xs font-medium">
            {setup ? (
              <>
                <PlusIcon className="size-3.5 shrink-0" />
                <span className="max-w-32 truncate">Run</span>
              </>
            ) : (
              <>
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[summary.tone])} />
                {onlyConfig && <RunGlyph icon={onlyConfig.icon} className="size-3.5 shrink-0 opacity-80" />}
                <span className="max-w-32 truncate">{summary.label}</span>
                {warned && <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />}
                <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
              </>
            )}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        // Clamped to the viewport so the form's Save button is never below the fold.
        className={cn("flex-col gap-0 overflow-hidden rounded-xl p-0", editing ? "max-h-[min(40rem,calc(100vh-7rem))] w-[26rem]" : "w-80")}
      >
        {editing ? <RunHeaderEditor header={header} /> : <RunHeaderMenu header={header} onWatchOutput={onWatchOutput} />}
      </PopoverContent>
    </Popover>
  );
}
