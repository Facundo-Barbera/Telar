
import type { FileChangeKind, GitFileChange, Item, Turn } from "@telar/engine-client";

export type DiffTurn = {
  runId: string;
  sequence?: number;
  input?: string;
  at: number;
  files: readonly GitFileChange[];
  patches: ReadonlyMap<string, { patch: string; truncated: boolean }>;
  anchor?: Turn["anchor"];
};

type Draft = { at: number; order: string[]; byPath: Map<string, { change: GitFileChange; patch?: string; truncated?: boolean }> };

function statusOf(kind: FileChangeKind, renamedFrom?: string): GitFileChange["status"] {
  if (kind === "rename" && renamedFrom) return "renamed";
  if (kind === "create") return "added";
  if (kind === "delete") return "deleted";
  return "modified";
}

export function diffTurns(items: readonly Item[], turns: readonly Turn[] = []): DiffTurn[] {
  const drafts = new Map<string, Draft>();
  for (const item of items) {
    if (item.detail.type !== "file_change") continue;
    if (item.status === "declined" || item.status === "failed") continue;
    const change = item.detail.change;
    const draft: Draft = drafts.get(item.runId) ?? { at: item.startedAt, order: [], byPath: new Map() };
    draft.at = Math.min(draft.at, item.startedAt);
    if (!draft.byPath.has(change.path)) draft.order.push(change.path);
    draft.byPath.set(change.path, {
      change: {
        path: change.path,
        status: statusOf(change.kind, change.renamedFrom),
        ...(change.renamedFrom ? { renamedFrom: change.renamedFrom } : {}),
        ...(change.linesAdded === undefined ? {} : { linesAdded: change.linesAdded }),
        ...(change.linesRemoved === undefined ? {} : { linesRemoved: change.linesRemoved }),
      },
      ...(change.unifiedDiff ? { patch: change.unifiedDiff } : {}),
      ...(change.diffTruncated ? { truncated: true } : {}),
    });
    drafts.set(item.runId, draft);
  }

  const byRun = new Map(turns.map((turn) => [turn.runId, turn]));
  const built: DiffTurn[] = [];
  for (const [runId, draft] of drafts) {
    const turn = byRun.get(runId);
    const patches = new Map<string, { patch: string; truncated: boolean }>();
    for (const [path, entry] of draft.byPath) if (entry.patch) patches.set(path, { patch: entry.patch, truncated: entry.truncated === true });
    built.push({
      runId,
      ...(turn ? { sequence: turn.sequence } : {}),
      ...(turn?.input.trim() ? { input: turn.input } : {}),
      ...(turn?.anchor ? { anchor: turn.anchor } : {}),
      at: draft.at,
      files: draft.order.sort((left, right) => left.localeCompare(right)).map((path) => draft.byPath.get(path)!.change),
      patches,
    });
  }
  return built.sort((left, right) => right.at - left.at);
}

export function turnFor(turns: readonly DiffTurn[], runId: string | undefined): DiffTurn | undefined {
  return (runId ? turns.find((turn) => turn.runId === runId) : undefined) ?? turns[0];
}

export function turnLabel(turn: DiffTurn): string {
  const first = turn.input?.split("\n").find((line) => line.trim())?.trim();
  if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return turn.sequence === undefined ? "A turn" : `Turn ${turn.sequence}`;
}
