export type ToolCallContext = { toolCallId?: string };

export type ToolFactory = (
  name: string,
  description: string,
  shape: Record<string, unknown>,
  handler: (args: Record<string, unknown>, context?: ToolCallContext) => Promise<{ content: unknown[]; isError?: boolean }>,
) => unknown;

export const MAX_ANSWER_CHARS = 16_000;

export const DELEGATION_WAIT_MAX_SECONDS = 600;
export const TELAR_TOOL_CALL_TIMEOUT_MS = (DELEGATION_WAIT_MAX_SECONDS + 60) * 1_000;

function bounded(text: string, max: number = MAX_ANSWER_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters not shown]`;
}

export function fillWithin<T, R>(items: readonly T[], shape: (item: T) => R, options: { limit: number; chars: number }): { rows: R[]; shown: number } {
  const rows: R[] = [];
  let chars = 0;
  for (const item of items) {
    if (rows.length >= options.limit) break;
    const row = shape(item);
    const size = JSON.stringify(row, null, 2)?.length ?? 0;
    if (rows.length > 0 && chars + size > options.chars) break;
    rows.push(row);
    chars += size;
  }
  return { rows, shown: rows.length };
}

export function clampLimit(raw: unknown, fallback: number, ceiling: number): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) return fallback;
  return Math.min(raw, ceiling);
}

export const ok = (text: string) => ({ content: [{ type: "text", text }] });
export const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
export const json = (value: unknown, max?: number) => ok(bounded(JSON.stringify(value, null, 2) ?? "null", max));
export const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));
