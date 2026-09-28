/**
 * A `<textarea>` normalises line breaks to LF, so CRLF is restored on write. Mixed files cannot
 * be preserved; the majority wins. The write's hash is of the on-disk bytes, so conflicts still work.
 */

export type Newline = "\n" | "\r\n";

/** LF unless CRLF is the majority. */
export function detectNewline(text: string): Newline {
  let crlf = 0;
  let all = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    all += 1;
    if (at > 0 && text[at - 1] === "\r") crlf += 1;
  }
  return crlf * 2 > all ? "\r\n" : "\n";
}

/** Idempotent. */
export function withNewline(text: string, newline: Newline): string {
  return newline === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}
