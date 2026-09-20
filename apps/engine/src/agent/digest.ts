/**
 * WHAT HAPPENED WHILE YOU WERE AWAY — the turn-start digest (#541 A).
 *
 * ── A PROJECTION, NOT A MODEL CALL ──────────────────────────────────────────
 * This is the whole reason a wake is no longer a turn. Summarising four
 * completions used to cost four conversations; it costs a string concatenation
 * now, and the string is deterministic — the same unread rows render the same
 * digest, every time, which is what makes it something a test can hold rather
 * than something a model was asked nicely to do.
 *
 * ── THE RANKING IS THE ARGUMENT ─────────────────────────────────────────────
 *   1. WAITING ON YOU. A parked request is the only band a person can act on,
 *      and a digest that led with "three sessions finished" while one sat
 *      blocked would bury the single line that mattered.
 *   2. FAILED. Something went wrong and somebody should know why. Each failure
 *      keeps its own line — see the cohort note below.
 *   3. COMPLETED. Good news, and the band that merges.
 *   4. EVERYTHING ELSE, AS COUNTS. A stopped turn and a peer's report are facts
 *      worth knowing happened; neither is worth a line each at the top of a
 *      conversation about something else.
 *
 * ── THE COHORT MERGE, AND WHY ONLY COMPLETIONS ──────────────────────────────
 * T3's rule (`Orchestrator.ts:planDelegatedCompletionDelivery`) is that siblings
 * which settled since the last turn arrive as ONE line. Applied to COMPLETIONS
 * that is exactly right: four workers finishing is one fact — "the fan-out is
 * done" — and four lines saying it is four lines saying it.
 *
 * It is NOT applied to failures, and that is a decision rather than an
 * oversight (settled with the owner before this was built). A failure's summary
 * carries the reason it failed, which is the actionable half; merging four of
 * them into "4 sessions failed" hides every reason behind a fetch the Agent has
 * to think to make. The band is already ranked above completions precisely
 * because those lines are worth their space.
 *
 * ── AND IT IS CAPPED, A WHOLE BAND AT A TIME ────────────────────────────────
 * `DIGEST_MAX_CHARS` is a ceiling on the block. Bands are emitted in priority
 * order and the first that would cross it stops the listing; everything past
 * the stop is counted in one closing line naming the call that retrieves it. A
 * digest that grew with the backlog would make the quietest possible turn the
 * most expensive one.
 *
 * A BAND IS NEVER HALF-LISTED. Filling the remaining space line by line would
 * show four of sixty failures and then say "60 more" — the same rows both
 * listed and tallied, and a reader with no way to tell a short band from a
 * truncated one.
 */
import type { AgentInboxKind, AgentInboxRow } from "./inbox";

/**
 * HOW MUCH OF A TURN THE DIGEST MAY SPEND — ~2k characters, which is under 2%
 * of the trim budget and about a screenful of lines. Past this the reader is a
 * model that has not been told what it is being asked yet.
 */
export const DIGEST_MAX_CHARS = 2_000;

/** The header and footer, spelled once. The block is FRAMED because it is
 *  engine prose sitting in a turn a person began: a reader that could not tell
 *  it from the briefing would be reading a machine's summary as an instruction. */
const OPEN = "[Telar · what happened since your last turn — written by the engine, not by anyone]";
const CLOSE = "[end of digest]";

/** One session id, shortened the way every row in the cockpit shortens one. */
const shortId = (id: string): string => (id.length > 8 ? `…${id.slice(-6)}` : id);

/** The summary with its own bracketed kind prefix stripped, so a line reads as
 *  one sentence rather than as a label inside a label. `wakeMessage` writes
 *  `[wake: completed] Session … — …`, and this digest supplies the verb itself. */
function sentence(summary: string): string {
  return summary.replace(/^\[[^\]]*]\s*/, "").trim();
}

/** Rows of one kind, oldest first, as lines. */
function plain(rows: readonly AgentInboxRow[], verb: string): string[] {
  return rows.map((row) => `- ${verb} · session ${shortId(row.sessionId)} — ${sentence(row.summary)}`);
}

/**
 * THE COMPLETIONS, MERGED WHEN THERE IS MORE THAN ONE.
 *
 * ONE LINE NAMES EVERY SESSION, because "4 finished" without saying which four
 * would send the Agent to `sessions_find` to learn something the row already
 * knew. Two or more sessions merge; a single completion keeps its sentence,
 * since there is nothing to merge it with and its summary is the useful part.
 *
 * DISTINCT BY SESSION: a session that completed twice since the last turn is
 * one sibling, not two, and listing it twice would overstate the fan-out.
 */
function completions(rows: readonly AgentInboxRow[]): string[] {
  if (rows.length === 0) return [];
  if (rows.length === 1) return plain(rows, "finished");
  const sessions = [...new Set(rows.map((row) => row.sessionId))];
  if (sessions.length === 1) return [`- finished · session ${shortId(sessions[0]!)} — ${rows.length} turns completed`];
  return [`- finished · ${sessions.length} sessions — ${sessions.map(shortId).join(", ")}`];
}

/** The counted tail: one line per remaining kind, with its number. */
function counted(rows: readonly AgentInboxRow[]): string[] {
  const label: Partial<Record<AgentInboxKind, (n: number) => string>> = {
    turn_stopped: (n) => `${n} ${n === 1 ? "turn was" : "turns were"} stopped`,
    peer_message: (n) => `${n} ${n === 1 ? "message" : "messages"} from other sessions`,
  };
  const lines: string[] = [];
  for (const [kind, describe] of Object.entries(label) as Array<[AgentInboxKind, (n: number) => string]>) {
    const count = rows.filter((row) => row.kind === kind).length;
    if (count > 0) lines.push(`- ${describe(count)}`);
  }
  return lines;
}

export type AgentDigest = {
  /** The block to put in front of the model, framed. */
  text: string;
  /** Every row this digest accounts for — what the turn marks read when it
   *  ends. Includes the rows folded into a count and the ones past the cap: the
   *  digest REPORTED them, and the closing line says how to retrieve any it did
   *  not spell out. Leaving them unread would grow a tail that re-renders at the
   *  top of every turn for ever. */
  rowIds: number[];
  /** How many rows the block did not spell out — the number in its last line. */
  overflow: number;
};

/**
 * THE BLOCK, OR NOTHING AT ALL.
 *
 * `undefined` WHEN THERE IS NOTHING UNREAD, and that is the ordinary case on a
 * machine with no fan-out running: a turn that opened with "nothing happened"
 * would be paying for the feature on every message anyone ever sends.
 */
export function renderDigest(rows: readonly AgentInboxRow[], options: { maxChars?: number } = {}): AgentDigest | undefined {
  if (rows.length === 0) return undefined;
  const maxChars = Math.max(200, options.maxChars ?? DIGEST_MAX_CHARS);
  const ordered = [...rows].sort((left, right) => left.id - right.id);

  const bands: Array<{ kinds: AgentInboxKind[]; lines: string[] }> = [
    { kinds: ["request_opened"], lines: plain(ordered.filter((row) => row.kind === "request_opened"), "WAITING ON YOU") },
    { kinds: ["turn_failed"], lines: plain(ordered.filter((row) => row.kind === "turn_failed"), "FAILED") },
    { kinds: ["turn_completed"], lines: completions(ordered.filter((row) => row.kind === "turn_completed")) },
    { kinds: ["turn_stopped", "peer_message"], lines: counted(ordered) },
  ];

  /**
   * EMITTED IN PRIORITY ORDER, A WHOLE BAND AT A TIME, UNTIL ONE WOULD CROSS THE
   * CEILING.
   *
   * ALL OR NOTHING PER BAND, and that is the part worth stating. Filling the
   * remaining space line by line would show four of sixty failures and then
   * count sixty — the same rows both listed and tallied, and a reader with no
   * way to tell a short band from a truncated one. A band that does not fit is
   * counted instead, whole.
   */
  const chosen: string[] = [];
  const spokenFor = new Set<AgentInboxKind>();
  let used = OPEN.length + CLOSE.length + 2;
  for (const band of bands) {
    const cost = band.lines.reduce((total, line) => total + line.length + 1, 0);
    if (used + cost > maxChars) break;
    chosen.push(...band.lines);
    used += cost;
    for (const kind of band.kinds) spokenFor.add(kind);
  }

  /**
   * HOW MANY ROWS THE BLOCK DID NOT SPELL OUT. Counted in ROWS rather than in
   * lines, because that is the number `sessions_find` would answer with — a
   * merged completions line stands for several rows, and saying "3 more" when
   * there are eleven would be a number nobody could reconcile.
   */
  const overflow = ordered.filter((row) => !spokenFor.has(row.kind)).length;

  const lines = [OPEN, ...chosen];
  if (overflow > 0) {
    // THE RETRIEVAL IS NAMED. A reader told only that more exists acts on the
    // part it was shown — `wakeMessage`'s own rule, one level up.
    lines.push(`- and ${overflow} more — sessions_find to see them.`);
  }
  lines.push(CLOSE);
  return { text: lines.join("\n"), rowIds: ordered.map((row) => row.id), overflow };
}
