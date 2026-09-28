
import type { PreparedPrompt } from "@telar/engine-client";
import { entrySummary, type StashedImage, type StashEntry } from "./prompt-stash";

type ShelfSource = "stash" | "engine";

export type ShelfRow = {
  key: string;
  source: ShelfSource;
  id: string;
  author: "you" | "session";
  title: string;
  reason?: string;
  text?: string;
  images: StashedImage[];
  at: number;
};

function byNewest(left: ShelfRow, right: ShelfRow): number {
  return right.at - left.at || left.key.localeCompare(right.key);
}

export function stashRows(entries: readonly StashEntry[]): ShelfRow[] {
  return entries
    .map((entry) => ({
      key: `stash:${entry.id}`,
      source: "stash" as const,
      id: entry.id,
      author: "you" as const,
      title: entrySummary(entry),
      images: entry.images,
      at: entry.at,
    }))
    .sort(byNewest);
}

export function engineRows(prompts: readonly PreparedPrompt[], sessionId: string | undefined): ShelfRow[] {
  return prompts
    .filter((prompt) => prompt.sessionId === undefined || prompt.sessionId === sessionId)
    .map((prompt) => ({
      key: `engine:${prompt.id}`,
      source: "engine" as const,
      id: prompt.id,
      author: prompt.author,
      title: prompt.title,
      ...(prompt.reason ? { reason: prompt.reason } : {}),
      text: prompt.text,
      images: prompt.images ?? [],
      at: prompt.created.at,
    }))
    .sort(byNewest);
}

export function mergeShelf(
  entries: readonly StashEntry[],
  prompts: readonly PreparedPrompt[],
  sessionId: string | undefined,
): { agents: ShelfRow[]; yours: ShelfRow[]; rows: ShelfRow[]; count: number } {
  const engine = engineRows(prompts, sessionId);
  const agents = engine.filter((row) => row.author === "session");
  const yours = [...engine.filter((row) => row.author === "you"), ...stashRows(entries)].sort(byNewest);
  const rows = [...agents, ...yours];
  return { agents, yours, rows, count: rows.length };
}
