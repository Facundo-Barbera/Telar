/**
 * THE HARNESS'S OWN FILES ARE NOT THE PROJECT'S.
 *
 * Claude Code unpacks its bundled skills into a per-uid temp root
 * (`/private/tmp/claude-502/bundled-skills/2.1.267/<hash>/dataviz/…`) and reads
 * them like any other file, so a data-science turn arrived in the transcript as
 * three `Read file /private/tmp/claude-502/…` rows and a `Ran command cd
 * /private/tmp/claude-502/… && node …`. Every one of those is true and none of
 * them is about the reader's project: it is the harness consulting its own
 * manual, printed at the same size as the work (#354).
 *
 * ONE RULE, TWO CONDITIONS, and the second is what makes the first safe: a path
 * folds only when it is under a known harness root AND outside the session's
 * own checkout. A fixture project really can live at `/tmp/exoplanets` — the
 * dogfood pass used exactly that — so "under /tmp" alone is not evidence of
 * anything, and a workspace that happens to sit inside a harness root must
 * still read as the project it is.
 *
 * NOTHING HERE IS HIDDEN, only folded. The rows keep their content behind a
 * disclosure; what changes is that they stop competing with the work for the
 * reader's attention.
 */

import type { JournalItem } from "@/lib/engine/journal";

export type HarnessName = "claude" | "codex";

/** What a folded row turns out to be about. `skill` is present when the path
 *  names one — the only case where the fold can say something better than
 *  "the harness read its own files". */
export type HarnessConsult = { harness: HarnessName; skill?: string };

/**
 * The temp roots a harness unpacks itself into, matched on a normalised path.
 *
 * Codex's root is listed on the same shape as Claude's. Telar drives both and
 * the pattern is deliberately conservative — a bare `/tmp/codex` would not
 * match, only a `codex-<something>` scratch root — so if Codex never produces
 * one this is inert, and if it does the rows fold without another release.
 */
const HARNESS_ROOTS: ReadonlyArray<{ harness: HarnessName; pattern: RegExp }> = [
  { harness: "claude", pattern: /^\/tmp\/claude-[^/]+\// },
  { harness: "codex", pattern: /^\/tmp\/codex-[^/]+\// },
];

/** Where a harness keeps the skills it ships with. */
const BUNDLED_SKILLS = "bundled-skills";

/**
 * macOS hands the same directory back under two names — `/tmp` is a symlink to
 * `/private/tmp`, `/var` to `/private/var` — and which one a row carries
 * depends on which API the CLI used. Comparing the raw strings would make the
 * workspace test answer differently for the same directory.
 */
function normalise(path: string): string {
  const trimmed = path.trim();
  const resolved = /^\/private\/(tmp|var)\//.test(trimmed) ? trimmed.slice("/private".length) : trimmed;
  return resolved.replace(/\/+$/, "");
}

/** True when `path` is the workspace or something inside it. */
function insideWorkspace(path: string, workspace: string): boolean {
  const root = normalise(workspace);
  if (!root) return false;
  return path === root || path.startsWith(`${root}/`);
}

/**
 * THE RULE. A path is harness-internal when it sits under a known harness root
 * and outside the session's workspace.
 *
 * `workspace` is optional because not every caller knows it — the harness-root
 * test still holds on its own, it is merely less guarded. Pass it wherever it
 * is known.
 */
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

/**
 * The skill a bundled path is about — `dataviz` out of
 * `bundled-skills/2.1.267/31072555…/dataviz/SKILL.md`.
 *
 * The version and the content hash are skipped BY SHAPE rather than by
 * position: both are opaque strings no reader would recognise, and the layout
 * between them belongs to the harness, which is free to change it. The first
 * segment that looks like a name is the name.
 */
function skillName(segments: readonly string[]): string | undefined {
  const at = segments.indexOf(BUNDLED_SKILLS);
  if (at === -1) return undefined;
  const opaque = (segment: string) => /^\d+(?:\.\d+)*$/.test(segment) || /^[0-9a-f]{16,}$/i.test(segment);
  return segments.slice(at + 1).find((segment) => !opaque(segment));
}

/** What the folded row says. Never the path: the path is what the fold is for. */
export function consultLabel(consult: HarnessConsult): string {
  return consult.skill ? `Consulted a skill: ${consult.skill}` : "Consulted the harness's own files";
}

/** The label a FOLDED row contributes to a run's tally. The skill's name is
 *  deliberately dropped here — a tally is a count of kinds, and
 *  "Consulted a skill: dataviz ×4" is a sentence pretending to be one. */
export const CONSULT_TALLY_LABEL = "Consulted a skill";

/**
 * The path a row is about, for this rule only.
 *
 * A COMMAND'S PATH IS ITS WORKING DIRECTORY when it has one, and otherwise the
 * first absolute path in the command itself — which is what catches the shape
 * the issue reported, `cd /private/tmp/claude-502/… && node render.mjs`. A
 * command that merely mentions a harness path is still the harness consulting
 * itself; the disclosure keeps the whole command one press away either way.
 */
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

/**
 * What this row is, if it is the harness talking to itself.
 *
 * A FAILED ROW NEVER FOLDS. "Errors survive collapse" is the transcript's
 * fourth rule, and a skill's own script blowing up is exactly the moment the
 * reader needs to see which file it was reading — the noise argument stops
 * applying the instant something goes wrong.
 */
export function harnessConsult(item: JournalItem, workspace?: string): HarnessConsult | undefined {
  if (item.status === "failed") return undefined;
  const path = harnessCandidatePath(item);
  return path ? harnessInternalPath(path, workspace) : undefined;
}

export type HarnessSegment =
  | { kind: "rows"; items: JournalItem[] }
  | { kind: "consult"; label: string; items: JournalItem[] };

/**
 * A run's rows, with each stretch of harness-internal ones folded into a single
 * line.
 *
 * CONSECUTIVE AND LIKE-LABELLED. Two different skills consulted back to back
 * stay two lines — folding them together would invent a consultation that never
 * happened — and an ordinary row between them breaks the run, because the order
 * of a turn is part of what it says.
 */
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
