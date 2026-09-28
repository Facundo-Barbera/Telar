/**
 * Dragging panel items into the composer. A drop inserts plain text so what the box shows
 * is exactly what the agent gets; every drag also carries `text/plain` for other drop targets.
 */

/** Vendor-prefixed and suffixed per RFC 6839, so outside drops cannot masquerade as ours. */
export const REFERENCE_MIME = "application/x-telar-reference+json";

export type ReferenceKind = "issue" | "pull" | "file" | "page" | "task" | "check" | "note" | "skill";

export type TelarReference = {
  kind: ReferenceKind;
  /** What the chip and the drag image say. Human words. */
  label: string;
  /** What gets inserted into the message. Machine-actionable. */
  text: string;
};

/** Double quotes become single ones: `composer-tokens.ts` finds a reference by the quotes around its title. */
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
 * `path:10-20` for a range on one side of a diff. A range on the removed side counts lines
 * before the change and says so; a range spanning both sides names both ends in words.
 */
export type LineSide = "before" | "after";

export function lineRangeReference(
  path: string,
  range: { start: number; end: number; startSide?: LineSide; endSide?: LineSide },
): TelarReference {
  const startSide = range.startSide ?? "after";
  const endSide = range.endSide ?? startSide;
  const name = path.split("/").at(-1) || path;
  if (startSide !== endSide) {
    return {
      kind: "file",
      label: `${name}:${range.start}–${range.end}`,
      text: `\`${path}\` from line ${range.start} ${startSide} the change to line ${range.end} ${endSide} it`,
    };
  }
  const low = Math.min(range.start, range.end);
  const high = Math.max(range.start, range.end);
  const lines = low === high ? `${low}` : `${low}-${high}`;
  return {
    kind: "file",
    label: `${name}:${lines}`,
    text: `\`${path}:${lines}\`${startSide === "before" ? " (lines before the change)" : ""}`,
  };
}

/** Keeps the trailing slash so an agent knows to Glob rather than Read it. */
export function directoryReference(path: string): TelarReference {
  const trimmed = path.replace(/\/+$/, "");
  return { kind: "file", label: `${trimmed.split("/").at(-1) || trimmed}/`, text: `\`${trimmed}/\`` };
}

export function pageReference(page: { title?: string; url: string }): TelarReference {
  return { kind: "page", label: page.title?.trim() || page.url, text: page.url };
}

/** Names the session's browser so the agent reaches for its `browser_*` tools; untitled pages drag as the URL. */
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
 * Carries the log because the agent cannot fetch Actions logs itself; only a log already
 * on screen is included. Fenced as `log` so backticks and hashes are not read as markdown.
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

/** Logs of opened checks are included; the rest contribute their names. */
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

/**
 * Carries the body because the agent cannot fetch notebook notes itself; the id lets it
 * edit the note with `notes_write`. The fence is one backtick longer than the longest run in the body.
 */
export function noteReference(note: { id: string; title: string; body: string }): TelarReference {
  const head = `the "${safeTitle(note.title)}" project note (${note.id})`;
  const body = note.body.trim();
  if (!body) return { kind: "note", label: note.title, text: head };
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return { kind: "note", label: note.title, text: `${head}:\n\n${fence}note\n${body}\n${fence}` };
}

/**
 * What `$` inserts: prose, not `/name`, since a slash command mid-sentence is inert.
 * The name keeps its provider namespace (`vercel:deploy`), the only spelling the harness resolves.
 */
export function skillReference(skill: { name: string }): TelarReference {
  return { kind: "skill", label: skill.name, text: `the "${safeTitle(skill.name)}" skill` };
}

export function taskReference(task: { id: string; title?: string; state: string }): TelarReference {
  const name = task.title?.trim() || task.id;
  // A sub-agent has no fetchable address, so name it and say how it ended.
  return { kind: "task", label: name, text: `the "${name}" sub-agent (${task.state})` };
}

/** Always sets both payloads. */
export function startReferenceDrag(transfer: DataTransfer, reference: TelarReference): void {
  transfer.setData(REFERENCE_MIME, JSON.stringify(reference));
  transfer.setData("text/plain", reference.text);
  transfer.effectAllowed = "copy";
}

/** Undefined for drops from outside or malformed JSON, so the caller falls back to the plain text. */
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
 * Splice text into a draft at the caret, spaced like a human would type it, and return
 * the caret position after the insertion.
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
