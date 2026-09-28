/**
 * Folds rows where the harness reads its own bundled files (e.g.
 * `/private/tmp/claude-502/bundled-skills/...`). A path folds only when under a
 * known harness root and outside the session's workspace. Folded, never hidden.
 */

import type { JournalItem } from "@/platform/engine";

type HarnessName = "claude" | "codex";

/** `skill` is present when the path names one. */
export type HarnessConsult = { harness: HarnessName; skill?: string };

/** Codex's pattern is conservative (`codex-<something>`), so it's inert if Codex never produces one. */
const HARNESS_ROOTS: ReadonlyArray<{ harness: HarnessName; pattern: RegExp }> = [
  { harness: "claude", pattern: /^\/tmp\/claude-[^/]+\// },
  { harness: "codex", pattern: /^\/tmp\/codex-[^/]+\// },
];

const BUNDLED_SKILLS = "bundled-skills";

/** macOS returns `/tmp` and `/private/tmp` (likewise `/var`) for the same directory. */
function normalise(path: string): string {
  const trimmed = path.trim();
  const resolved = /^\/private\/(tmp|var)\//.test(trimmed) ? trimmed.slice("/private".length) : trimmed;
  return resolved.replace(/\/+$/, "");
}

function insideWorkspace(path: string, workspace: string): boolean {
  const root = normalise(workspace);
  if (!root) return false;
  return path === root || path.startsWith(`${root}/`);
}

/** `workspace` is optional; pass it wherever known, since it guards the rule. */
export function harnessInternalPath(path: string, workspace?: string): HarnessConsult | undefined {
  const normalised = normalise(path);
  if (!normalised.startsWith("/")) return undefined;
  if (workspace && insideWorkspace(normalised, workspace)) return undefined;
  const root = HARNESS_ROOTS.find((candidate) => candidate.pattern.test(normalised));
  if (!root) return undefined;
  const rest = normalised.replace(root.pattern, "").split("/").filter(Boolean);
  const skill = skillName(rest);
  return skill === undefined ? { harness: root.harness } : { harness: root.harness, skill };
}

/** Skips version and hash by shape, not position; the first name-like segment is the skill. */
function skillName(segments: readonly string[]): string | undefined {
  const at = segments.indexOf(BUNDLED_SKILLS);
  if (at === -1) return undefined;
  const opaque = (segment: string) => /^\d+(?:\.\d+)*$/.test(segment) || /^[0-9a-f]{16,}$/i.test(segment);
  return segments.slice(at + 1).find((segment) => !opaque(segment));
}

export function consultLabel(consult: HarnessConsult): string {
  return consult.skill ? `Consulted a skill: ${consult.skill}` : "Consulted the harness's own files";
}

/** Tally label for folded rows; the skill name is dropped since a tally counts kinds. */
export const CONSULT_TALLY_LABEL = "Consulted a skill";

/** A command's working directory, else the first absolute path in the command. */
export function harnessCandidatePath(item: JournalItem): string | undefined {
  if (item.detail.type === "file_read") return item.detail.read.path;
  if (item.detail.type === "file_change") return item.detail.change.path;
  if (item.detail.type === "command_execution") {
    const { cwd, command } = item.detail.command;
    if (cwd) return cwd;
    return command.match(/(?:^|\s)(\/(?:private\/)?tmp\/[^\s'"`;|&]+)/)?.[1];
  }
  return undefined;
}

/** A failed row never folds: errors survive collapse. */
export function harnessConsult(item: JournalItem, workspace?: string): HarnessConsult | undefined {
  if (item.status === "failed") return undefined;
  const path = harnessCandidatePath(item);
  return path ? harnessInternalPath(path, workspace) : undefined;
}

export type HarnessSegment =
  | { kind: "rows"; items: JournalItem[] }
  | { kind: "consult"; label: string; items: JournalItem[] };

/** Folds consecutive, like-labelled runs; an ordinary row between them breaks the run. */
export function foldHarnessRows(items: readonly JournalItem[], workspace?: string): HarnessSegment[] {
  const segments: HarnessSegment[] = [];
  for (const item of items) {
    const consult = harnessConsult(item, workspace);
    const last = segments.at(-1);
    if (!consult) {
      if (last?.kind === "rows") last.items.push(item);
      else segments.push({ kind: "rows", items: [item] });
      continue;
    }
    const label = consultLabel(consult);
    if (last?.kind === "consult" && last.label === label) last.items.push(item);
    else segments.push({ kind: "consult", label, items: [item] });
  }
  return segments;
}
