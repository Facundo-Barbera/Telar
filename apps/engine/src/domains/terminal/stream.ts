import { redactText } from "./types";

export function safeCut(text: string, secrets: readonly string[], at: number): number {
  let cut = Math.min(at, text.length);
  for (let moved = true; moved; ) {
    moved = false;
    for (const secret of secrets) {
      if (!secret) continue;
      for (let index = text.indexOf(secret); index !== -1 && index < cut; index = text.indexOf(secret, index + 1)) {
        if (index + secret.length > cut) {
          cut = index + secret.length;
          moved = true;
        }
      }
    }
  }
  return cut;
}

export type OutputSplitter = {
  push(chunk: string): void;
  end(): void;
};

export function createOutputSplitter(secrets: readonly string[], maxLineChars: number, emit: (text: string) => void): OutputSplitter {
  const longest = secrets.reduce((length, secret) => Math.max(length, secret.length), 0);
  const hold = Math.max(0, longest - 1);
  let carry = "";

  const line = (text: string) => {
    let rest = text.replace(/\r$/, "");
    while (rest.length > maxLineChars) {
      const cut = safeCut(rest, secrets, maxLineChars);
      if (cut >= rest.length) break;
      emit(redactText(rest.slice(0, cut), secrets));
      rest = rest.slice(cut);
    }
    emit(redactText(rest, secrets));
  };

  return {
    push(chunk: string): void {
      carry += chunk;
      const parts = carry.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) line(part);

      while (carry.length - hold >= maxLineChars) {
        const cut = safeCut(carry, secrets, maxLineChars);
        if (cut > carry.length - hold) break;
        line(carry.slice(0, cut));
        carry = carry.slice(cut);
      }
    },
    end(): void {
      if (carry) line(carry);
      carry = "";
    },
  };
}
