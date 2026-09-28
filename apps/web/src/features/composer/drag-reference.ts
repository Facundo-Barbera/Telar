
export const REFERENCE_MIME = "application/x-telar-reference+json";

export type ReferenceKind = "issue" | "pull" | "file" | "page" | "task" | "check" | "note" | "skill";

export type TelarReference = {
  kind: ReferenceKind;
  label: string;
  text: string;
};

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

export function directoryReference(path: string): TelarReference {
  const trimmed = path.replace(/\/+$/, "");
  return { kind: "file", label: `${trimmed.split("/").at(-1) || trimmed}/`, text: `\`${trimmed}/\`` };
}

export function pageReference(page: { title?: string; url: string }): TelarReference {
  return { kind: "page", label: page.title?.trim() || page.url, text: page.url };
}

export function browserPageReference(page: { title?: string; url: string }): TelarReference {
  const title = page.title?.trim();
  if (!title) return pageReference(page);
  return {
    kind: "page",
    label: title,
    text: `the "${safeTitle(title)}" page open in the session's browser (${page.url})`,
  };
}

export function checkReference(check: {
  name: string;
  workflow?: string;
  status: string;
  conclusion?: string;
  url?: string;
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

export function noteReference(note: { id: string; title: string; body: string }): TelarReference {
  const head = `the "${safeTitle(note.title)}" project note (${note.id})`;
  const body = note.body.trim();
  if (!body) return { kind: "note", label: note.title, text: head };
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return { kind: "note", label: note.title, text: `${head}:\n\n${fence}note\n${body}\n${fence}` };
}

export function skillReference(skill: { name: string }): TelarReference {
  return { kind: "skill", label: skill.name, text: `the "${safeTitle(skill.name)}" skill` };
}

export function taskReference(task: { id: string; title?: string; state: string }): TelarReference {
  const name = task.title?.trim() || task.id;
  return { kind: "task", label: name, text: `the "${name}" sub-agent (${task.state})` };
}

export function startReferenceDrag(transfer: DataTransfer, reference: TelarReference): void {
  transfer.setData(REFERENCE_MIME, JSON.stringify(reference));
  transfer.setData("text/plain", reference.text);
  transfer.effectAllowed = "copy";
}

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

export function insertReference(draft: string, text: string, caret: number): { draft: string; caret: number } {
  const at = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : after.length === 0 ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  return { draft: `${before}${inserted}${after}`, caret: at + inserted.length };
}
