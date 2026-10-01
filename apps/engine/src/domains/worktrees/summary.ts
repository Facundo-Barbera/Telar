import path from "node:path";
import type { WorktreeInventory, WorktreeLocation, WorktreeRow, WorktreeState, WorktreeSummary, WorktreeTally } from "@telar/engine-client";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_ORDER: readonly WorktreeState[] = ["in-use", "archived", "orphaned", "unchanged", "idle", "recent"];

export type SessionFacts = { lastActiveAt: number; released: boolean };

export type SummaryInput = {
  inventory: WorktreeInventory;
  sessions: ReadonlyMap<string, SessionFacts>;
  /** Where new worktrees are made; absent when the location cannot be used. */
  current?: string;
  idleDays: number;
  now: number;
  exists: (folder: string) => boolean;
};

export function stateOf(row: WorktreeRow, input: Pick<SummaryInput, "sessions" | "idleDays" | "now">): WorktreeState {
  if (row.verdict.kind === "locked" && (row.verdict.reason === "in-use" || row.verdict.reason === "protected")) return "in-use";
  if (row.owner.kind === "session" && row.owner.lifecycle === "live") return "in-use";
  if (row.owner.kind === "session" && row.owner.lifecycle === "archived") return "archived";
  if (row.owner.kind === "none") return "orphaned";
  if (row.merged === true) return "unchanged";
  const lastActiveAt = input.sessions.get(row.owner.sessionId)?.lastActiveAt ?? row.updatedAt ?? input.now;
  return input.now - lastActiveAt > input.idleDays * DAY_MS ? "idle" : "recent";
}

/** A drive's name from its mount point; undefined for this Mac's own disk. */
export function volumeOf(folder: string): string | undefined {
  const parts = path.resolve(folder).split(path.sep);
  return parts[1] === "Volumes" && parts[2] ? parts[2] : undefined;
}

function driveMissing(folder: string, exists: SummaryInput["exists"]): boolean {
  const volume = volumeOf(folder);
  return volume !== undefined && !exists(path.join(path.sep, "Volumes", volume));
}

/** Worktrees that take up disk, or would if their drive were plugged in. Released ones are gone. */
export function countedRows(input: Pick<SummaryInput, "inventory" | "sessions" | "exists">): WorktreeRow[] {
  return input.inventory.rows.filter((row) => {
    if (row.owner.kind === "session" && input.sessions.get(row.owner.sessionId)?.released) return false;
    return row.onDisk || driveMissing(path.dirname(row.path), input.exists);
  });
}

const empty = (): WorktreeTally => ({ count: 0, bytes: 0, unmeasured: 0 });

function add(tally: WorktreeTally, row: WorktreeRow): void {
  tally.count += 1;
  if (row.bytes === undefined) tally.unmeasured += 1;
  else tally.bytes += row.bytes;
}

function moveOf(rows: readonly WorktreeRow[]): NonNullable<WorktreeLocation["move"]> {
  const movable = empty();
  const staying = { busy: 0, dirty: 0, unowned: 0, detached: 0 };
  for (const row of rows) {
    if (row.owner.kind === "none") staying.unowned += 1;
    else if (row.verdict.kind === "locked" && row.verdict.reason === "in-use") staying.busy += 1;
    else if (!row.branch) staying.detached += 1;
    else if (row.clean === false) staying.dirty += 1;
    else add(movable, row);
  }
  return { movable, staying };
}

function locationsOf(rows: readonly WorktreeRow[], input: SummaryInput): WorktreeLocation[] {
  const current = input.current ? path.resolve(input.current) : undefined;
  const byFolder = new Map<string, WorktreeRow[]>(current ? [[current, []]] : []);
  for (const row of rows) {
    const folder = path.dirname(path.resolve(row.path));
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), row]);
  }
  return [...byFolder.entries()]
    .map(([folder, members]) => {
      const worktrees = empty();
      for (const row of members) add(worktrees, row);
      const present = input.exists(folder) && !driveMissing(folder, input.exists);
      const isCurrent = folder === current;
      const volume = volumeOf(folder);
      return {
        folder,
        ...(volume ? { volume } : {}),
        present,
        current: isCurrent,
        worktrees,
        ...(present && !isCurrent && current ? { move: moveOf(members) } : {}),
      };
    })
    .sort((left, right) => Number(right.current) - Number(left.current) || right.worktrees.count - left.worktrees.count);
}

export function summarizeWorktrees(input: SummaryInput): WorktreeSummary {
  const rows = countedRows(input);
  const states = new Map(STATE_ORDER.map((state) => [state, { state, worktrees: empty(), releasable: empty() }]));
  for (const row of rows) {
    const entry = states.get(stateOf(row, input))!;
    add(entry.worktrees, row);
    if (entry.state !== "in-use" && entry.state !== "recent" && row.verdict.kind === "reclaimable") add(entry.releasable, row);
  }
  return {
    locations: locationsOf(rows, input),
    states: [...states.values()],
    idleDays: input.idleDays,
    checkedAt: input.inventory.measuredAt,
    measuring: rows.some((row) => row.onDisk && row.bytes === undefined),
    partial: input.inventory.partial,
    ...(input.inventory.blocker ? { blocker: input.inventory.blocker } : {}),
  };
}
