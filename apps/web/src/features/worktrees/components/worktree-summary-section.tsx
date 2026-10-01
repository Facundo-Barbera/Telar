"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReleasableState, WorktreeLocation, WorktreeLocationMove, WorktreeMoveResult, WorktreeState, WorktreeSummary, WorktreeTally } from "@telar/engine-client";
import { ArchiveIcon, CircleDotIcon, ClockIcon, GitMergeIcon, HardDriveIcon, LaptopIcon, MoonIcon, UnlinkIcon } from "lucide-react";
import { createEngineApi } from "@/platform/engine";
import { fmtAgo, formatBytes } from "@/ui/format";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Spinner } from "@/ui/spinner";
import { Row, SettingsGroup } from "@/features/settings";
import { WorktreeListSection } from "./worktree-list-section";

const api = createEngineApi();
const POLL_MS = 3_000;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function tallyLabel(tally: WorktreeTally): string {
  if (tally.count === 0) return "None";
  const size = tally.unmeasured === tally.count ? "measuring…" : `${formatBytes(tally.bytes)}${tally.unmeasured > 0 ? "+" : ""}`;
  return `${plural(tally.count, "worktree")} · ${size}`;
}

function placeName(location: WorktreeLocation, other: WorktreeLocation | undefined): string {
  if (location.volume && location.volume !== other?.volume) return location.volume;
  if (!location.volume && other?.volume) return "this Mac";
  return location.folder;
}

export function moveLabel(source: WorktreeLocation, current: WorktreeLocation | undefined): string {
  const movable = source.move?.movable ?? { count: 0, bytes: 0, unmeasured: 0 };
  const to = current ? placeName(current, source) : "the current location";
  if (movable.count === 0) return `Move from ${placeName(source, current)} to ${to}`;
  const size = movable.unmeasured === movable.count ? "" : ` (${formatBytes(movable.bytes)}${movable.unmeasured > 0 ? "+" : ""})`;
  return `Move ${plural(movable.count, "worktree")}${size} from ${placeName(source, current)} to ${to}`;
}

export function moveBlocker(location: WorktreeLocation): string | undefined {
  if (location.current) return "New worktrees are made here already.";
  if (!location.present) return "The drive is not connected.";
  if (!location.move) return "Choose a location first.";
  if (location.move.movable.count === 0) return `Nothing here can move. ${stayingSentence(location.move.staying) ?? ""}`.trim();
  return undefined;
}

export function stayingSentence(staying: WorktreeLocationMove["staying"]): string | undefined {
  const reasons = [
    staying.dirty > 0 ? `${plural(staying.dirty, "has", "have")} uncommitted changes` : undefined,
    staying.busy > 0 ? `${plural(staying.busy, "has a turn", "have turns")} running` : undefined,
    staying.unowned > 0 ? `${plural(staying.unowned, "belongs", "belong")} to no session` : undefined,
    staying.detached > 0 ? `${plural(staying.detached, "is", "are")} not on a branch` : undefined,
  ].filter(Boolean);
  const total = staying.dirty + staying.busy + staying.unowned + staying.detached;
  return total === 0 ? undefined : `${total} will stay put: ${reasons.join(", ")}.`;
}

export function outcomeCounts(result: WorktreeMoveResult): string {
  const failed = result.skipped.filter((entry) => entry.reason === "failed").length;
  return `Moved ${result.moved.length} · stayed ${result.skipped.length - failed} · failed ${failed}`;
}

const STATES: Record<WorktreeState, { label: (days: number) => string; icon: typeof ClockIcon; verb?: string }> = {
  "in-use": { label: () => "In use", icon: CircleDotIcon },
  archived: { label: () => "Archived sessions", icon: ArchiveIcon, verb: "Release" },
  orphaned: { label: () => "No session", icon: UnlinkIcon, verb: "Remove" },
  unchanged: { label: () => "No commits beyond the default branch", icon: GitMergeIcon, verb: "Release" },
  idle: { label: (days) => `Idle more than ${days} days`, icon: ClockIcon, verb: "Release" },
  recent: { label: () => "Settled recently", icon: MoonIcon },
};

export function releaseLabel(state: WorktreeState, releasable: WorktreeTally): string | undefined {
  const verb = STATES[state].verb;
  if (!verb || releasable.count === 0) return undefined;
  return `${verb} ${plural(releasable.count, "worktree")} · ${formatBytes(releasable.bytes)}${releasable.unmeasured > 0 ? "+" : ""}`;
}

function LocationRow({ location, current, onMoved }: { location: WorktreeLocation; current: WorktreeLocation | undefined; onMoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WorktreeMoveResult>();
  const [failure, setFailure] = useState<string>();
  const blocker = moveBlocker(location);
  const label = moveLabel(location, current);

  const move = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      setOutcome((await api.moveWorktrees(location.folder)).move);
      setConfirming(false);
      onMoved();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "The worktrees could not be moved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      icon={location.volume ? HardDriveIcon : LaptopIcon}
      label={location.volume ?? "This Mac"}
      status={location.current ? <Badge variant="secondary">current</Badge> : !location.present ? <Badge variant="outline">not connected</Badge> : undefined}
      hint={
        <>
          <span className="font-mono">{location.folder}</span> — {tallyLabel(location.worktrees)}
          {outcome ? <span className="block text-foreground">{outcomeCounts(outcome)}. {outcome.summary}</span> : null}
        </>
      }
      {...(failure ? { error: failure } : {})}
      control={
        location.current || confirming ? null : (
          <span className="flex flex-col items-end gap-1 text-right">
            <Button size="sm" variant="outline" disabled={busy || blocker !== undefined} onClick={() => setConfirming(true)}>
              {label}
            </Button>
            {blocker ? <span className="max-w-72 text-xs text-muted-foreground">{blocker}</span> : null}
          </span>
        )
      }
    >
      {confirming && location.move ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm move">
          <span className="min-w-60 flex-1 text-foreground">
            {label}? Each is re-made from its branch; nothing is forced. {stayingSentence(location.move.staying) ?? "Nothing stays behind."}
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void move()}>
            {busy ? "Moving…" : "Move them"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </Row>
  );
}

function StateRow({ entry, idleDays, onReleased }: { entry: WorktreeSummary["states"][number]; idleDays: number; onReleased: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const meta = STATES[entry.state];
  const action = releaseLabel(entry.state, entry.releasable);

  const release = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      setResult((await api.releaseWorktreeState(entry.state as ReleasableState)).reclaim.summary);
      setConfirming(false);
      onReleased();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Those worktrees could not be given back.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      icon={meta.icon}
      label={meta.label(idleDays)}
      hint={result ?? tallyLabel(entry.worktrees)}
      {...(failure ? { error: failure } : {})}
      control={
        action ? (
          confirming ? (
            <span className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void release()}>
                {busy ? "Working…" : `Confirm: ${action}`}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
              {action}
            </Button>
          )
        ) : null
      }
    />
  );
}

export function WorktreeSummarySection({ version = 0 }: { version?: number }) {
  const [summary, setSummary] = useState<WorktreeSummary>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [listing, setListing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setSummary((await api.worktreeSummary({ refresh })).summary);
      setFailure(undefined);
    } catch {
      setFailure("The engine did not answer.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(version > 0), 0);
    return () => window.clearTimeout(task);
  }, [load, version]);

  useEffect(() => {
    if (!summary?.measuring) return;
    const task = window.setTimeout(() => void load(), POLL_MS);
    return () => window.clearTimeout(task);
  }, [load, summary]);

  const current = summary?.locations.find((location) => location.current);
  const total = summary?.locations.reduce((sum, location) => sum + location.worktrees.count, 0) ?? 0;
  const checked = summary ? `Checked ${fmtAgo(summary.checkedAt)}${summary.measuring ? ", still measuring sizes" : ""}.` : "Counting…";

  return (
    <>
      <SettingsGroup
        title="Where worktrees live"
        description={[summary?.blocker, failure ?? checked, summary?.partial ? "Some folders could not be read, so sizes are a floor." : undefined].filter(Boolean).join(" ")}
        action={
          <span className="flex items-center gap-2">
            {loading ? <Spinner className="size-3.5" /> : null}
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(true)}>
              Refresh
            </Button>
            <Button size="sm" variant="outline" disabled={total === 0} onClick={() => setListing(true)}>
              Show all {total}…
            </Button>
          </span>
        }
      >
        {summary?.locations.map((location) => (
          <LocationRow key={location.folder} location={location} current={current} onMoved={() => void load(true)} />
        )) ?? <Row label="…" />}
      </SettingsGroup>

      {summary ? (
        <SettingsGroup title="By state" description="Each worktree is counted once. Only worktrees proven safe to lose are released; branches and conversations are kept.">
          {summary.states.map((entry) => (
            <StateRow key={entry.state} entry={entry} idleDays={summary.idleDays} onReleased={() => void load(true)} />
          ))}
        </SettingsGroup>
      ) : null}

      <Dialog open={listing} onOpenChange={setListing}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>All worktrees</DialogTitle>
          </DialogHeader>
          {listing ? <WorktreeListSection onChanged={() => void load(true)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
