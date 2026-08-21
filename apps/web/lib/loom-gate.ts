import type { GateOutcome, LoomGate, LoomGateResult } from "@telar/engine-client";

/**
 * THE TRI-STATE GATE, IN ONE PLACE.
 *
 * `GateOutcome` is `pass | fail | unknown` and never a boolean, so the chip has
 * to be able to draw three things — plus a fourth, `none`, for a loom that has
 * not been gated at all. Those last two are the ones a careless UI collapses:
 * "not gated yet" and "gated, could not verify" are different sentences, and
 * neither of them is a pass.
 *
 * `unknown` IS WARNING, NEVER SUCCESS. Exit 2 means the gate could not run —
 * Docker was down, the environment was missing, the command was killed. A
 * checkmark there is the UI inventing an answer the machine never gave, and it
 * is the one failure this module exists to make impossible: the mapping lives
 * here, `components/loom/gate-chip.tsx` is its only renderer, and
 * `components/loom/idiom.test.ts` fails if a second one appears.
 *
 * COLOUR AND WORDS BOTH DIFFER, so the distinction survives colour-blindness,
 * a greyscale screenshot, and a glance from across the room.
 */
export type GateTone = "pass" | "fail" | "unknown" | "none";

export type GateDescriptor = {
  tone: GateTone;
  /** The chip's own words. Short enough to sit in a row. */
  label: string;
  /** The longer sentence, for a `title` and for the rows that have room. */
  detail: string;
  /** Container + text classes. Every token here is bridged in `globals.css`. */
  className: string;
};

/**
 * The token table. One entry per tone, and the `unknown` entry is deliberately
 * adjacent to the others so that a future edit that tries to make it green has
 * to do so in full view of the comment above.
 */
const TONES: Record<GateTone, { label: string; detail: string; className: string }> = {
  pass: {
    label: "passed",
    detail: "The gate ran and passed.",
    className: "bg-success/10 text-success",
  },
  fail: {
    label: "failed",
    detail: "The gate ran and failed.",
    className: "bg-destructive/10 text-destructive",
  },
  unknown: {
    label: "could not verify",
    detail: "The gate could not run, so nothing here is verified. This is not a pass.",
    className: "bg-warning/15 text-warning",
  },
  none: {
    label: "not gated",
    detail: "Nothing has been gated on this yet.",
    className: "bg-muted/60 text-muted-foreground",
  },
};

export function gateTone(tone: GateTone): { label: string; detail: string; className: string } {
  return TONES[tone];
}

/**
 * What one gate RESULT says.
 *
 * `undefined` is `none` — never gated — and it is separated from `unknown` on
 * purpose. An exit code is shown when there is one, because the exit code is
 * the fact and the outcome is this project's reading of it; a human debugging a
 * wrong verdict needs the number, not the word.
 */
export function describeGate(result: LoomGateResult | undefined | null): GateDescriptor {
  if (!result) return { tone: "none", ...TONES.none };
  const tone: GateTone = result.outcome;
  const base = TONES[tone];
  const code = result.exitCode === null || result.exitCode === undefined ? "no exit code" : `exit ${result.exitCode}`;
  return {
    tone,
    label: `${code} · ${base.label}`,
    detail: `${result.command} — ${code}. ${base.detail}`,
    className: base.className,
  };
}

/**
 * The exit-code table of one declared gate, as rows, sorted by code.
 *
 * NEVER A BOOLEAN, NOWHERE — including here. The Program tab renders this table
 * rather than a pass/fail switch, because the table IS the gate's meaning in
 * this project and an undeclared code falls through to `unknown` rather than to
 * `fail` (assuming POSIX convention is the imposition the design forbids).
 */
export type GateExitRow = { code: number; outcome: GateOutcome; label: string };

export function gateExitRows(gate: Pick<LoomGate, "exits">): GateExitRow[] {
  return Object.entries(gate.exits ?? {})
    .map(([code, outcome]) => ({ code: Number(code), outcome, label: TONES[outcome].label }))
    .filter((row) => Number.isFinite(row.code))
    .sort((left, right) => left.code - right.code);
}

/** The sentence under the table: what every code the project did NOT declare means. */
export const UNDECLARED_EXIT_SENTENCE = "any other exit code → could not verify";
