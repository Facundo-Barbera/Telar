"use client";

/**
 * AUTOMATIC CLEANUP — Settings → Storage. Four switches, global to this engine
 * and all off by default (`protocol/cleanup.ts`). A worktree is RELEASED, not
 * deleted: the directory goes, the branch and conversation stay, and reopening
 * the session brings it back.
 *
 * Every write shows the engine's answer, never an optimistic guess. Nothing
 * here measures the disk on open; the worktree list, which does, mounts only
 * when somebody asks for it.
 */

import { useEffect, useState } from "react";
import { CLEANUP_INACTIVE_DAYS, CLEANUP_LOG_DAYS, type CleanupPolicy, type CleanupReport, type CleanupState, type RetentionPolicy } from "@telar/engine-client";
import { ArchiveIcon, ClockIcon, GitMergeIcon, HistoryIcon, ScrollTextIcon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
import { fmtAgo, formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Dropdown, Row, SettingsGroup, ToggleRow } from "./settings-shell";
import { WorktreeListSection } from "./worktree-list-section";
import { WorktreesRootRows } from "./worktrees-root-section";

const api = createEngineApi();

export const FIXED_RULES =
  "Never touched: a worktree with uncommitted changes, unpushed commits, a turn in flight or a running process, or one Telar did not create.";

/** "Off" or a day count, as the dropdown's string value. */
type Days = "off" | `${number}`;

function daysOptions(days: readonly number[]): { value: Days; label: string }[] {
  return [{ value: "off", label: "Off" }, ...days.map((day) => ({ value: `${day}` as Days, label: `${day} days` }))];
}

export function lastCleanupLabel(last: CleanupReport | undefined, now = Date.now()): string {
  if (!last) return "Never cleaned up";
  return `Last cleanup: ${fmtAgo(last.at, now)} · freed ${formatBytes(last.freedBytes)}`;
}

/** What a press just did — counts the line above does not carry. */
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

export function CleanupSection() {
  const [state, setState] = useState<CleanupState>();
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [error, setError] = useState<{ key: keyof CleanupPolicy | "run"; message: string }>();
  const [retention, setRetention] = useState<RetentionPolicy>();
  const [retentionError, setRetentionError] = useState<string>();
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    const task = window.setTimeout(() => {
      api
        .cleanup()
        .then((answer) => setState(answer.cleanup))
        .catch((cause) => setError({ key: "run", message: reason(cause, "The engine did not answer.") }));
      // Only to surface a journal retention window set before this page existed.
      api
        .retention()
        .then((answer) => setRetention(answer.retention))
        .catch(() => undefined);
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

  const retentionOff = async () => {
    setRetentionError(undefined);
    try {
      setRetention((await api.setRetention({ idleAfterDays: null })).retention);
    } catch (cause) {
      setRetentionError(reason(cause, "That could not be turned off."));
    }
  };

  const policy = state?.policy;
  const errorFor = (key: keyof CleanupPolicy) => (error?.key === key ? { error: error.message } : {});
  const busy = running || state?.running === true;

  return (
    <>
      <SettingsGroup
        title="Worktrees"
        action={
          <Button size="sm" variant="ghost" aria-expanded={showList} onClick={() => setShowList((open) => !open)}>
            {showList ? "Hide worktrees" : "Show worktrees"}
          </Button>
        }
      >
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
        <ToggleRow
          icon={GitMergeIcon}
          label="Delete merged worktrees"
          hint="When its commits are already in the default branch."
          checked={policy?.merged ?? false}
          onCheckedChange={(merged) => void save({ merged })}
          {...errorFor("merged")}
        />
        <ToggleRow
          icon={ArchiveIcon}
          label="Delete worktrees of archived sessions"
          hint="Otherwise archiving keeps the worktree."
          checked={policy?.archived ?? false}
          onCheckedChange={(archived) => void save({ archived })}
          {...errorFor("archived")}
        />
        <WorktreesRootRows />
      </SettingsGroup>

      {showList ? <WorktreeListSection /> : null}

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
        {/* A window set before this page existed still deletes, so it stays
            visible, with a way out, until it is off. */}
        {retention?.idleAfterDays ? (
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
        ) : null}
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
