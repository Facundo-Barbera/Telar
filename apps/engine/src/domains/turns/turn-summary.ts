import type { Item, Turn } from "@telar/engine-client";

export const TURN_ANSWER_NONE = "this session has no answered turn";
export const TURN_ANSWER_NO_SUCH_RUN = "turn does not exist";

export const INPUT_LINE_CHARS = 120;

export const ANSWER_HEAD_CHARS = 300;

const ITEM_TITLES = 12;
export const ITEM_TITLE_CHARS = 80;

const FAILURE_CHARS = 300;

export const GREP_CONTEXT_CHARS = 200;

export const WHY_CHARS = 200;

export const FIND_SCAN = 500;

export type TurnSummary = {
  sessionId: string;
  runId: string;
  sequence: number;
  origin?: NonNullable<Turn["origin"]>;
  state: Turn["state"];
  startedAt?: number;
  endedAt?: number;
  input: string;
  itemCount: number;
  itemTitles: string[];
  answerHead: string;
  answerChars: number;
  failure?: string;
};

export function firstLine(text: string, limit: number): string {
  const line = text.replace(/\r\n?/g, "\n").split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function head(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function summariseTurn(turn: Turn, items: Item[]): TurnSummary {
  const mine = items.filter((item) => item.runId === turn.runId).sort((a, b) => a.startedAt - b.startedAt);
  const answer = turn.resultText ?? "";
  return {
    sessionId: turn.sessionId,
    runId: turn.runId,
    sequence: turn.sequence,
    ...(turn.origin === undefined ? {} : { origin: turn.origin }),
    state: turn.state,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(turn.completedAt === undefined ? {} : { endedAt: turn.completedAt }),
    input: turn.notification ? firstLine(turn.notification.summary, INPUT_LINE_CHARS) : firstLine(turn.input.trim() ? turn.input : attachedLine(turn), INPUT_LINE_CHARS),
    itemCount: mine.length,
    itemTitles: mine.slice(0, ITEM_TITLES).map((item) => firstLine(item.title ?? item.detail.type, ITEM_TITLE_CHARS)),
    answerHead: head(answer, ANSWER_HEAD_CHARS),
    answerChars: answer.length,
    ...(turn.failure === undefined ? {} : { failure: head(`${turn.failure.code}: ${turn.failure.message}`, FAILURE_CHARS) }),
  };
}

export const OUTLINE_ANSWER_CHARS = 200;

const OUTLINE_PAGE_BYTES = 6_000;

export type OutlineRow = {
  runId: string;
  sequence: number;
  origin?: NonNullable<Turn["origin"]>;
  state: Turn["state"];
  input: string;
  items: number;
  answer: string;
  answerChars: number;
  endedAt?: number;
  failure?: string;
};

export function boundedOutline(rows: OutlineRow[], limit: number): OutlineRow[] {
  const page: OutlineRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (page.length >= limit) break;
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes > OUTLINE_PAGE_BYTES && page.length > 0) break;
    page.push(row);
  }
  return page;
}

export function outlineRow(summary: TurnSummary): OutlineRow {
  return {
    runId: summary.runId,
    sequence: summary.sequence,
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
    state: summary.state,
    input: summary.input,
    items: summary.itemCount,
    answer: firstLine(summary.answerHead, OUTLINE_ANSWER_CHARS),
    answerChars: summary.answerChars,
    ...(summary.endedAt === undefined ? {} : { endedAt: summary.endedAt }),
    ...(summary.failure === undefined ? {} : { failure: summary.failure }),
  };
}

function attachedLine(turn: Turn): string {
  const names = (turn.attachments ?? []).map((attachment) => attachment.name);
  return names.length > 0 ? `[${names.join(", ")}]` : "";
}

export function context(text: string, at: number, width: number): string {
  const start = Math.max(0, at - Math.floor(width / 2));
  const end = Math.min(text.length, start + width);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}
