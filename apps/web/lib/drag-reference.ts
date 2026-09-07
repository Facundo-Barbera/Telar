/**
 * DRAGGING A THING FROM THE PANEL INTO THE MESSAGE YOU ARE WRITING.
 *
 * The panel is full of things you want to talk about — an issue, a pull
 * request, a file the session changed, a page the browser has open, a sub-agent
 * that failed. Referring to one of them meant reading it, remembering it, and
 * typing it back in, which is a copying job a human should never be doing next
 * to a machine that already has the string.
 *
 * WHAT A DROP INSERTS IS TEXT, AND THAT IS THE WHOLE DESIGN.
 *
 * The tempting version resolves the reference behind the scenes: drop an issue,
 * and the engine quietly fetches its body and prepends it to the prompt. That
 * makes the transcript a lie — `turn.input` says one thing and the model was
 * sent another — and it is the exact divergence this codebase refuses
 * everywhere else. What you see in the box is what the agent gets. The
 * reference is written to be ACTIONABLE on its own: a number, a title, and a
 * URL is enough for an agent that has `gh` and a shell, and a path is more
 * useful to one with a Read tool than any copy of the file could be.
 *
 * TWO PAYLOADS ON EVERY DRAG. The custom type carries structure for our own
 * drop target; `text/plain` carries the same rendered string so the gesture
 * still does something sensible when it lands in another application, or in a
 * plain textarea, or in a text editor on the other screen.
 */

/** Our own type, so a drop from somewhere else cannot masquerade as one of
 *  these. Vendor-prefixed and suffixed per RFC 6839. */
export const REFERENCE_MIME = "application/x-telar-reference+json";

export type ReferenceKind = "issue" | "pull" | "file" | "page" | "task" | "check";

export type TelarReference = {
  kind: ReferenceKind;
  /** What the chip and the drag image say. Human words. */
  label: string;
  /** What gets inserted into the message. Machine-actionable. */
  text: string;
};

/**
 * How each kind reads once it is in the message.
 *
 * A FILE IS JUST ITS PATH, in backticks. Not a URL, not a line range, not a
 * copy of its contents: the agent is working in this checkout and a path is the
 * thing its Read tool takes. Backticks because they are what stops a model
 * treating `apps/web/src/auth.ts` as prose.
 *
 * AN ISSUE CARRIES ITS TITLE AS WELL AS ITS NUMBER, because `#82` alone is
 * unreadable in a transcript six weeks later — and the transcript is the part
 * that has to survive.
 */

/**
 * A TITLE'S DOUBLE QUOTES BECOME SINGLE ONES, at write time, because the read
 * side (`composer-tokens.ts`) finds a reference by the quotes AROUND its title.
 * An issue literally titled `…marked "In use"…` used to fall out of the pattern
 * the moment it was dropped — no chip in the composer, no chip in the
 * transcript — which is a regression a real issue title triggers, not an edge
 * case. The meaning survives; only the quote glyph changes.
 */
function safeTitle(title: string): string {
  return title.replaceAll('"', "'");
}

export function issueReference(issue: { number: number; title: string; url: string }): TelarReference {
  return {
    kind: "issue",
    label: `#${issue.number}`,
    text: `#${issue.number} "${safeTitle(issue.title)}" (${issue.url})`,
  };
}

export function pullReference(pull: { number: number; title: string; url: string }): TelarReference {
  return {
    kind: "pull",
    label: `PR #${pull.number}`,
    text: `PR #${pull.number} "${safeTitle(pull.title)}" (${pull.url})`,
  };
}

export function fileReference(path: string): TelarReference {
  return { kind: "file", label: path.split("/").at(-1) || path, text: `\`${path}\`` };
}

/**
 * A DIRECTORY KEEPS ITS TRAILING SLASH, and that one character is the point: an
 * agent handed `` `apps/engine` `` has to guess whether to Read it or Glob it,
 * and handed `` `apps/engine/` `` it does not. Same reason `ls` prints one.
 */
export function directoryReference(path: string): TelarReference {
  const trimmed = path.replace(/\/+$/, "");
  return { kind: "file", label: `${trimmed.split("/").at(-1) || trimmed}/`, text: `\`${trimmed}/\`` };
}

export function pageReference(page: { title?: string; url: string }): TelarReference {
  return { kind: "page", label: page.title?.trim() || page.url, text: page.url };
}

/**
 * A PAGE THAT IS OPEN IN THE SESSION'S OWN BROWSER, which is worth more words
 * than a bare URL. The agent holds `browser_*` tools over exactly these tabs,
 * and "the X page open in the session's browser" is the sentence that tells it
 * to reach for them — read the live DOM, pull the component, act on the page —
 * instead of fetching the URL cold. A page with no title yet drags as the
 * plain URL, which is still actionable.
 */
export function browserPageReference(page: { title?: string; url: string }): TelarReference {
  const title = page.title?.trim();
  if (!title) return pageReference(page);
  return {
    kind: "page",
    label: title,
    text: `the "${safeTitle(title)}" page open in the session's browser (${page.url})`,
  };
}

/**
 * A CHECK, AND THE ERROR IT PRODUCED.
 *
 * THE ONE REFERENCE THAT CARRIES CONTENT, and the exception is earned. Every other
 * reference here is an address because the agent can fetch the thing itself: a path
 * for its Read tool, an issue number for its `gh`. A GitHub Actions log is neither —
 * it needs an authenticated API call the agent cannot make, so a URL alone turns
 * "fix this failure" into "go and find out what the failure was, which you cannot".
 *
 * WHICH IS WHY IT IS ONLY INCLUDED ONCE IT IS ON SCREEN. The log arrives when a
 * reader opens the failing check, so what the drag carries is what they were looking
 * at — the surface's standing promise that what lands in the box is what the agent
 * gets. A check nobody expanded drags as its name, its status and its URL.
 *
 * FENCED, and labelled `log`. Without a fence a stack trace's backticks and hashes
 * are read as markdown, and the model spends its attention on formatting.
 */
export function checkReference(check: {
  name: string;
  workflow?: string;
  status: string;
  conclusion?: string;
  url?: string;
  /** The tail of the failing log, when it has been read. */
  log?: readonly string[];
  logTruncated?: boolean;
}): TelarReference {
  const verdict = check.conclusion?.toLowerCase() || check.status.toLowerCase().replaceAll("_", " ");
  const where = check.workflow && check.workflow !== check.name ? `${check.workflow} / ${check.name}` : check.name;
  const head = `the "${where}" check (${verdict})${check.url ? ` — ${check.url}` : ""}`;
  if (!check.log?.length) return { kind: "check", label: check.name, text: head };
  const note = check.logTruncated ? `last ${check.log.length} lines of its failing log` : "its failing log";
  return {
    kind: "check",
    label: check.name,
    text: `${head}\n\n${note}:\n\n\`\`\`log\n${check.log.join("\n")}\n\`\`\``,
  };
}

/**
 * EVERY FAILING CHECK AT ONCE, which is the gesture people actually want.
 *
 * "CI is red, fix it" is one sentence and one drag, not five. The logs of the ones
 * that have been opened are included and the rest contribute their names — so this
 * gets better the more of them you looked at, and is never worse than a list.
 */
export function failingChecksReference(
  checks: readonly { name: string; workflow?: string; status: string; conclusion?: string; url?: string; log?: readonly string[]; logTruncated?: boolean }[],
): TelarReference {
  if (checks.length === 1) return checkReference(checks[0]!);
  return {
    kind: "check",
    label: `${checks.length} failing checks`,
    text: `${checks.length} failing checks:\n\n${checks.map((check) => checkReference(check).text).join("\n\n")}`,
  };
}

export function taskReference(task: { id: string; title?: string; state: string }): TelarReference {
  const name = task.title?.trim() || task.id;
  // A sub-agent has no address a tool can fetch, so the reference names it the
  // way the transcript does and says how it ended — which is the part you are
  // almost always asking about.
  return { kind: "task", label: name, text: `the "${name}" sub-agent (${task.state})` };
}

/** Put a reference on a drag. Both payloads, always — see the header. */
export function startReferenceDrag(transfer: DataTransfer, reference: TelarReference): void {
  transfer.setData(REFERENCE_MIME, JSON.stringify(reference));
  transfer.setData("text/plain", reference.text);
  transfer.effectAllowed = "copy";
}

/**
 * Read a reference back, or nothing.
 *
 * A DROP FROM OUTSIDE IS NOT AN ERROR — a link dragged from a browser, a
 * selection from an editor — so this returns undefined and the caller falls
 * back to the plain text the other application supplied. Malformed JSON in our
 * own type is treated the same way rather than thrown: a failed drop should
 * cost the gesture, not the message being written.
 */
export function readReferenceDrag(transfer: DataTransfer): TelarReference | undefined {
  const raw = transfer.getData(REFERENCE_MIME);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const value = parsed as Partial<TelarReference>;
    if (typeof value?.text !== "string" || typeof value.label !== "string" || typeof value.kind !== "string") return undefined;
    return { kind: value.kind as ReferenceKind, label: value.label, text: value.text };
  } catch {
    return undefined;
  }
}

/**
 * Splice text into a draft at the caret, spaced like a human would type it.
 *
 * THE SPACING IS THE ENTIRE POINT OF THIS FUNCTION EXISTING. Dropping onto the
 * end of "fix " must not produce "fix  #82", and dropping into the middle of a
 * sentence must not weld the reference to the word before it. Returns the new
 * caret position too, so the box can put the cursor after what it just
 * inserted rather than back at the start.
 */
export function insertReference(draft: string, text: string, caret: number): { draft: string; caret: number } {
  const at = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : after.length === 0 ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  return { draft: `${before}${inserted}${after}`, caret: at + inserted.length };
}
