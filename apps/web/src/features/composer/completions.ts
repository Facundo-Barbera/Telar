/**
 * What the menu offers for `@` (the workspace listing), `/` (this composer's controls, then the
 * provider's commands) and `$` (the provider's skills). A completion is either text or an action.
 */

import type { ProviderDriverKind, ProviderSkill, ProviderSkillSource, RuntimeMode } from "@telar/engine-client";
import { fileReference, directoryReference, skillReference } from "@/lib/drag-reference";
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from "@/lib/search-ranking";

export type CompletionGlyph = "file" | "directory" | "note" | "access" | "model" | "effort" | "driver" | "env" | "stop" | "compact" | "resume" | "skill";

type CompletionAction =
  /** Replace the trigger with this text; the only action that touches the draft. */
  | { type: "insert"; text: string }
  | { type: "runtime-mode"; mode: RuntimeMode }
  | { type: "env-mode"; mode: "local" | "worktree" }
  | { type: "driver"; driver: ProviderDriverKind }
  | { type: "model"; model: string }
  | { type: "effort"; effort: string }
  | { type: "compact" }
  | { type: "resume" }
  | { type: "stop" };

export type Completion = {
  id: string;
  label: string;
  detail: string;
  glyph: CompletionGlyph;
  action: CompletionAction;
  path?: string;
  /** A section heading, drawn above the first row that carries it (see `ComposerMenu`). */
  group?: string;
  /** Listed but not pickable; the detail says why. */
  disabled?: boolean;
};

export type PathEntry = { path: string; name: string; parent: string; directory: boolean };

/**
 * The flat listing plus every directory implied by it (the engine sends files only).
 * Build once per listing, not per keystroke.
 */
export function buildPathIndex(files: readonly string[]): PathEntry[] {
  const directories = new Set<string>();
  const entries: PathEntry[] = [];
  for (const path of files) {
    const cut = path.lastIndexOf("/");
    entries.push({ path, name: cut === -1 ? path : path.slice(cut + 1), parent: cut === -1 ? "" : path.slice(0, cut), directory: false });
    for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) directories.add(path.slice(0, at));
  }
  for (const directory of directories) {
    const cut = directory.lastIndexOf("/");
    entries.push({
      path: `${directory}/`,
      name: cut === -1 ? directory : directory.slice(cut + 1),
      parent: cut === -1 ? "" : directory.slice(0, cut),
      directory: true,
    });
  }
  return entries;
}

/** The trailing slash is not depth, so `apps/` sits level with `README.md`. */
function depthOf(path: string): number {
  return path.replace(/\/+$/, "").split("/").length;
}

function shallowestFirst(left: PathEntry, right: PathEntry): number {
  const depth = depthOf(left.path) - depthOf(right.path);
  if (depth !== 0) return depth;
  if (left.directory !== right.directory) return left.directory ? -1 : 1;
  return left.path.localeCompare(right.path);
}

function completionForPath(entry: PathEntry): Completion {
  // The same constructors a Files-panel drag uses, so typed and dragged text is identical.
  const reference = entry.directory ? directoryReference(entry.path) : fileReference(entry.path);
  return {
    id: `path:${entry.path}`,
    label: reference.label,
    detail: entry.parent,
    glyph: entry.directory ? "directory" : "file",
    action: { type: "insert", text: reference.text },
    path: entry.path,
  };
}

/**
 * Scored against the basename and the whole path; the better score wins. Fuzzy matching
 * is basename-only, since a subsequence matches nearly any path in a large repo.
 */
export function rankPaths(index: readonly PathEntry[], query: string, limit = 12): Completion[] {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return [...index].sort(shallowestFirst).slice(0, limit).map(completionForPath);

  const ranked: RankedSearchResult<PathEntry>[] = [];
  for (const entry of index) {
    const scores = [
      scoreQueryMatch({ value: entry.name.toLowerCase(), query: normalized, exactBase: 0, prefixBase: 2, boundaryBase: 8, includesBase: 16, fuzzyBase: 100, boundaryMarkers: [".", "-", "_"] }),
      scoreQueryMatch({ value: entry.path.toLowerCase(), query: normalized, exactBase: 1, prefixBase: 4, boundaryBase: 12, includesBase: 24, boundaryMarkers: ["/", "-", "_", "."] }),
    ].filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    // On a tie a file outranks its containing directory.
    insertRankedSearchResult(ranked, { item: entry, score: Math.min(...scores), tieBreaker: `${entry.directory ? 1 : 0}\0${entry.path}` }, limit);
  }
  return ranked.map((entry) => completionForPath(entry.item));
}

type CommandContext = {
  busy: boolean;
  fresh: boolean;
  runtimeMode?: RuntimeMode;
  /** The agent that will receive the next message: the session's, or the canvas's before it exists. */
  driver?: ProviderDriverKind;
  /** Only ever true on an existing session; see `compactBlockedReason`. */
  compacting?: boolean;
  envMode?: "local" | "worktree";
  /** Already folded to one per family by the caller. */
  models?: readonly { id: string; label: string }[];
  /** Effort levels the selected model publishes; empty means no `/effort` row. */
  efforts?: readonly string[];
  /** `onAdopt` is set and no session exists yet; mirrors the picker link's `fresh && onAdopt` gate. */
  canResume?: boolean;
  /** The engine reported Telar's bundled `orchestrate` skill for this session. */
  orchestrate?: boolean;
};

/** Mirrors the engine's `ORCHESTRATE_SKILL_NAME`. */
export const ORCHESTRATE_SKILL = "orchestrate";

/** Names the skill in prose, since only Claude's harness parses slash commands. */
export const ORCHESTRATE_PROMPT = `Use ${skillReference({ name: ORCHESTRATE_SKILL }).text} to coordinate this list:`;

/** `/compact` sent alone is the wheel's button; with an argument it stays a message. */
export function isCompactDraft(draft: string): boolean {
  return draft.trim() === "/compact";
}

export function isResumeDraft(draft: string): boolean {
  return draft.trim() === "/resume";
}

/** Why compacting is unavailable, or undefined. Shared with the usage wheel. */
export function compactBlockedReason(state: { busy: boolean; compacting?: boolean }): string | undefined {
  if (state.compacting) return "Already compacting.";
  if (state.busy) return "A turn is running.";
  return undefined;
}

const ACCESS_COMMANDS: { slug: string; mode: RuntimeMode; detail: string }[] = [
  { slug: "supervised", mode: "approval-required", detail: "Ask before commands and file changes." },
  { slug: "auto-edits", mode: "auto-accept-edits", detail: "Auto-approve edits, ask before other actions." },
  { slug: "auto", mode: "auto", detail: "A reviewer approves routine actions; risky ones still ask." },
  { slug: "full-access", mode: "full-access", detail: "Allow commands and edits without prompts." },
];

/**
 * Commands that would do nothing are not offered (`/stop` needs a running turn, `/worktree`
 * a session not yet created). The one already in effect is listed and marked "(current)".
 */
export function availableCommands(context: CommandContext): Completion[] {
  const commands: Completion[] = [];

  for (const { slug, mode, detail } of ACCESS_COMMANDS) {
    commands.push({
      id: `access:${mode}`,
      label: `/${slug}`,
      detail: context.runtimeMode === mode ? `${detail} (current)` : detail,
      glyph: "access",
      action: { type: "runtime-mode", mode },
    });
  }

  for (const model of context.models ?? []) {
    commands.push({
      id: `model:${model.id}`,
      label: `/model ${model.label}`,
      detail: "Run the next turn on this model.",
      glyph: "model",
      action: { type: "model", model: model.id },
    });
  }

  for (const effort of context.efforts ?? []) {
    commands.push({
      id: `effort:${effort}`,
      label: `/effort ${effort}`,
      detail: "How hard the model thinks before it answers.",
      glyph: "effort",
      action: { type: "effort", effort },
    });
  }

  if (context.fresh) {
    for (const driver of ["claude", "codex"] as const) {
      commands.push({
        id: `driver:${driver}`,
        label: `/${driver}`,
        detail: context.driver === driver ? "Start this session on this agent. (current)" : "Start this session on this agent.",
        glyph: "driver",
        action: { type: "driver", driver },
      });
    }
    for (const mode of ["local", "worktree"] as const) {
      commands.push({
        id: `env:${mode}`,
        label: `/${mode}`,
        detail:
          mode === "worktree"
            ? "Work in a cut-off checkout of its own."
            : "Work directly in the project folder.",
        glyph: "env",
        action: { type: "env-mode", mode },
      });
    }
  }

  // `/compact`: Claude only, once the session exists. Absent rather than disabled otherwise,
   // since neither state recovers by waiting.
  if (!context.fresh && context.driver === "claude") {
    const blocked = compactBlockedReason(context);
    commands.push({
      id: "compact",
      label: "/compact",
      detail: blocked ?? "Summarise the conversation to free space.",
      glyph: "compact",
      action: { type: "compact" },
      ...(blocked ? { disabled: true } : {}),
    });
  }

  // `/resume`: only where the empty composer's link shows.
  if (context.fresh && context.canResume) {
    commands.push({
      id: "resume",
      label: "/resume",
      detail: "Pick up a Claude Code conversation.",
      glyph: "resume",
      action: { type: "resume" },
    });
  }

  // `/orchestrate`: only where the skill is installed.
  if (context.orchestrate) {
    commands.push({
      id: "orchestrate",
      label: "/orchestrate",
      detail: "Split a list of tasks across worker sessions and coordinate them.",
      glyph: "skill",
      action: { type: "insert", text: ORCHESTRATE_PROMPT },
    });
  }

  if (context.busy) {
    commands.push({ id: "stop", label: "/stop", detail: "Stop the turn that is running.", glyph: "stop", action: { type: "stop" } });
  }

  return commands;
}

/**
 * The fuzzy tier makes initials work (`fa` → `full-access`) and sits above every other tier.
 * The description is searchable but its bases start above every name tier, so it cannot win.
 */
export function rankCommands(commands: readonly Completion[], query: string): Completion[] {
  const normalized = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalized) return [...commands];

  const ranked: RankedSearchResult<Completion>[] = [];
  for (const command of commands) {
    const scores = [
      scoreQueryMatch({
        value: command.label.replace(/^\//, "").toLowerCase(),
        query: normalized,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 6,
        includesBase: 12,
        fuzzyBase: 100,
        boundaryMarkers: ["-", " ", "_"],
      }),
      scoreQueryMatch({ value: command.detail.toLowerCase(), query: normalized, exactBase: 40, includesBase: 44 }),
    ].filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    insertRankedSearchResult(ranked, { item: command, score: Math.min(...scores), tieBreaker: command.label }, Number.POSITIVE_INFINITY);
  }
  return ranked.map((entry) => entry.item);
}

const SOURCE_LABEL: Record<ProviderSkillSource, string> = {
  project: "This project",
  user: "This Mac",
  plugin: "Plugin",
  provider: "Provider",
};

function detailFor(entry: ProviderSkill): string {
  // An empty muted column reads as a broken row, so fall back to the source.
  return entry.description || SOURCE_LABEL[entry.source];
}

/** Picking it inserts `the "name" skill`; see `skillReference`. */
function completionForSkill(skill: ProviderSkill): Completion {
  return {
    id: `skill:${skill.name}`,
    label: skill.name,
    detail: detailFor(skill),
    glyph: "skill",
    action: { type: "insert", text: skillReference(skill).text },
  };
}

/**
 * Scored on name and description; the description cannot outrank a name. A namespace
 * is a boundary, so `vd` reaches `vercel:deploy`.
 */
export function rankSkills(skills: readonly ProviderSkill[], query: string, limit = 12): Completion[] {
  const normalized = normalizeSearchQuery(query, { trimLeadingPattern: /^\$+/ });
  if (!normalized) return skills.slice(0, limit).map(completionForSkill);

  const ranked: RankedSearchResult<ProviderSkill>[] = [];
  for (const skill of skills) {
    const scores = [
      scoreQueryMatch({
        value: skill.name.toLowerCase(),
        query: normalized,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 6,
        includesBase: 12,
        fuzzyBase: 100,
        boundaryMarkers: [":", "-", "_", "."],
      }),
      scoreQueryMatch({ value: skill.description.toLowerCase(), query: normalized, exactBase: 40, includesBase: 44 }),
    ].filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    insertRankedSearchResult(ranked, { item: skill, score: Math.min(...scores), tieBreaker: skill.name }, limit);
  }
  return ranked.map((entry) => completionForSkill(entry.item));
}

export const PROVIDER_COMMAND_GROUP = "Provider commands";

/** Picking one inserts `/name`, which the harness parses when the message arrives. */
export function providerCommandCompletions(commands: readonly ProviderSkill[]): Completion[] {
  return commands.map((command) => ({
    id: `provider:${command.name}`,
    label: `/${command.name}`,
    detail: detailFor(command),
    glyph: "skill",
    group: PROVIDER_COMMAND_GROUP,
    action: { type: "insert", text: `/${command.name}` },
  }));
}
