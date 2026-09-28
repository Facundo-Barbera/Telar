const ESC = "\x1b";
const BEL = "\x07";

export const MAX_ESCAPE_CHARS = 8192;

const MAX_HOLD_CHARS = 64 * 1024;

export const PTY_MASK = "•";

function escapeEnd(text: string, start: number): number {
  const kind = text[start + 1];
  if (kind === undefined) return -1;

  if (kind === "[") {
    let index = start + 2;
    while (index < text.length && isBetween(text, index, 0x30, 0x3f)) index += 1;
    while (index < text.length && isBetween(text, index, 0x20, 0x2f)) index += 1;
    if (index >= text.length) return -1;
    return isBetween(text, index, 0x40, 0x7e) ? index + 1 : start + 1;
  }

  if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
    for (let index = start + 2; index < text.length; index += 1) {
      if (text[index] === BEL) return index + 1;
      if (text[index] !== ESC) continue;
      if (index + 1 >= text.length) return -1;
      if (text[index + 1] === "\\") return index + 2;
    }
    return -1;
  }

  if (isBetween(text, start + 1, 0x20, 0x2f)) {
    let index = start + 2;
    while (index < text.length && isBetween(text, index, 0x20, 0x2f)) index += 1;
    return index >= text.length ? -1 : index + 1;
  }

  return isBetween(text, start + 1, 0x30, 0x7e) ? start + 2 : start + 1;
}

function isBetween(text: string, index: number, low: number, high: number): boolean {
  const code = text.charCodeAt(index);
  return code >= low && code <= high;
}

export type EscapeScan = {
  spans: Array<[number, number]>;
  pending: number;
};

export function escapeScan(text: string): EscapeScan {
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ESC) continue;
    const end = escapeEnd(text, index);
    if (end === -1) {
      if (text.length - index <= MAX_ESCAPE_CHARS) return { spans, pending: index };
      continue;
    }
    if (end > index + 1) spans.push([index, end]);
    index = end - 1;
  }
  return { spans, pending: -1 };
}

export function safeCutBack(text: string, secrets: readonly string[], limit: number): number {
  let cut = Math.max(0, Math.min(limit, text.length));
  if (cut === 0) return 0;
  const { spans } = escapeScan(text);
  for (let moved = true; moved && cut > 0; ) {
    moved = false;
    for (const [start, end] of spans) {
      if (cut > start && cut < end) {
        cut = start;
        moved = true;
      }
    }
    for (const secret of secrets) {
      if (!secret) continue;
      for (let index = text.indexOf(secret); index !== -1 && index < cut; index = text.indexOf(secret, index + 1)) {
        if (index + secret.length > cut) {
          cut = index;
          moved = true;
        }
      }
    }
  }
  return cut;
}

export function pendingSecretPrefix(text: string, secrets: readonly string[]): number {
  let hold = 0;
  for (const secret of secrets) {
    if (!secret) continue;
    const window = Math.min(secret.length - 1, text.length);
    for (let start = text.length - window; start < text.length; start += 1) {
      const length = text.length - start;
      if (length <= hold) break;
      if (text[start] !== secret[0]) continue;
      if (text.startsWith(secret.slice(0, length), start)) {
        hold = length;
        break;
      }
    }
  }
  return hold;
}

export function redactPtyText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(PTY_MASK.repeat(secret.length));
  }
  return out;
}

export type PtyRedactor = {
  push(chunk: string): void;
  end(): void;
};

export type PtyRedactorOptions = {
  maxHoldChars?: number;
};

export function createPtyRedactor(secrets: readonly string[], emit: (text: string) => void, options: PtyRedactorOptions = {}): PtyRedactor {
  const maxHold = options.maxHoldChars ?? MAX_HOLD_CHARS;
  let carry = "";

  const flush = (mode: "safe" | "overflow"): void => {
    if (!carry) return;
    let limit = carry.length - pendingSecretPrefix(carry, secrets);
    if (mode === "safe") {
      const { pending } = escapeScan(carry);
      if (pending !== -1) limit = Math.min(limit, pending);
    }
    const cut = safeCutBack(carry, secrets, limit);
    if (cut <= 0) return;
    emit(redactPtyText(carry.slice(0, cut), secrets));
    carry = carry.slice(cut);
  };

  return {
    push(chunk: string): void {
      if (!chunk) return;
      carry += chunk;
      flush("safe");
      if (carry.length > maxHold) flush("overflow");
    },
    end(): void {
      if (carry) emit(redactPtyText(carry, secrets));
      carry = "";
    },
  };
}
