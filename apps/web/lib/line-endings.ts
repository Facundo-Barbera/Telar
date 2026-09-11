/**
 * WHAT A FILE ENDS ITS LINES WITH, KEPT ACROSS AN EDIT.
 *
 * THE BUG THIS EXISTS FOR, and it is the browser's doing rather than ours. A
 * `<textarea>`'s value is line-break NORMALISED by the HTML spec: whatever you
 * put into the element, what `event.target.value` hands back has every line
 * break as a bare LF. So the moment somebody types one character into a file
 * that uses CRLF, the editor's text — and therefore the autosave — is the whole
 * file with every carriage return gone. Measured on a three-line CRLF file: one
 * character changed, 32 bytes became 29, and all three line endings had been
 * rewritten. In a diff that is not a one-line change, it is the entire file,
 * which is the kind of thing that gets noticed in review rather than in the
 * editor.
 *
 * There is no way to make the textarea hold a CR, so the conversion has to
 * happen on the way OUT: the editor works in LF, and the write puts back
 * whatever the read found. The hash the write carries is of the CRLF bytes,
 * which is what is on disk, so nothing about the conflict check changes.
 *
 * MIXED FILES CANNOT BE PRESERVED and this does not pretend otherwise — by the
 * time the text reaches us the distinction is already gone. The majority wins,
 * which at least leaves a file that was consistent exactly as consistent as it
 * was.
 */

export type Newline = "\n" | "\r\n";

/**
 * Which ending this text uses. LF unless CRLF is the majority — a file with no
 * line breaks at all is LF, which costs nothing because there is nothing to
 * convert.
 */
export function detectNewline(text: string): Newline {
  let crlf = 0;
  let all = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    all += 1;
    if (at > 0 && text[at - 1] === "\r") crlf += 1;
  }
  return crlf * 2 > all ? "\r\n" : "\n";
}

/** The same text with every line break written the given way. Idempotent: text
 *  that already ends its lines that way comes back unchanged. */
export function withNewline(text: string, newline: Newline): string {
  return newline === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}
