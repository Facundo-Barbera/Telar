"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReleasableState, WorktreeLocation, WorktreeLocationMove, WorktreeMoveResult, WorktreeState, WorktreeSummary, WorktreeTally } from "@telar/engine-client";
import { ArchiveIcon, CircleDotIcon, ClockIcon, GitMergeIcon, FolderIcon, HardDriveIcon, MoonIcon, UnlinkIcon } from "lucide-react";
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

function tallyLabel(tally: WorktreeTally): string {
  if (tally.count === 0) return "No worktrees";
  const size = tally.unmeasured === tally.count ? "measuring…" : `${formatBytes(tally.bytes)}${tally.unmeasured > 0 ? "+" : ""}`;
  return `${plural(tally.count, "worktree")} · ${size}`;
}

function sizeOf(tally: WorktreeTally): string | undefined {
  if (tally.unmeasured === tally.count) return undefined;
  return `${formatBytes(tally.bytes)}${tally.unmeasured > 0 ? "+" : ""}`;
}

function moveLabel(movable: WorktreeTally, current: WorktreeLocation | undefined): string {
  const size = sizeOf(movable);
  return `Move ${plural(movable.count, "worktree")}${size ? ` · ${size}` : ""} to ${current?.label ?? "the current location"}`;
}

function stayNote(location: WorktreeLocation): string | undefined {
  if (location.current || location.worktrees.count === 0) return undefined;
  if (!location.present) return "Plug the drive in to move these.";
  if (!location.move || location.move.movable.count > 0) return undefined;
  return `Nothing here can move. ${stayingSentence(location.move.staying) ?? ""}`.trim();
}

function stayingSentence(staying: WorktreeLocationMove["staying"]): string | undefined {
  const reasons = [
    staying.dirty > 0 ? `${plural(staying.dirty, "has", "have")} uncommitted changes` : undefined,
    staying.busy > 0 ? `${plural(staying.busy, "has a turn", "have turns")} running` : undefined,
    staying.unowned > 0 ? `${plural(staying.unowned, "belongs", "belong")} to no session` : undefined,
    staying.detached > 0 ? `${plural(staying.detached, "is", "are")} not on a branch` : undefined,
  ].filter(Boolean);
  const total = staying.dirty + staying.busy + staying.unowned + staying.detached;
  return total === 0 ? undefined : `${total} will stay put: ${reasons.join(", ")}.`;
}

function outcomeCounts(result: WorktreeMoveResult): string {
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

function releaseLabel(state: WorktreeState, releasable: WorktreeTally): string | undefined {
  const verb = STATES[state].verb;
  if (!verb || releasable.count === 0) return undefined;
  return `${verb} ${plural(releasable.count, "worktree")} · ${formatBytes(releasable.bytes)}${releasable.unmeasured > 0 ? "+" : ""}`;
}

function LocationRow({ location, current, onMoved }: { location: WorktreeLocation; current: WorktreeLocation | undefined; onMoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WorktreeMoveResult>();
  const [failure, setFailure] = useState<string>();
  const movable = location.present && !location.current && location.move && location.move.movable.count > 0 ? location.move : undefined;
  const note = stayNote(location);
  const destination = current?.folder ?? "the current location";

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
      icon={location.volume ? HardDriveIcon : FolderIcon}
      label={<span title={location.folder}>{location.label}</span>}
      status={location.current ? <Badge variant="secondary">current</Badge> : !location.present ? <Badge variant="outline">not connected</Badge> : undefined}
      hint={
        <>
          {tallyLabel(location.worktrees)}
          {location.fsmonitor ? ` · ${plural(location.fsmonitor, "file watcher")}` : null}
          {note ? <span className="block">{note}</span> : null}
          {outcome ? <span className="block text-foreground">{outcomeCounts(outcome)}. {outcome.summary}</span> : null}
        </>
      }
      {...(failure ? { error: failure } : {})}
      control={
        movable && !confirming ? (
          <Button size="sm" variant="outline" title={`${location.folder} → ${destination}`} onClick={() => setConfirming(true)}>
            {moveLabel(movable.movable, current)}
          </Button>
        ) : null
      }
    >
      {confirming && movable ? (
        <div className="mt-2 space-y-2 text-xs" role="group" aria-label="Confirm move">
          <p className="text-foreground">
            Move {plural(movable.movable.count, "worktree")} from <span className="font-mono break-all">{location.folder}</span> to{" "}
            <span className="font-mono break-all">{destination}</span>? Each is re-made from its branch; nothing is forced.{" "}
            {stayingSentence(movable.staying) ?? "Nothing stays behind."}
          </p>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void move()}>
              {busy ? "Moving…" : "Move them"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
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
  const occupied = summary?.states.filter((entry) => entry.worktrees.count > 0) ?? [];
  const degraded = summary?.degradedVolumes?.map((volume) => volume.mount.split("/").filter(Boolean).pop() ?? volume.mount) ?? [];
  const away = degraded.length > 0 ? `${degraded.join(", ")} ${degraded.length === 1 ? "is" : "are"} slow or not connected.` : undefined;
  const checked = summary ? `Checked ${fmtAgo(summary.checkedAt)}${summary.measuring ? ", still measuring sizes" : ""}.` : "Counting…";
  const watchers = summary?.fsmonitor ? `${plural(summary.fsmonitor, "file watcher")} running on this Mac.` : undefined;

  return (
    <>
      <SettingsGroup
        title="Where worktrees live"
        description={[summary?.blocker, away, failure ?? checked, summary?.partial ? "Some folders could not be read, so sizes are a floor." : undefined, watchers].filter(Boolean).join(" ")}
        action={
          <span className="flex items-center gap-2 whitespace-nowrap">
            {loading ? <Spinner className="size-3.5" /> : null}
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(true)}>
              Refresh
            </Button>
            <Button size="sm" variant="outline" disabled={total === 0} onClick={() => setListing(true)}>
              Show all ({total})
            </Button>
          </span>
        }
      >
        {summary?.locations.map((location) => (
          <LocationRow key={location.folder} location={location} current={current} onMoved={() => void load(true)} />
        ))}
      </SettingsGroup>

      {summary ? (
        <SettingsGroup title="By state" description="Each worktree is counted once. Only worktrees proven safe to lose are released; branches and conversations are kept.">
          {occupied.length === 0 ? <div className="py-3 text-xs text-muted-foreground">No worktrees in any state.</div> : null}
          {occupied.map((entry) => (
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
