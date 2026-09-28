type LooseBlock = { type?: unknown; text?: unknown };
type LooseResult = { content: unknown[]; isError?: boolean };

type Keep = "head" | "tail";

type BoundPolicy = {
  budget: number;
  keep: Keep;
  narrow: string;
};

const BROWSER_ANSWER_POLICIES: Readonly<Record<string, BoundPolicy>> = {
  browser_snapshot: { budget: 16 * 1024, keep: "head", narrow: "`target` or `depth`" },
  browser_console_messages: { budget: 6 * 1024, keep: "tail", narrow: "`level`" },
  browser_network_requests: { budget: 6 * 1024, keep: "tail", narrow: "`filter`" },
};

export const BROWSER_ANSWER_BUDGETS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(BROWSER_ANSWER_POLICIES).map(([name, policy]) => [name, policy.budget]),
);

function marker(droppedCharacters: number, narrow: string): string {
  return `[… ${droppedCharacters} more characters not shown — narrow with ${narrow}]`;
}

function fitLines(text: string, room: number, keep: Keep): string {
  const lines = text.split("\n");
  const order = keep === "head" ? lines : lines.slice().reverse();
  const kept: string[] = [];
  let used = 0;
  for (const line of order) {
    const cost = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (used + cost > room) break;
    used += cost;
    kept.push(line);
  }
  if (kept.length === 0) return sliceToBytes(order[0] ?? "", room, keep);
  return (keep === "head" ? kept : kept.reverse()).join("\n");
}

function sliceToBytes(line: string, room: number, keep: Keep): string {
  let out = keep === "head" ? line.slice(0, room) : line.slice(Math.max(0, line.length - room));
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > room) {
    out = keep === "head" ? out.slice(0, -1) : out.slice(1);
  }
  if (keep === "head") {
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  } else {
    const first = out.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
  }
  return out;
}

export function boundBrowserText(name: string, text: string): string {
  const policy = BROWSER_ANSWER_POLICIES[name];
  if (!policy) return text;
  if (Buffer.byteLength(text, "utf8") <= policy.budget) return text;
  const reserved = Buffer.byteLength(marker(text.length, policy.narrow), "utf8") + 1;
  const kept = fitLines(text, Math.max(0, policy.budget - reserved), policy.keep);
  const dropped = text.length - kept.length;
  if (dropped <= 0) return text;
  const mark = marker(dropped, policy.narrow);
  return policy.keep === "head" ? `${kept}\n${mark}` : `${mark}\n${kept}`;
}

export function boundBrowserResult<T extends LooseResult>(name: string, result: T): T {
  if (!BROWSER_ANSWER_POLICIES[name]) return result;
  const texts: string[] = [];
  const rest: unknown[] = [];
  for (const block of result.content) {
    const candidate = block as LooseBlock;
    if (candidate?.type === "text" && typeof candidate.text === "string") texts.push(candidate.text);
    else rest.push(block);
  }
  if (texts.length === 0) return result;
  const joined = texts.join("\n");
  const bounded = boundBrowserText(name, joined);
  if (bounded === joined) return result;
  return { ...result, content: [{ type: "text", text: bounded }, ...rest] };
}
