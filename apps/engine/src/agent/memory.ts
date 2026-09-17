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
 * Each section is clipped to `SECTION_CHARS` when it is written, which makes
 * the rendered document at most `STANDING_CHARS` by construction rather than by
 * a check that could be forgotten. A section that arrives too long is CLIPPED
 * AND MARKED rather than refused: the Agent wrote it mid-turn, and a refusal
 * would cost a lap to learn a length limit.
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

/** What one section may hold. Four of these plus their headings is the
 *  document's ceiling — see `STANDING_CHARS`. */
export const SECTION_CHARS = 900;

/**
 * THE WHOLE DOCUMENT'S CEILING, and it is a CONSEQUENCE rather than a second
 * check: four sections of `SECTION_CHARS`, four headings and the lead sentence
 * cannot exceed it. Asserted in the tests against a document deliberately
 * overfilled, so the arithmetic cannot rot.
 */
export const STANDING_CHARS = 4_000;

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
      if (typeof value === "string" && value.trim()) sections[key] = value;
    }
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
    return { sections, ...(typeof updatedAt === "number" ? { updatedAt } : {}) };
  } catch {
    return { sections: {} };
  }
}

/** The mark a clipped section carries, and the room reserved for it. Measured
 *  from the string itself so the two cannot drift apart. */
const CLIPPED = "… [clipped; keep it shorter]";

/** Clipped and MARKED, never silently. A model that cannot see where it was cut
 *  writes the same too-long note again next turn. */
export function clipSection(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SECTION_CHARS) return trimmed;
  return `${trimmed.slice(0, SECTION_CHARS - CLIPPED.length).trimEnd()}${CLIPPED}`;
}

/**
 * REPLACE ONE SECTION. Empty text CLEARS it, which is how a model says "this is
 * no longer true" without having to write a sentence saying so.
 */
export function rememberSection(paths: AgentPaths, section: StandingSection, text: string, now: () => number = Date.now): StandingState {
  const state = readStanding(paths);
  const next = clipSection(text);
  if (next) state.sections[section] = next;
  else delete state.sections[section];
  state.updatedAt = now();
  fs.mkdirSync(paths.dir, { recursive: true });
  atomicWrite(standingPath(paths), { version: 1, sections: state.sections, updatedAt: state.updatedAt });
  return state;
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
