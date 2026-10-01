"use client";

import { useEffect, useState } from "react";
import { CLEANUP_INACTIVE_DAYS, CLEANUP_LOG_DAYS, CLEANUP_SETTLED_DAYS, type CleanupPolicy, type CleanupReport, type CleanupState, type RetentionPolicy } from "@telar/engine-client";
import { ArchiveIcon, ClockIcon, GitBranchIcon, HistoryIcon, MoonIcon, ScrollTextIcon } from "lucide-react";
import { createEngineApi } from "@/platform/engine";
import { fmtAgo, formatBytes } from "@/ui/format";
import { Button } from "@/ui/button";
import { Dropdown, Row, SettingsGroup, ToggleRow } from "@/features/settings";
import { WorktreeSummarySection } from "./worktree-summary-section";
import { WorktreesRootRow } from "./worktrees-root-section";

const api = createEngineApi();

export const FIXED_RULES =
  "Never touched: a worktree with uncommitted changes, unpushed commits, a turn in flight or a running process, or one Telar did not create.";

const SETTLED_INFO = "Only a worktree with no uncommitted changes and every commit on a remote branch. Reopening the session makes it again from its branch.";

type Days = "off" | `${number}`;

function daysOptions(days: readonly number[]): { value: Days; label: string }[] {
  return [{ value: "off", label: "Off" }, ...days.map((day) => ({ value: `${day}` as Days, label: `${day} ${day === 1 ? "day" : "days"}` }))];
}

export function lastCleanupLabel(last: CleanupReport | undefined, now = Date.now()): string {
  if (!last) return "Never cleaned up";
  const ago = `Last cleanup: ${fmtAgo(last.at, now)}`;
  return last.freedBytes > 0 ? `${ago} · freed ${formatBytes(last.freedBytes)}` : ago;
}

export function runLabel(report: CleanupReport): string {
  const parts = [
    `${report.released} ${report.released === 1 ? "worktree" : "worktrees"} released`,
    `${report.logs} ${report.logs === 1 ? "log" : "logs"} deleted`,
  ];
  if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
  return parts.join(", ");
}

function reason(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function RetentionRow() {
  const [retention, setRetention] = useState<RetentionPolicy>();
  const [retentionError, setRetentionError] = useState<string>();

  useEffect(() => {
    const task = window.setTimeout(() => {
      api
        .retention()
        .then((answer) => setRetention(answer.retention))
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const retentionOff = async () => {
    setRetentionError(undefined);
    try {
      setRetention((await api.setRetention({ idleAfterDays: null })).retention);
    } catch (cause) {
      setRetentionError(reason(cause, "That could not be turned off."));
    }
  };

  if (!retention?.idleAfterDays) return null;
  return (
    <Row
      icon={HistoryIcon}
      label="Turn journal retention"
      hint={`Journals of conversations idle ${retention.idleAfterDays} days are moved to ${retention.exportTo ?? "an export folder"}.`}
      {...(retentionError ? { error: retentionError } : {})}
      control={
        <Button size="sm" variant="outline" onClick={() => void retentionOff()}>
          Turn off
        </Button>
      }
    />
  );
}

export function CleanupSection() {
  const [state, setState] = useState<CleanupState>();
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [error, setError] = useState<{ key: keyof CleanupPolicy | "run"; message: string }>();
  const [rootVersion, setRootVersion] = useState(0);

  useEffect(() => {
    const task = window.setTimeout(() => {
      api
        .cleanup()
        .then((answer) => setState(answer.cleanup))
        .catch((cause) => setError({ key: "run", message: reason(cause, "The engine did not answer.") }));
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const save = async (patch: Partial<CleanupPolicy>) => {
    const key = Object.keys(patch)[0] as keyof CleanupPolicy;
    setError(undefined);
    try {
      setState((await api.setCleanupPolicy(patch)).cleanup);
    } catch (cause) {
      setError({ key, message: reason(cause, "That could not be saved.") });
    }
  };

  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      setState((await api.runCleanup()).cleanup);
      setRan(true);
    } catch (cause) {
      setError({ key: "run", message: reason(cause, "The cleanup did not run.") });
    } finally {
      setRunning(false);
    }
  };

  const policy = state?.policy;
  const errorFor = (key: keyof CleanupPolicy) => (error?.key === key ? { error: error.message } : {});
  const busy = running || state?.running === true;

  return (
    <>
      <SettingsGroup title="Worktrees">
        <Row
          icon={ClockIcon}
          label="Delete inactive worktrees"
          hint="Releases the worktree of a session inactive this many days. Its branch and conversation are kept, and it comes back when you reopen the session."
          info={FIXED_RULES}
          {...errorFor("inactiveDays")}
          control={
            <Dropdown<Days>
              value={policy?.inactiveDays ? `${policy.inactiveDays}` : "off"}
              label="Delete inactive worktrees"
              className="w-28"
              disabled={!policy}
              onChange={(next) => void save({ inactiveDays: next === "off" ? null : (Number(next) as CleanupPolicy["inactiveDays"]) })}
              options={daysOptions(CLEANUP_INACTIVE_DAYS)}
            />
          }
        />
        <Row
          icon={MoonIcon}
          label="Release settled worktrees"
          hint="Releases a settled session's worktree after this many days; its branch and conversation are kept."
          info={SETTLED_INFO}
          {...errorFor("settledDays")}
          control={
            <Dropdown<Days>
              value={policy?.settledDays ? `${policy.settledDays}` : "off"}
              label="Release settled worktrees"
              className="w-28"
              disabled={!policy}
              onChange={(next) => void save({ settledDays: next === "off" ? null : (Number(next) as CleanupPolicy["settledDays"]) })}
              options={daysOptions(CLEANUP_SETTLED_DAYS)}
            />
          }
        />
        <ToggleRow
          icon={GitBranchIcon}
          label="Delete unchanged worktrees"
          hint="Releases the worktree of an idle session whose branch has no commits beyond the default branch."
          checked={policy?.unchanged ?? false}
          onCheckedChange={(unchanged) => void save({ unchanged })}
          {...errorFor("unchanged")}
        />
        <ToggleRow
          icon={ArchiveIcon}
          label="Delete worktrees of archived sessions"
          hint="Otherwise archiving keeps the worktree."
          checked={policy?.archived ?? false}
          onCheckedChange={(archived) => void save({ archived })}
          {...errorFor("archived")}
        />
        <WorktreesRootRow onChanged={() => setRootVersion((version) => version + 1)} />
      </SettingsGroup>

      <WorktreeSummarySection version={rootVersion} />

      <SettingsGroup title="Logs">
        <Row
          icon={ScrollTextIcon}
          label="Delete old logs"
          hint="Rotated logs only."
          {...errorFor("logsDays")}
          control={
            <Dropdown<Days>
              value={policy?.logsDays ? `${policy.logsDays}` : "off"}
              label="Delete old logs"
              className="w-28"
              disabled={!policy}
              onChange={(next) => void save({ logsDays: next === "off" ? null : (Number(next) as CleanupPolicy["logsDays"]) })}
              options={daysOptions(CLEANUP_LOG_DAYS)}
            />
          }
        />
        <RetentionRow />
      </SettingsGroup>

      <div className="mb-6 flex items-center gap-3 px-4 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1" role="status">
          {state ? lastCleanupLabel(state.last) : "…"}
          {ran && state?.last ? ` · ${runLabel(state.last)}` : ""}
          {error?.key === "run" ? <span className="block text-destructive">{error.message}</span> : null}
        </span>
        <Button size="sm" variant="outline" disabled={!state || busy} onClick={() => void run()}>
          {busy ? "Cleaning up…" : "Clean up now"}
        </Button>
      </div>
    </>
  );
}
