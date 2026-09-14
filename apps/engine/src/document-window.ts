/**
 * READING THE TAIL OF A SESSION DOCUMENT WITHOUT MATERIALISING THE REST (#419).
 *
 * `queue.json` and `items.json` are one JSON array each, appended to for the
 * life of a conversation, and every read of them used to be a whole-document
 * `JSON.parse` plus a whole-document zod validation — after which
 * `snapshotWindow` threw away everything outside the ten turns it answers with.
 * Measured at the engine boundary, the same 10-turn window cost 3.7 ms on a
 * 20-turn session and 38–44 ms on a 120-turn one: the price of a read was the
 * length of the conversation, not the size of the answer, and the cockpit pays
 * it once a second while a turn runs.
 *
 * THE INDEX IS BYTE OFFSETS INTO THE EXACT STORED TEXT. Both backends keep the
 * document as one blob — SQLite in `documents.value`, the JSON store in a file —
 * so one mechanism serves both: record where each array element starts and ends,
 * then read back only the span the window needs and parse that. SQLite slices
 * with `substr` over the value cast to a blob; the file store seeks and reads at
 * an offset. Neither hands the untouched history to JavaScript.
 *
 * BYTES, NOT CHARACTERS, and the scanner below works on a `Buffer` for exactly
 * that reason. Conversations are full of non-ASCII, so a UTF-16 string offset
 * and a file offset stop agreeing at the first accented character; SQLite's own
 * `substr` is character-based over TEXT and byte-based over BLOB, and the file
 * store can only seek in bytes. Scanning bytes is safe because every structural
 * character in JSON is ASCII and no UTF-8 continuation byte can be mistaken for
 * one.
 *
 * THE OFFSETS ARE DERIVED FROM THE TEXT, NOT FROM THE VALUE. A writer hands
 * this module the string it is about to store and gets back the ranges within
 * it, so the index cannot drift from the document by disagreeing about
 * formatting — the JSON store pretty-prints and SQLite does not, and neither
 * needs to know that here.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

/** One element's half-open byte range within the document it was indexed from. */
export type DocumentRange = { start: number; end: number };

/**
 * What is written beside a document so its tail can be read alone.
 *
 * `length` IS THE STALENESS CHECK, and it is why this can be an optimisation
 * rather than a new source of truth: a document written by an older engine has
 * no index, and one edited behind the store's back (a test rewriting
 * `queue.json`, a restored backup, a legacy import) has one that no longer
 * describes it. Both cases compare unequal against the stored document's own
 * byte length, the index is discarded, and the read falls back to parsing the
 * whole document — slower, never wrong.
 *
 * `tag` carries the one field the window has to sort on — a turn's state —
 * so deciding WHICH elements to read needs no read at all.
 */
export type DocumentIndex = {
  version: number;
  length: number;
  rows: Array<{ key: string; tag?: string; start: number; end: number }>;
};

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function skipWhitespace(bytes: Buffer, at: number): number {
  let index = at;
  while (index < bytes.length && isWhitespace(bytes[index]!)) index += 1;
  return index;
}

/** Past the closing quote of the string opening at `at`. */
function endOfString(bytes: Buffer, at: number): number {
  let index = at + 1;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    // An escape consumes the next byte whatever it is, which is what keeps a
    // `\"` inside a message from being read as the end of the string.
    if (byte === BACKSLASH) {
      index += 2;
      continue;
    }
    if (byte === QUOTE) return index + 1;
    index += 1;
  }
  return index;
}

/** Past the last byte of the JSON value starting at `at`. */
function endOfValue(bytes: Buffer, at: number): number {
  const first = bytes[at];
  if (first === undefined) return at;
  if (first === QUOTE) return endOfString(bytes, at);
  if (first !== LBRACE && first !== LBRACKET) {
    let index = at;
    while (index < bytes.length) {
      const byte = bytes[index]!;
      if (byte === COMMA || byte === RBRACE || byte === RBRACKET || isWhitespace(byte)) break;
      index += 1;
    }
    return index;
  }
  let depth = 0;
  let index = at;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (byte === QUOTE) {
      index = endOfString(bytes, index);
      continue;
    }
    if (byte === LBRACE || byte === LBRACKET) depth += 1;
    else if (byte === RBRACE || byte === RBRACKET) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

/**
 * The byte range of every element of the top-level array property `name`.
 *
 * `undefined` when the document is not the shape this expects — not an error:
 * the caller's answer to an unindexable document is to write no index and keep
 * reading it whole, which is what every document written before this existed
 * already does.
 */
export function arrayElementRanges(bytes: Buffer, name: string): DocumentRange[] | undefined {
  const wanted = Buffer.from(JSON.stringify(name), "utf8");
  let index = skipWhitespace(bytes, 0);
  if (bytes[index] !== LBRACE) return undefined;
  index += 1;
  for (;;) {
    index = skipWhitespace(bytes, index);
    if (bytes[index] !== QUOTE) return undefined;
    const keyEnd = endOfString(bytes, index);
    const matched = keyEnd - index === wanted.length && bytes.compare(wanted, 0, wanted.length, index, keyEnd) === 0;
    index = skipWhitespace(bytes, keyEnd);
    if (bytes[index] !== COLON) return undefined;
    index = skipWhitespace(bytes, index + 1);
    const valueStart = index;
    const valueEnd = endOfValue(bytes, valueStart);
    if (matched) return bytes[valueStart] === LBRACKET ? elementRanges(bytes, valueStart, valueEnd) : undefined;
    index = skipWhitespace(bytes, valueEnd);
    if (bytes[index] !== COMMA) return undefined;
    index += 1;
  }
}

function elementRanges(bytes: Buffer, open: number, close: number): DocumentRange[] {
  const ranges: DocumentRange[] = [];
  let index = skipWhitespace(bytes, open + 1);
  while (index < close && bytes[index] !== RBRACKET) {
    const start = index;
    index = endOfValue(bytes, index);
    ranges.push({ start, end: index });
    index = skipWhitespace(bytes, index);
    if (bytes[index] !== COMMA) break;
    index = skipWhitespace(bytes, index + 1);
  }
  return ranges;
}

/**
 * The elements a span of document bytes holds, as one array.
 *
 * The span runs from one element's first byte to another's last, so whatever
 * separated them in the document — a comma, a newline, an indent — is still
 * between them and the whole thing is a valid array body once bracketed. The
 * caller filters: a span that reaches back to an old unsettled turn carries the
 * settled ones in between, and reading a few extra rows is cheaper than reading
 * each wanted one on its own.
 */
export function parseSpan(bytes: Buffer): unknown[] {
  return JSON.parse(`[${bytes.toString("utf8")}]`) as unknown[];
}
