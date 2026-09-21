/**
 * WHAT THE MENU OFFERS WHEN YOU TYPE `@` OR `/`.
 *
 * Two sources, one shape. `@` ranks the workspace listing the Files tree
 * already fetched — no new engine call, because the answer to "what paths exist
 * here" was fetched once and is the same answer. `/` offers THE THINGS THIS
 * COMPOSER CAN ACTUALLY DO: the controls in its own toolbar, reachable from the
 * keyboard without moving a hand to the mouse.
 *
 * `$` OFFERS THE PROVIDER'S SKILLS, and `/` now ALSO offers the provider's own
 * slash commands — both from `GET /v2/sessions/:id/skills`, which is the engine
 * asking rather than this module guessing. It used to guess nothing at all, and
 * this header said why: the engine did not ask, so a list here would have been
 * a list of plausible names that may not exist. That reason is gone (#387); the
 * rule it protected is not. Every row below still comes from somewhere real.
 *
 * TELAR'S VERBS COME FIRST AND THE PROVIDER'S FOLLOW, under their own heading.
 * The verbs are what THIS composer does — four keystrokes to change access, to
 * stop, to switch model — and a machine with thirty plugin commands installed
 * would otherwise bury them under rows that all do the same kind of thing.
 *
 * A COMPLETION IS EITHER TEXT OR AN ACTION, never both. Picking a path types
 * something; picking `/full-access` changes a control and leaves the message
 * you were writing alone. Modelling that as one union is what keeps the menu's
 * keyboard handling from growing a special case per row.
 */

import type { ProviderDriverKind, ProviderSkill, ProviderSkillSource, RuntimeMode } from "@telar/engine-client";
import { fileReference, directoryReference, skillReference } from "./drag-reference";
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from "./search-ranking";

export type CompletionGlyph = "file" | "directory" | "note" | "access" | "model" | "effort" | "driver" | "env" | "stop" | "compact" | "resume" | "skill";

export type CompletionAction =
  /** Replace the trigger with this text. The ONLY action that touches the draft. */
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
  /** The bold half of the row. A basename, or `/full-access`. */
  label: string;
  /** The muted half. A containing directory, or what the command does. */
  detail: string;
  glyph: CompletionGlyph;
  action: CompletionAction;
  /** The full path, for a file row's icon and its tooltip. */
  path?: string;
  /** The section this row belongs under, when it is not the menu's own. Drawn
   *  as a heading above the first row that carries it — see `ComposerMenu`. */
  group?: string;
  /**
   * LISTED BUT NOT PICKABLE, and the detail says why.
   *
   * The rule above — a command that would do nothing is not offered — has one
   * exception, and `/compact` is it: the gesture EXISTS on this session and is
   * momentarily unavailable, which is a different sentence from "this session
   * cannot compact". The usage wheel already draws exactly that state (a
   * disabled button carrying its own reason), and a menu that hid the row
   * instead would answer "where did /compact go" with silence.
   */
  disabled?: boolean;
};

/* ------------------------------------------------------------------ *
 * `@` — paths.
 * ------------------------------------------------------------------ */

export type PathEntry = { path: string; name: string; parent: string; directory: boolean };

/**
 * The flat listing, plus every directory implied by it.
 *
 * THE ENGINE SENDS FILES ONLY (`WorkspaceListing.files`), so a directory exists
 * here exactly when something inside it does. That is the same definition git
 * uses and the same one the Files tree draws, so the three agree without a
 * fourth source of truth.
 *
 * BUILT ONCE PER LISTING, not per keystroke: this walks every path and the
 * ranking below walks the result, so doing it inline would turn one pass into
 * two on every character typed.
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

/**
 * Depth, then directories, then alphabetical. What "the top of the repository"
 * looks like when nothing has been typed yet and the menu has to show SOMETHING.
 *
 * THE TRAILING SLASH IS NOT DEPTH. `apps/` and `README.md` are both at the top
 * level, and counting the separator that says "this is a folder" as another
 * level down buries every directory under every root file.
 */
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
  // The SAME constructors a drag from the Files panel uses, so a path typed and
  // a path dragged produce byte-identical text. Two spellings for one gesture is
  // how a transcript ends up looking like two different people wrote it.
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
 * Rank the listing against what has been typed after the `@`.
 *
 * SCORED TWICE AND THE BETTER SCORE WINS: once against the basename, which is
 * what people type, and once against the whole path, which is how they
 * disambiguate two files with the same name. Taking the minimum means typing
 * `driver` finds `driver.ts` anywhere, and typing `engine/driver` finds the one
 * in `apps/engine` — without the caller choosing a mode.
 *
 * FUZZY ONLY ON THE BASENAME. A subsequence match against a full path matches
 * nearly everything in a large repository (the separators alone carry most
 * queries), so the whole-path tiers stop at "contains".
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
    // A file outranks the directory that contains it on a tie: the query was
    // typed to reach a thing, and a folder is a place.
    insertRankedSearchResult(ranked, { item: entry, score: Math.min(...scores), tieBreaker: `${entry.directory ? 1 : 0} ${entry.path}` }, limit);
  }
  return ranked.map((entry) => completionForPath(entry.item));
}

/* ------------------------------------------------------------------ *
 * `/` — this composer's own controls.
 * ------------------------------------------------------------------ */

export type CommandContext = {
  /** A turn is running, which is the only state where stopping means anything. */
  busy: boolean;
  /** No session yet, so the driver and the environment are still choosable. */
  fresh: boolean;
  runtimeMode?: RuntimeMode;
  /** THE AGENT THIS SESSION RUNS ON — the one it was created with once it
   *  exists, the one the canvas is pointed at while it does not. Both readings
   *  are "which harness will receive the next message", which is what the rows
   *  below need to know. */
  driver?: ProviderDriverKind;
  /** The provider is squeezing its context right now. Only ever true on a
   *  session that exists; see `compactBlockedReason`. */
  compacting?: boolean;
  envMode?: "local" | "worktree";
  /** The catalogue rows the model pill is currently offering, already folded to
   *  one per family by the caller — this module must not know how a family is
   *  derived, only what it is called. */
  models?: readonly { id: string; label: string }[];
  /** Effort levels the SELECTED model actually publishes. Empty when it
   *  publishes none, and then no `/effort` row is offered at all. */
  efforts?: readonly string[];
  /** The composer actually has somewhere to send a pick — `onAdopt` is set
   *  and the session does not exist yet. Mirrors the picker link's own
   *  `fresh && onAdopt` gate, so the menu row and the link agree about when
   *  `/resume` means anything. */
  canResume?: boolean;
};

/**
 * THE DRAFT THAT IS THE GESTURE RATHER THAN A MESSAGE.
 *
 * `/compact` typed out and sent with nothing else in the box is the same press
 * as the wheel's button, and this is the one place that says so. Trimmed only:
 * `/compact summarise the API work` is a sentence with an argument in it, which
 * this composer cannot pass on, so it stays an ordinary message.
 */
export function isCompactDraft(draft: string): boolean {
  return draft.trim() === "/compact";
}

/**
 * THE DRAFT THAT IS "OPEN THE RESUME PICKER" — the same shape as
 * `isCompactDraft`, and for the same reason: picking the menu row and typing
 * the whole command out are one gesture, and only one of them should have to
 * be taught to the other.
 */
export function isResumeDraft(draft: string): boolean {
  return draft.trim() === "/resume";
}

/**
 * WHY COMPACTING IS UNAVAILABLE, or nothing when it is not.
 *
 * SHARED WITH THE USAGE WHEEL, which is the whole reason it is a function: the
 * button and the menu row describe one capability, and two copies of "A turn is
 * running." drift the first time somebody rewords one of them.
 */
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
 * Every command this composer can run right now, before filtering.
 *
 * A COMMAND THAT WOULD DO NOTHING IS NOT OFFERED. `/stop` needs a running turn;
 * `/worktree` needs a session that has not been created yet, because the
 * checkout is cut at creation and a later press would be a lie. The alternative
 * — showing them greyed — puts four permanently dead rows at the top of a menu
 * that is meant to be four keystrokes long.
 *
 * THE ONE ALREADY IN EFFECT IS STILL LISTED, and marked in its detail rather
 * than hidden: a menu whose contents depend on the current setting cannot be
 * learned, because the row you used last time is the one that is missing.
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

  /**
   * `/compact` — THE WHEEL'S BUTTON, REACHED FROM THE KEYBOARD.
   *
   * CLAUDE ONLY, and only once the session exists: Codex has no out-of-turn
   * compaction door (its app-server lives exactly one run), and a canvas has no
   * conversation to squeeze. Those two make the row ABSENT rather than
   * disabled, because neither is a state the session recovers from by waiting.
   */
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

  /**
   * `/resume` — THE EMPTY COMPOSER'S OWN LINK, REACHED FROM THE KEYBOARD.
   *
   * Only where the link itself shows: a fresh composer with somewhere to put
   * the pick. Once a session exists, resuming into it would mean something
   * else entirely, so the row is absent rather than disabled.
   */
  if (context.fresh && context.canResume) {
    commands.push({
      id: "resume",
      label: "/resume",
      detail: "Pick up a Claude Code conversation.",
      glyph: "resume",
      action: { type: "resume" },
    });
  }

  if (context.busy) {
    commands.push({ id: "stop", label: "/stop", detail: "Stop the turn that is running.", glyph: "stop", action: { type: "stop" } });
  }

  return commands;
}

/**
 * Filter and rank the commands against what follows the slash.
 *
 * THE FUZZY TIER IS WHAT MAKES INITIALS WORK, and it is why it is here despite
 * a nine-row list: `fa` is not a prefix of `full-access` and does not appear in
 * it as a substring — the two letters are the two words. Without a subsequence
 * match, the obvious abbreviation for every hyphenated command matches nothing.
 * Its base is far enough above the other tiers that it can never outrank a
 * genuine prefix, which is the tiering doing its job. Same shape the donor's
 * `composerSlashCommandSearch.ts` uses.
 *
 * THE DESCRIPTION IS SEARCHABLE BUT CANNOT WIN. Its bases start above every
 * name tier, so "prompts" finds `/full-access` and `/supervised` finds itself.
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

/* ------------------------------------------------------------------ *
 * `$` and the provider's half of `/` — what the engine reported.
 * ------------------------------------------------------------------ */

/** Where a name came from, said in the words a person would use. `provider` has
 *  no file to point at, which is exactly what makes it worth labelling. */
const SOURCE_LABEL: Record<ProviderSkillSource, string> = {
  project: "This project",
  user: "This Mac",
  plugin: "Plugin",
  provider: "Provider",
};

function detailFor(entry: ProviderSkill): string {
  // The description when there is one, and where it came from when there is
  // not: an empty muted column reads as a broken row rather than a terse one.
  return entry.description || SOURCE_LABEL[entry.source];
}

/**
 * A skill row. Picking it inserts `the "name" skill` — see `skillReference`.
 *
 * THE SAME CONSTRUCTOR A CHIP IS READ BACK WITH, for the reason the path rows
 * use `fileReference`: one wire form per kind, produced in one place, so the
 * text that goes out and the chip that draws over it cannot disagree.
 */
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
 * Rank the provider's skills against what follows the `$`.
 *
 * SCORED ON THE NAME AND ON THE DESCRIPTION, the same two-tier shape `@` uses
 * for a basename and a path: the name is what people type, and the description
 * is how somebody who half-remembers a skill finds it. The description's bases
 * start above every name tier, so it can never outrank a name.
 *
 * A NAMESPACE IS A BOUNDARY, which is what lets `vd` reach `vercel:deploy`.
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

/** The heading the provider's own commands sit under in the `/` menu. */
export const PROVIDER_COMMAND_GROUP = "Provider commands";

/**
 * The provider's slash commands, as rows.
 *
 * PICKING ONE INSERTS `/name`, WHICH IS THE POINT: unlike every other row in
 * this menu, a provider command is not something the cockpit performs — it is
 * text the HARNESS parses when the message arrives. So the trigger is replaced
 * by the command itself rather than eaten, and the caller's trailing space puts
 * the caret where an argument would go.
 */
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
