"use client";

import { ChevronDownIcon } from "lucide-react";
import type { GitRefEntry } from "@telar/engine-client";
import { scopesFor, type DiffScopeKind, type DiffTab } from "../diff-scope";
import { turnFor, turnLabel, type DiffTurn } from "../diff-turns";
import { fmtAgo } from "@/ui/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { SCOPE_BLURB, SCOPE_LABEL } from "../model";

const MAX_BASE_REFS = 12;
const MAX_TURN_OPTIONS = 12;

/** Which question this tab asks: the working tree, since a base, or one turn. The chosen scope's argument sits in the same menu. */
export function DiffScopePicker({
  tab,
  onTabChange,
  hasSession,
  refs,
  turns,
  sessionBase,
}: {
  tab: DiffTab;
  onTabChange?: (tab: DiffTab) => void;
  hasSession: boolean;
  refs?: readonly GitRefEntry[];
  turns?: readonly DiffTurn[];
  sessionBase?: string;
}) {
  const offered = scopesFor(hasSession);
  const summary =
    tab.kind === "branch"
      ? tab.base ?? (sessionBase ? `${sessionBase.slice(0, 8)} — where this session started` : SCOPE_LABEL.branch)
      : tab.kind === "turn"
        ? turnLabel(turnFor(turns ?? [], tab.turn) ?? { runId: "", at: 0, files: [], patches: new Map() })
        : SCOPE_LABEL.unstaged;

  if (!onTabChange) return <span className="min-w-0 truncate text-muted-foreground">{summary}</span>;

  const chosenTurn = turnFor(turns ?? [], tab.turn);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="What this Diff is looking at"
            title="What this Diff is looking at"
            className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted"
          />
        }
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuRadioGroup value={tab.kind} onValueChange={(next) => onTabChange({ ...tab, kind: next as DiffScopeKind })}>
          <DropdownMenuLabel>Looking at</DropdownMenuLabel>
          {offered.map((kind) => (
            <DropdownMenuRadioItem key={kind} value={kind} className="items-start">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{SCOPE_LABEL[kind]}</span>
                <span className="text-2xs text-muted-foreground">{SCOPE_BLURB[kind]}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {tab.kind === "branch" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={tab.base ?? ""} onValueChange={(next) => onTabChange({ ...tab, base: next })}>
              <DropdownMenuLabel>Base</DropdownMenuLabel>
              {hasSession && (
                <DropdownMenuRadioItem value="">
                  <span className="truncate">
                    Where this session started
                    {sessionBase ? <span className="ml-1.5 font-mono text-2xs text-muted-foreground">{sessionBase.slice(0, 8)}</span> : null}
                  </span>
                </DropdownMenuRadioItem>
              )}
              {(refs ?? []).slice(0, MAX_BASE_REFS).map((ref) => (
                <DropdownMenuRadioItem key={ref.name} value={ref.name}>
                  <span className="truncate font-mono text-2xs">{ref.name}</span>
                </DropdownMenuRadioItem>
              ))}
              {refs !== undefined && refs.length === 0 && <DropdownMenuLabel>No other refs to compare against.</DropdownMenuLabel>}
            </DropdownMenuRadioGroup>
          </>
        )}
        {tab.kind === "turn" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={chosenTurn?.runId ?? ""} onValueChange={(next) => onTabChange({ ...tab, turn: next })}>
              <DropdownMenuLabel>Turn</DropdownMenuLabel>
              {(turns ?? []).slice(0, MAX_TURN_OPTIONS).map((option) => (
                <DropdownMenuRadioItem key={option.runId} value={option.runId}>
                  <span className="min-w-0 flex-1 truncate">{turnLabel(option)}</span>
                  <span className="ml-2 shrink-0 text-2xs text-muted-foreground">{fmtAgo(option.at)}</span>
                </DropdownMenuRadioItem>
              ))}
              {turns !== undefined && turns.length === 0 && <DropdownMenuLabel>No turn has reported writing a file yet.</DropdownMenuLabel>}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
