import type { Item } from "../protocol/items";

/** `bytes` lets a caller choose which step it can afford before fetching it. */
export type RunItemRow = { index: number; id: string; title: string; status: Item["status"]; bytes: number };

export type RunItemsAnswer = { items: RunItemRow[] };

export type RunItemRead = {
  index: number;
  id: string;
  title: string;
  status: Item["status"];
  startedAt: number;
  completedAt?: number;
  taskId?: string;
  text: string;
  totalChars: number;
  more: boolean;
};

export type TurnAnswerRead = { runId: string; sequence: number; text: string; from: number; totalChars: number; more: boolean; next?: number };
