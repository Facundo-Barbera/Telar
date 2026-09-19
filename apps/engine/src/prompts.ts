/**
 * THE PROMPT SHELF — one JSON file per project, at the engine root.
 *
 * Unsent messages kept by NAME, so a prompt can be put down and picked up later
 * by whichever composer wants it. The contract is `PreparedPrompt`; read its
 * docblock for why this lives in the engine rather than the browser, which is
 * the whole reason the file exists: an agent writes here from a worker process,
 * and the cockpit's composer has to see what it wrote.
 *
 * ── A FREE-STANDING MODULE, exactly as `notes.ts` is ────────────────────────
 * Nothing here imports `state.ts` except its PATH TYPE, and nothing in
 * `state.ts` imports this. The shelf's directory hangs off `paths.root`, so
 * adding the feature adds ZERO lines to a 650 KB file every other branch is
 * editing. The daemon's routes call these functions with `store.paths`, having
 * already resolved the project through `store.getProject`.
 *
 * ── ONE FILE PER PROJECT, NOT ONE FOR ALL OF THEM ───────────────────────────
 * A prepared prompt ALWAYS has a project — `projectId` is required — so the
 * "belongs to nothing" file is not a case that exists, and unregistering one
 * project cannot rewrite another's shelf.
 *
 * ── THE TWO-VOCABULARY CONTRACT, AS EVERYWHERE IN THIS TREE ─────────────────
 * Reads are tolerant per row: a hand-edit that breaks ONE prompt must not lose
 * the shelf. Writes are loud, with sentences a human can act on.
 *
 * ── DELETE IS A REAL DELETE ─────────────────────────────────────────────────
 * A prompt is consumed by being sent, and a shelf whose job is to stay short
 * cannot accumulate tombstones. The provenance that survives is `author`, which
 * no patch may touch — see `PATCHABLE`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PreparedPrompt, PREPARED_PROMPT_SCHEMA_VERSION, type PreparedPromptAuthor } from "@telar/engine-client";
import { atomicWrite } from "./atomic";
import type { EngineStatePaths } from "./state";

/** Thrown for every refusal, mapped by the daemon to a 400/404 the same way
 *  every other store's `Error`s are — one shape of complaint, not two. */
export class PreparedPromptsError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "PreparedPromptsError";
  }
}

export function promptsDirectory(paths: EngineStatePaths): string {
  return path.join(paths.root, "prompts");
}

/**
 * A project's file. The id is URL-SAFE-CHECKED rather than escaped, for the
 * reason `notesPath` states: an id carrying a separator would write outside the
 * shelf directory, and this is the one place a caller-supplied string becomes a
 * path.
 */
export function promptsPath(paths: EngineStatePaths, projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new PreparedPromptsError("invalid_request", `"${projectId}" is not a project id this shelf can address.`);
  }
  return path.join(promptsDirectory(paths), `${projectId}.json`);
}

const newPromptId = (): string => `q-${crypto.randomBytes(6).toString("hex")}`;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const two = (value: number): string => String(value).padStart(2, "0");

/** The display half of a stamp, stated here rather than imported so this module
 *  owes the notebook nothing. */
export function promptLabel(at: Date): string {
  return `${WEEKDAYS[at.getDay()]} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * NEWEST FIRST, and that is the whole order.
 *
 * No pin and no hand-order, unlike the notebook — deliberately. A notebook is
 * furniture you arrange; a shelf of unsent prompts is a QUEUE you are working
 * off, and the one you prepared a minute ago is the one you are about to use.
 * The cockpit bands agent drafts apart from your own when it draws them, which
 * is a rendering decision and not this sort's business.
 *
 * THE ID TIEBREAK IS A BACKSTOP AND MUST NEVER DECIDE ANYTHING REAL. An id is
 * random hex, so an order it settles is a coin flip — which is exactly what
 * happened while `created.at` could tie (see `createPrompt`). It is kept only so
 * that a HAND-EDITED file with two identical stamps still reads the same way
 * twice; every stamp this module writes is unique within its shelf, so for
 * stored data this branch is unreachable.
 */
export function sortPrompts(prompts: readonly PreparedPrompt[]): PreparedPrompt[] {
  return [...prompts].sort((left, right) => right.created.at - left.created.at || left.id.localeCompare(right.id));
}

/**
 * TOLERANT PER ROW. An absent file is the ordinary first-run state rather than
 * an error: a project nobody has set a prompt aside in has an empty shelf, which
 * is a fact and not a failure.
 */
export function readPrompts(paths: EngineStatePaths, projectId: string): PreparedPrompt[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(promptsPath(paths, projectId), "utf8"));
  } catch (error) {
    if (error instanceof PreparedPromptsError) throw error;
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const prompts: PreparedPrompt[] = [];
  for (const row of raw) {
    const parsed = PreparedPrompt.safeParse(row);
    if (!parsed.success) continue;
    if (parsed.data.projectId !== projectId) continue;
    if (prompts.some((prompt) => prompt.id === parsed.data.id)) continue;
    prompts.push(parsed.data);
  }
  return sortPrompts(prompts);
}

export function writePrompts(paths: EngineStatePaths, projectId: string, prompts: readonly PreparedPrompt[]): PreparedPrompt[] {
  const parsed = sortPrompts(prompts.map((prompt) => PreparedPrompt.parse(prompt)));
  atomicWrite(promptsPath(paths, projectId), parsed);
  return parsed;
}

export function getPrompt(paths: EngineStatePaths, projectId: string, id: string): PreparedPrompt | null {
  return readPrompts(paths, projectId).find((prompt) => prompt.id === id) ?? null;
}

/** Which projects have a shelf on disk. Not the project registry — that is
 *  `store.listProjects`, and a project with no prepared prompts has no file. */
export function shelvedProjects(paths: EngineStatePaths): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(promptsDirectory(paths));
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

/**
 * THE SIZE BOUNDS, stated so a refusal is a sentence rather than a filesystem
 * error four layers down.
 *
 * The text budget is generous because a prepared prompt is a MESSAGE — a
 * briefing with a spec pasted into it is a legitimate one, and this is the same
 * order of magnitude the notebook allows a runbook.
 */
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_REASON_LENGTH = 400;

/**
 * HOW MANY ONE PROJECT KEEPS, and what happens at the edge.
 *
 * A shelf is read by a human choosing from a list; past a few dozen it is not a
 * list any more, it is a search problem nobody asked for. At the cap the OLDEST
 * goes — the opposite of refusing the write, because refusing means an agent's
 * handoff silently fails at exactly the moment the shelf is most in use, and the
 * prompt it is dropping is the one you are least likely to want.
 */
export const PROMPT_SHELF_LIMIT = 50;

export type NewPreparedPrompt = {
  title: string;
  text: string;
  /** The session this prompt is FOR. Present is the handoff case; absent puts
   *  it on every composer in the project. */
  sessionId?: string;
  /** An agent's one line on why it is offering this. */
  reason?: string;
  /** Whose hand. The HTTP route defaults it to "you"; the tool wall's own code
   *  declares "session". */
  author: PreparedPromptAuthor;
};

function assertTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim()) {
    throw new PreparedPromptsError("invalid_request", "A prepared prompt needs a title — a few words naming what it asks for.");
  }
  if (title.trim().length > MAX_TITLE_LENGTH) {
    throw new PreparedPromptsError("invalid_request", `A title is a few words, not ${title.trim().length} characters.`);
  }
  return title.trim();
}

/**
 * AN EMPTY TEXT IS REFUSED, and this is where the shelf parts company with the
 * notebook. A note with a title and no body is a reminder to write it; a PROMPT
 * with no text is a row that does nothing when you press it — the one outcome a
 * list of things-to-send must never contain.
 */
function assertText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new PreparedPromptsError("invalid_request", "A prepared prompt needs its text — the message that would be sent.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new PreparedPromptsError("invalid_request", `A prepared prompt holds up to ${MAX_TEXT_BYTES / 1024} KB of text; this one is larger.`);
  }
  return text;
}

function assertReason(reason: unknown): string {
  if (typeof reason !== "string") {
    throw new PreparedPromptsError("invalid_request", "A reason is one line of text saying why this prompt is being offered.");
  }
  if (reason.trim().length > MAX_REASON_LENGTH) {
    throw new PreparedPromptsError("invalid_request", `A reason is one line, not ${reason.trim().length} characters.`);
  }
  return reason.trim();
}

export function createPrompt(paths: EngineStatePaths, projectId: string, input: NewPreparedPrompt, at: Date = new Date()): PreparedPrompt {
  const existing = readPrompts(paths, projectId);
  /**
   * STRICTLY INCREASING WITHIN ONE SHELF — the clock proposes, the shelf decides.
   *
   * `Date.now()` has millisecond resolution and two prompts are routinely
   * written inside one of them: over loopback, a create-then-create is under a
   * millisecond about a quarter of the time (measured). Equal stamps left the
   * sort to its id tiebreak, and an id is RANDOM HEX — so the two came back in
   * an arbitrary order, roughly half the time the wrong one. "Newest first" is
   * the only ordering this shelf promises, and it was a coin flip.
   *
   * Found as a flaky test; it was never only a test. Two follow-ups an agent
   * drafts in the same millisecond would appear in the composer in either order,
   * and the reason nobody had seen it is that nobody can tell two drafts apart
   * fast enough to notice — which is precisely the kind of wrongness that never
   * gets reported.
   *
   * Borrowing a millisecond from the future is the cost, and it is the right one
   * to pay: at the minute resolution `promptLabel` renders, the stamp is
   * unchanged, and the ordering it buys is exact rather than probable. It also
   * makes a clock that steps BACKWARDS harmless — without this, an NTP
   * correction mid-burst would silently reorder the shelf.
   *
   * `existing` is sorted newest-first, so its head is the only stamp to beat.
   */
  const moment = Math.max(at.getTime(), (existing[0]?.created.at ?? 0) + 1);
  // LABELLED FROM THE INSTANT IT IS STAMPED WITH, not from the raw clock, so the
  // words and the number can never disagree about which prompt came first.
  const stamp = { label: promptLabel(new Date(moment)), at: moment };
  // Validated before the spread decides anything: a blank reason is DROPPED
  // rather than stored, so a row never shows an empty second line.
  const reason = input.reason === undefined ? "" : assertReason(input.reason);
  const prompt = PreparedPrompt.parse({
    id: newPromptId(),
    projectId,
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    title: assertTitle(input.title),
    text: assertText(input.text),
    ...(reason ? { reason } : {}),
    created: stamp,
    updated: stamp,
    author: input.author,
    schemaVersion: PREPARED_PROMPT_SCHEMA_VERSION,
  });
  // Sorted newest-first by `writePrompts`, so the cap always sheds from the END.
  writePrompts(paths, projectId, sortPrompts([...existing, prompt]).slice(0, PROMPT_SHELF_LIMIT));
  return prompt;
}

/**
 * What an edit may change. The EXCLUSIONS are the contract: `author` is
 * provenance stamped at creation, and `id`, `projectId` and `created` are
 * identity — moving a prompt between projects is writing a new one.
 */
const PATCHABLE = ["title", "text", "reason"] as const;

export type PreparedPromptPatch = Partial<{ title: string; text: string; reason: string }>;

/**
 * Edit a prompt. `null` when nothing goes by the id; a forbidden key THROWS
 * rather than being silently dropped — the runtime half `updateNote` keeps, for
 * the same reason: a cast gets past what the type alone forbids.
 */
export function updatePrompt(
  paths: EngineStatePaths,
  projectId: string,
  id: string,
  patch: PreparedPromptPatch,
  at: Date = new Date(),
): PreparedPrompt | null {
  const forbidden = Object.keys(patch).filter((key) => !(PATCHABLE as readonly string[]).includes(key));
  if (forbidden.length > 0) {
    throw new PreparedPromptsError(
      "invalid_request",
      `A prepared prompt's ${forbidden.map((key) => `\`${key}\``).join(", ")} cannot be patched. ` +
        "`author` is provenance stamped at creation, and `id`, `projectId` and `created` are identity — " +
        `moving a prompt between projects is writing a new one. Patch only: ${PATCHABLE.join(", ")}.`,
    );
  }
  const prompts = readPrompts(paths, projectId);
  const found = prompts.find((prompt) => prompt.id === id);
  if (!found) return null;
  // A reason patched to BLANK is a removal, not an empty second line — the same
  // judgement `writeDraft` makes about an empty draft in the cockpit.
  const { reason: had, ...rest } = found;
  const reason = patch.reason === undefined ? had : assertReason(patch.reason) || undefined;
  const next = PreparedPrompt.parse({
    ...rest,
    ...(reason ? { reason } : {}),
    ...(patch.title !== undefined ? { title: assertTitle(patch.title) } : {}),
    ...(patch.text !== undefined ? { text: assertText(patch.text) } : {}),
    updated: { label: promptLabel(at), at: at.getTime() },
  });
  writePrompts(
    paths,
    projectId,
    prompts.map((prompt) => (prompt.id === id ? next : prompt)),
  );
  return next;
}

/** `false` when nothing goes by the id — deleting what is already gone is the
 *  same state stated twice, not an error worth a 404 on a retry. */
export function deletePrompt(paths: EngineStatePaths, projectId: string, id: string): boolean {
  const prompts = readPrompts(paths, projectId);
  if (!prompts.some((prompt) => prompt.id === id)) return false;
  writePrompts(
    paths,
    projectId,
    prompts.filter((prompt) => prompt.id !== id),
  );
  return true;
}

/**
 * The prompts one COMPOSER should offer: the project's own, plus the ones
 * prepared for this session and no other.
 *
 * THE FILTER IS HERE RATHER THAN IN THE CLIENT because it is a rule about the
 * data, not about pixels — the tool wall answers `prompt_list` with it too, and
 * two implementations of "which of these are mine" would drift the first time
 * one of them grew a case.
 */
export function promptsForComposer(prompts: readonly PreparedPrompt[], sessionId: string | undefined): PreparedPrompt[] {
  return prompts.filter((prompt) => prompt.sessionId === undefined || prompt.sessionId === sessionId);
}

/**
 * THERE IS NO `deleteShelf`. Unregistering a project keeps its record and is
 * restorable — "same id, same settings, same sessions" (`daemon.ts`'s DELETE) —
 * so a shelf swept away on remove would be the one thing restore could not give
 * back. The same absence, for the same reason, as the notebook's.
 */
