/**
 * WHAT THE AGENT HOLDS BETWEEN TURNS — a small document, not a longer
 * transcript (#541 part F).
 *
 * ── WHY A DOCUMENT AND NOT MORE HISTORY ─────────────────────────────────────
 * A coordinator's useful memory is four facts: what it is doing, who is on
 * what, what it is waiting to hear, and how this person likes to be worked
 * with. None of them is a sentence somebody said — they are the CONCLUSION of
 * many sentences, and they change slowly. Carrying them as conversation means
 * paying for every message that produced them on every lap of every turn, and
 * then losing them anyway the first time the history is compacted.
 *
 * So they are a document the Agent REWRITES, through `remember`, and the
 * document is in the SYSTEM PROMPT rather than in the transcript. That is the
 * whole difference: the transcript is what happened and is append-only; this is
 * what is true now and is replaced in place.
 *
 * ── REPLACE PER SECTION, WHICH IS WHY THERE ARE SECTIONS ────────────────────
 * One free-text blob would make every update a rewrite of everything, and a
 * model rewriting everything drops a third of it each time — the failure the
 * owner's decision (#541, 2026-09-16) heads off by naming the four sections up
 * front. `remember({section, text})` replaces ONE of them and leaves the other
 * three exactly as they were, so "I finished the dictation work" cannot quietly
 * erase "Facundo prefers small PRs".
 *
 * ── A CAP THAT IS PER SECTION, SO THE DOCUMENT'S CAP IS ARITHMETIC ──────────
 * Each section is bounded by `SECTION_CHARS`, which makes the rendered document
 * at most `STANDING_CHARS` by construction rather than by a check that could be
 * forgotten. `STANDING_CHARS` is DESCRIPTIVE, not a guard: nothing at runtime
 * reads it, it is the arithmetic of four sections plus four headings plus the
 * lead sentence, and a test holds that arithmetic honest. The document's only
 * real bound is the per-section one below.
 *
 * ── AND A SECTION OVER THE CAP IS REFUSED, NOT CLIPPED (#607) ───────────────
 * This used to clip and mark: store the first 872 characters, append "…
 * [clipped; keep it shorter]", report success. Three things were wrong with it.
 *
 * A clip drops the TAIL, and the tail is the newest line — the one that was
 * worth writing — while keeping every stale "RESUELTO: #576" above it. That is
 * the worst available selection rule, and it is precisely backwards from what
 * the note needs, which is to SHED settled things.
 *
 * The tool cannot know which line is settled. Only the Agent does. So the tool
 * says no and hands back what the section holds, and the Agent — which is the
 * only party that can — picks what to drop. That costs one lap, and one lap is
 * cheaper than a fact quietly lost out of a document the Agent then trusts.
 *
 * And the marking was never actually reported. It landed inside the stored
 * section, so the Agent saw it only because `remember` echoed the whole
 * document back — the very thing #607 removes. Marking that survives only
 * through an accident of verbosity is not marking.
 *
 * `clipSection` remains for the READ path, where refusing is not an option: a
 * `memory.json` written by an older build or edited by hand can hold anything,
 * and the rendered document still has to fit. There it clips AND COUNTS what
 * went, per `tool-kit.ts`'s rule that a truncation is never silent.
 *
 * ── AND IT IS A FILE BESIDE `agent.json`, FOR THAT FILE'S OWN REASONS ───────
 * `store.ts` argues it: the Agent names nothing in the engine store, its whole
 * state is small, and `atomicWrite` is the shared part. This is one more
 * document in the same directory, so a reset that archives a thread has one
 * place to look for everything that thread accumulated.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";
import type { AgentPaths } from "./store";

/**
 * THE FOUR SECTIONS, NAMED HERE AND NOWHERE ELSE.
 *
 * The keys are short because they are an enum on a tool argument; the headings
 * are the sentences a model reads in the prompt. Both are in one table so a
 * fifth section cannot be added to one and forgotten in the other.
 */
export const STANDING_SECTIONS = {
  doing: "What I am doing",
  who: "Who is on what",
  questions: "Open questions",
  preferences: "Preferences",
} as const;

export type StandingSection = keyof typeof STANDING_SECTIONS;

export const STANDING_SECTION_KEYS = Object.keys(STANDING_SECTIONS) as StandingSection[];

/** What one section may hold, and the only bound anything enforces. A write
 *  over this is REFUSED — see `rememberSection`. */
export const SECTION_CHARS = 900;

/**
 * THE WHOLE DOCUMENT'S CEILING, and it is a CONSEQUENCE rather than a second
 * check: four sections of `SECTION_CHARS`, four headings and the lead sentence
 * cannot exceed it. Asserted in the tests against a document deliberately
 * overfilled, so the arithmetic cannot rot.
 *
 * NOTHING AT RUNTIME READS THIS. It is descriptive — the number the per-section
 * bound adds up to — and not a guard. Do not add a line assuming one exists.
 */
export const STANDING_CHARS = 4_000;

/**
 * WHERE THE NOTE IS BIG ENOUGH TO BE WORTH PRUNING, which is well below the
 * point where anything refuses.
 *
 * #607's second defect is that the document only ever grew — 448 to 3,698
 * characters, never once smaller for the same section — because settled items
 * were appended as "RESUELTO: #576" instead of removed. A refusal at
 * `SECTION_CHARS` only bites at the wall, and by then the Agent has spent every
 * turn in between carrying the whole thing in its system prompt.
 *
 * So a successful write says how big the note has become once it crosses this,
 * and says it in words that name the fix. It costs nothing while there is room,
 * which is why the threshold is here rather than at the ceiling.
 */
export const CROWDED_CHARS = 2_800;

export type StandingState = {
  sections: Partial<Record<StandingSection, string>>;
  updatedAt?: number;
};

const EMPTY: StandingState = { sections: {} };

/** `<engineRoot>/agent/memory.json`. */
export function standingPath(paths: AgentPaths): string {
  return path.join(paths.dir, "memory.json");
}

/**
 * The document, or an empty one.
 *
 * NEVER THROWS — `readAgentSettings`'s rule, for the same reason: a file
 * somebody hand-edited into nonsense costs the Agent its notes, where a throw
 * would cost every turn on the machine.
 */
export function readStanding(paths: AgentPaths): StandingState {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(standingPath(paths), "utf8"));
    if (!raw || typeof raw !== "object") return { sections: {} };
    const stored = (raw as { sections?: unknown; updatedAt?: unknown }).sections;
    if (!stored || typeof stored !== "object") return { sections: {} };
    const sections: Partial<Record<StandingSection, string>> = {};
    for (const key of STANDING_SECTION_KEYS) {
      const value = (stored as Record<string, unknown>)[key];
      // CLIPPED ON THE WAY IN, so the document's ceiling holds whatever is on
      // disk. `rememberSection` refuses an over-long write, but this file
      // outlives the build that wrote it and a person can edit it.
      if (typeof value === "string" && value.trim()) sections[key] = clipSection(value).text;
    }
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
    return { sections, ...(typeof updatedAt === "number" ? { updatedAt } : {}) };
  } catch {
    return { sections: {} };
  }
}

/** The mark a clipped section carries. COUNTED, not just marked — `tool-kit.ts`
 *  argues why: a reader that cannot tell "this is all of it" from "this is what
 *  fit" will act on a note missing its tail and never know. */
const clippedMark = (dropped: number) => `… [clipped; ${dropped} characters dropped]`;

/**
 * THE READ PATH'S BACKSTOP, and only that — writes are refused, not clipped.
 *
 * Reserves room against the mark at its LONGEST possible width rather than
 * solving for the fixed point: `dropped` is always less than the whole text, so
 * budgeting for the text's own length can only over-reserve, by a digit or two.
 */
export function clipSection(text: string): { text: string; dropped: number } {
  const trimmed = text.trim();
  if (trimmed.length <= SECTION_CHARS) return { text: trimmed, dropped: 0 };
  const kept = trimmed.slice(0, SECTION_CHARS - clippedMark(trimmed.length).length).trimEnd();
  const dropped = trimmed.length - kept.length;
  return { text: `${kept}${clippedMark(dropped)}`, dropped };
}

/**
 * WHAT A WRITE ANSWERS: the section and its size, never the document (#607).
 *
 * `others` is LENGTHS AND NOT TEXT. The Agent needs to know the note is filling
 * up; it does not need three sections it did not touch read back to it, and
 * paying ~3.7 KB per call for them made `remember` the single largest consumer
 * of the Agent's context across its whole history — 100 calls, 377 KB, by the
 * tool whose job is to save context.
 */
export type RememberResult =
  | {
      written: true;
      section: StandingSection;
      /** What the section now holds. */
      chars: number;
      /** The other written sections, by size alone. */
      others: Partial<Record<StandingSection, number>>;
      /** The whole rendered document — what this note costs on every turn. */
      standing: number;
    }
  | {
      written: false;
      section: StandingSection;
      sent: number;
      limit: number;
      over: number;
      /** What the section still holds, so the rewrite does not cost a read as
       *  well as a lap. */
      holding: string;
    };

/** The other written sections by size — never their text. */
function othersOf(state: StandingState, section: StandingSection): Partial<Record<StandingSection, number>> {
  const others: Partial<Record<StandingSection, number>> = {};
  for (const key of STANDING_SECTION_KEYS) {
    if (key === section) continue;
    const value = state.sections[key];
    if (value) others[key] = value.length;
  }
  return others;
}

/** What the document costs in the system prompt, rendered exactly as it goes
 *  there — not the sum of the sections, which omits the headings. */
export function standingChars(state: StandingState): number {
  return renderStanding(state)?.length ?? 0;
}

/**
 * REPLACE ONE SECTION. Empty text CLEARS it, which is how a model says "this is
 * no longer true" without having to write a sentence saying so.
 *
 * REFUSES rather than clips when the text is over `SECTION_CHARS`, and refuses
 * ATOMICALLY: nothing is written, so the section still holds what it held and
 * the refusal cannot leave the note half-updated. See this file's header for
 * why refusing beats clipping.
 */
export function rememberSection(paths: AgentPaths, section: StandingSection, text: string, now: () => number = Date.now): RememberResult {
  const state = readStanding(paths);
  const next = text.trim();
  if (next.length > SECTION_CHARS) {
    return { written: false, section, sent: next.length, limit: SECTION_CHARS, over: next.length - SECTION_CHARS, holding: state.sections[section] ?? "" };
  }
  if (next) state.sections[section] = next;
  else delete state.sections[section];
  state.updatedAt = now();
  fs.mkdirSync(paths.dir, { recursive: true });
  atomicWrite(standingPath(paths), { version: 1, sections: state.sections, updatedAt: state.updatedAt });
  return { written: true, section, chars: next.length, others: othersOf(state, section), standing: standingChars(state) };
}

/** Everything forgotten — the reset path, after the preferences have been kept.
 *  Silent when there was nothing to forget. */
export function clearStanding(paths: AgentPaths): void {
  try {
    fs.rmSync(standingPath(paths), { force: true });
  } catch {
    // A file that will not go away is not a reason a reset fails; the next
    // write replaces it.
  }
}

/**
 * THE BLOCK THAT GOES IN THE SYSTEM PROMPT, or nothing at all.
 *
 * `undefined` WHEN EVERY SECTION IS EMPTY, so a fresh Agent's prompt does not
 * carry a heading saying it remembers nothing — which a model reads as an
 * instruction to fill it in.
 *
 * SECTION ORDER IS FIXED and is the order the sections were declared in, not
 * the order they were written. A prompt whose blocks moved between turns would
 * be a prompt no cache prefix could ever match.
 */
export function renderStanding(state: StandingState): string | undefined {
  const written = STANDING_SECTION_KEYS.filter((key) => state.sections[key]);
  if (written.length === 0) return undefined;
  return [
    "WHAT YOU ARE HOLDING ACROSS TURNS — your own notes, rewritten with `remember`, never part of the conversation. Keep them true; they are what you have after the older turns are folded away.",
    ...written.map((key) => `## ${STANDING_SECTIONS[key]}\n${state.sections[key]}`),
  ].join("\n\n");
}

/** The preferences section alone — what a reset keeps. See the runtime's
 *  reset path and #541's owner decision 3. */
export function preferencesOf(state: StandingState): string | undefined {
  return state.sections.preferences;
}

/**
 * THE ONE NOTE A RESET LEAVES BEHIND — #541's owner decision 3.
 *
 * A TITLE RATHER THAN AN ID, because the note is rewritten on every reset
 * rather than accumulated: a person who has started over four times wants the
 * preferences they taught the Agent, not four copies of them with dates. The
 * title is what the rewrite finds it by, so it is named here and used in one
 * other place.
 */
export const PREFERENCES_NOTE_TITLE = "What the Agent knows about how you work";
