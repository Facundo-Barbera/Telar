const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

export type DocumentRange = { start: number; end: number };

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

function endOfString(bytes: Buffer, at: number): number {
  let index = at + 1;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (byte === BACKSLASH) {
      index += 2;
      continue;
    }
    if (byte === QUOTE) return index + 1;
    index += 1;
  }
  return index;
}

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

export function parseSpan(bytes: Buffer): unknown[] {
  return JSON.parse(`[${bytes.toString("utf8")}]`) as unknown[];
}
