
export type Newline = "\n" | "\r\n";

export function detectNewline(text: string): Newline {
  let crlf = 0;
  let all = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    all += 1;
    if (at > 0 && text[at - 1] === "\r") crlf += 1;
  }
  return crlf * 2 > all ? "\r\n" : "\n";
}

export function withNewline(text: string, newline: Newline): string {
  return newline === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}
