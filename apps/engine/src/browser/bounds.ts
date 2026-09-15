/**
 * THE BYTE CEILING ON A BROWSER ANSWER — the one place a page's size stops
 * being the model's problem.
 *
 * Three of these tools answer with however much the page happens to have.
 * `browser_snapshot` renders the accessibility tree, `browser_console_messages`
 * and `browser_network_requests` render ring buffers of two hundred entries
 * whose lines are capped at two thousand characters EACH — so a heavy page's
 * answer is measured in hundreds of kilobytes, and every byte of it lands in a
 * context window that has other work to do. Measured on the fixtures in
 * `test/browser-bounds.test.ts`: a 2,000-node tree renders ~30 KB, 500 console
 * lines ~44 KB, 300 network rows ~19 KB, and the ring's own worst case is over
 * 400 KB. Nothing in the stack said no.
 *
 * ── AT THE SOCKET, NOT AT EITHER BACKEND ────────────────────────────────────
 * Telar has two browsers — the desktop host's visible tabs and the headless
 * Playwright runtime a detached session gets — and `socket.ts` is the single
 * seam every model-facing call crosses on its way back. Bounding there is the
 * only spot that covers both without also truncating the engine's OWN reads:
 * `BrowserRuntime.state()` calls `browser_list_tabs` through the same
 * `call()`, and a tab list cut mid-line parses into a tab that does not exist.
 *
 * ── WHICH END SURVIVES ──────────────────────────────────────────────────────
 * A snapshot is read from the top: the page header, then outwards-in. A log is
 * read from the bottom — the error that just happened is the last line, not the
 * first — and both backends emit chronologically, so the newest entries are the
 * TAIL. Hence `keep`, and hence the marker leading for the logs and trailing
 * for the tree: in both cases it sits where the reader arrives at the cut.
 *
 * Entries are never REORDERED to put the newest first. Reordering would change
 * what the tools do (#515 explicitly rules that out) and would mangle any
 * backend that opens its answer with a header line. Keeping the tail already
 * gives the newest entries the whole budget, which is the part that matters.
 *
 * ── THE MARKER NAMES THE WAY OUT ────────────────────────────────────────────
 * A truncation a model cannot act on is just a missing answer. Every marker
 * names the argument that narrows THIS tool — `target`/`depth` for the tree,
 * `level` for the console, `filter` for the network — so the next call is a
 * smaller question rather than the same one again.
 */

/** A content block as it crosses the socket: parsed by `tools.ts` on the way in
 *  from a backend, but the socket's own capability type is looser than that, so
 *  this module duck-types rather than importing the parsed union. */
type LooseBlock = { type?: unknown; text?: unknown };
type LooseResult = { content: unknown[]; isError?: boolean };

type Keep = "head" | "tail";

type BoundPolicy = {
  /** utf-8 bytes, INCLUDING the marker. */
  budget: number;
  keep: Keep;
  /** Rendered into the marker verbatim, backticks and all. */
  narrow: string;
};

/**
 * 16 KB for the tree and 6 KB for each log, from #515.
 *
 * The tree gets the larger share because it is the one answer a model must act
 * ON rather than merely read: a ref it cannot see is a click it cannot make.
 * The logs get enough for roughly the last few dozen lines, which is the window
 * in which "what just went wrong" actually lives.
 */
export const BROWSER_ANSWER_POLICIES: Readonly<Record<string, BoundPolicy>> = {
  browser_snapshot: { budget: 16 * 1024, keep: "head", narrow: "`target` or `depth`" },
  browser_console_messages: { budget: 6 * 1024, keep: "tail", narrow: "`level`" },
  browser_network_requests: { budget: 6 * 1024, keep: "tail", narrow: "`filter`" },
};

/** The budgets alone, for tests and for anything reporting the contract. */
export const BROWSER_ANSWER_BUDGETS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(BROWSER_ANSWER_POLICIES).map(([name, policy]) => [name, policy.budget]),
);

function marker(droppedCharacters: number, narrow: string): string {
  return `[… ${droppedCharacters} more characters not shown — narrow with ${narrow}]`;
}

/**
 * The longest run of WHOLE LINES that fits in `room` bytes, taken from
 * whichever end `keep` names.
 *
 * Whole lines because a snapshot line carries a ref and a log line carries a
 * URL: half of either is worse than neither, since a model will try to use it.
 */
function fitLines(text: string, room: number, keep: Keep): string {
  const lines = text.split("\n");
  const order = keep === "head" ? lines : lines.slice().reverse();
  const kept: string[] = [];
  let used = 0;
  for (const line of order) {
    // The newline that joins this line to the previous one is part of its cost.
    const cost = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (used + cost > room) break;
    used += cost;
    kept.push(line);
  }
  // One line longer than the whole budget — a 2,000-character console entry
  // against a 6 KB budget nearly is. Cut inside it rather than answer nothing.
  if (kept.length === 0) return sliceToBytes(order[0] ?? "", room, keep);
  return (keep === "head" ? kept : kept.reverse()).join("\n");
}

/** `line` cut to `room` utf-8 bytes from the kept end, never leaving half of a
 *  surrogate pair behind — a lone surrogate is not a character any reader wants
 *  to meet in a tool result. */
function sliceToBytes(line: string, room: number, keep: Keep): string {
  // Bytes ≥ code units, so `room` code units is always a safe starting cut.
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

/**
 * One tool's answer text, under its budget, with the marker where the reader
 * arrives at the cut. A tool with no policy, or an answer already under
 * budget, is returned byte-identical.
 */
export function boundBrowserText(name: string, text: string): string {
  const policy = BROWSER_ANSWER_POLICIES[name];
  if (!policy) return text;
  if (Buffer.byteLength(text, "utf8") <= policy.budget) return text;
  // The marker's own length depends on the number it reports, which depends on
  // the cut, which depends on the marker's length. Reserve the WORST case —
  // every character dropped — so the real marker can only be shorter, and the
  // answer can only come in under budget.
  const reserved = Buffer.byteLength(marker(text.length, policy.narrow), "utf8") + 1;
  const kept = fitLines(text, Math.max(0, policy.budget - reserved), policy.keep);
  const dropped = text.length - kept.length;
  // A budget so small that the marker alone eats it: better the untruncated
  // answer than a marker with nothing attached to it.
  if (dropped <= 0) return text;
  const mark = marker(dropped, policy.narrow);
  return policy.keep === "head" ? `${kept}\n${mark}` : `${mark}\n${kept}`;
}

/**
 * A whole tool result, bounded.
 *
 * Text blocks are joined the way `textOf` already joins them for every other
 * reader in the engine, so the budget is the budget for the ANSWER rather than
 * per block — a backend that split its tree across two blocks must not get
 * twice the allowance. Image blocks are carried through untouched: a
 * screenshot has its own size story and is not one of the bounded tools.
 *
 * An answer that fits is returned by reference, so the common case changes
 * neither the block count nor their order.
 */
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
