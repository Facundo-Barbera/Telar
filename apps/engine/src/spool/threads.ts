/**
 * THREADS — the open questions a subject is actually made of.
 *
 * ── WHAT THIS FILE IS FOR ────────────────────────────────────────────────────
 * `SpoolThread`'s own header records the evidence: the expert found that two
 * captures were one investigation, wrote "Folded in a new, closely-related
 * investigation thread" into a PROSE TIMELINE EVENT, and the store kept them as
 * two rows sharing a `project` string. This file is the container that event had
 * nowhere to go into.
 *
 * ── THE MERGE RULE, AND IT IS THE SAME ONE MEMORY LEARNED ────────────────────
 * A pass may CREATE a thread and ATTACH captures to one. It may not replace the
 * array, rewrite a question, or remove anything — the exact rule `foldFacts`
 * already enforces on memory, and for the same reason: a pass that could replace
 * silently evaporates everything the current item did not happen to touch.
 *
 * `ThreadChanges` is the whole vocabulary a PROPOSAL PASS has, and `settled` is
 * not in it. That is not a convention — it is the type, and the test suite reads
 * it. The chat toolkit reaches `settleThread` separately, and that is a relay,
 * not a breach: it carries the HUMAN'S OWN ANSWER out of the conversation, the
 * answer is required exactly as it is at every other door, and a pass — which
 * decides for itself what to write — still cannot express one.
 *
 * ── NOTHING HERE COPIES A CAPTURE ────────────────────────────────────────────
 * A thread holds item IDS and fact IDS. "The raw fragment is never overwritten"
 * is a law about one record existing; two records of what you said, with no rule
 * about which is true, breaks it just as thoroughly as an overwrite would.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  SpoolThread,
  type SpoolExpertDigest,
  type SpoolItem,
  type SpoolSubjectThreads,
  type SpoolThreadView,
  type SpoolThreadWaiting,
  type SpoolThreadPly,
} from "@telar/engine-client";
import { structuredAgent, type StructuredAgentResult } from "../agent";
import { atomicWrite } from "../atomic";
import { capturedLabel, listItems, readExpertDigest, type SpoolPaths } from "./store";
import { findSubject, isAddressableKey } from "./subjects";
import { effectivePermits, readAreas } from "./areas";

const THREADS_FILE = "threads.json";

/**
 * BESIDE THE DIGEST, under the subject's own directory. Threads and facts are
 * read together on every projection — the ply resolves fact ids against the
 * digest — so splitting them across the tree would buy nothing and add a way for
 * the two to be addressed differently.
 *
 * IT ASKS `isAddressableKey` RATHER THAN RE-SPELLING THE RULE, so a subject that
 * cannot have a digest cannot have threads either, by construction.
 */
export function threadsPath(paths: SpoolPaths, subject: string): string {
  if (!isAddressableKey(subject)) {
    throw new Error(
      `"${subject}" is not a subject name this store can address on disk. A subject's threads live at ` +
        `spool/experts/<key>/threads.json, so the name has to be a plain slug — letters, digits, "_", "." or "-".`,
    );
  }
  return path.join(paths.root, "experts", subject, THREADS_FILE);
}

/**
 * TOLERANT PER ROW, like `readSubjects` and `readLanes`: one hand-edited row
 * that will not parse must not cost you every thread in the subject.
 */
export function readThreads(paths: SpoolPaths, subject: string): SpoolThread[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(threadsPath(paths, subject), "utf8"));
  } catch {
    // Never written is the ordinary state for a subject nothing has mapped yet.
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const threads: SpoolThread[] = [];
  for (const row of raw) {
    const parsed = SpoolThread.safeParse(row);
    if (!parsed.success) continue;
    if (threads.some((t) => t.id === parsed.data.id)) continue;
    threads.push(parsed.data);
  }
  return threads;
}

export function writeThreads(paths: SpoolPaths, subject: string, threads: SpoolThread[]): SpoolThread[] {
  const parsed = threads.map((t) => SpoolThread.parse(t));
  const file = threadsPath(paths, subject);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, parsed);
  return parsed;
}

/** Minted, never derived from position — the rule `SpoolItem.id` already
 *  states: an id derived from an index breaks the moment anything reorders. */
export function newThreadId(): string {
  return `t-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// ── the merge ───────────────────────────────────────────────────────────────

/**
 * EVERYTHING AN AGENT MAY SAY ABOUT THREADS. `settled` is absent by design — see
 * this file's header and `SpoolThread`'s. So is any verb that removes.
 */
export type ThreadChanges = {
  create?: Array<{
    question: string;
    /** The short form the map draws — see `SpoolThread.handle`. */
    handle?: string;
    items?: string[];
    facts?: string[];
    waiting?: SpoolThreadWaiting;
  }>;
  attach?: Array<{ threadId: string; items?: string[]; facts?: string[]; waiting?: SpoolThreadWaiting }>;
};

const union = (a: readonly string[], b: readonly string[] = []) => [...new Set([...a, ...b])];

/**
 * ADD AND ATTACH, NEVER REPLACE.
 *
 * A SETTLED THREAD IS NOT ATTACHED TO. Once you have written down the answer,
 * an overnight pass quietly folding two more captures into it would change what
 * that answer was an answer TO. A pass that wants to say more about a settled
 * question has to open a new thread, which is the honest shape: it is a new
 * question.
 *
 * AN ATTACH NAMING NO KNOWN THREAD IS DROPPED, not created under its own id. A
 * model that hallucinated a thread id would otherwise mint a thread whose
 * question nobody wrote.
 */
export function foldThreads(stored: SpoolThread[], changes: ThreadChanges, at: string, subject: string): SpoolThread[] {
  let next = stored.map((t) => ({ ...t }));

  for (const attach of changes.attach ?? []) {
    const found = next.find((t) => t.id === attach.threadId);
    if (!found || found.settled) continue;
    found.items = union(found.items, attach.items);
    found.facts = union(found.facts, attach.facts);
    if (attach.waiting) found.waiting = normalizeWaiting(attach.waiting);
  }

  for (const create of changes.create ?? []) {
    const question = create.question.trim();
    if (!question) continue;
    /**
     * NO CAPTURE, NO THREAD — and this is the law, not a tidiness rule.
     *
     * FOUND BY RUNNING IT. The first live pass over `aurora` turned two captures
     * into FOUR questions, two of which held no capture at all: "What is aurora,
     * concretely?" and "How is an aurora tracker issue actually reached today?"
     * Those are the AGENT'S access problems, not the user's open questions — and
     * a map that grows faster than its evidence is precisely what "compress,
     * never multiply" forbids ("an assistant that produces more items than it
     * resolves is a worse assistant, not a busier one").
     *
     * A thread is a container FOR captures. With none, nothing witnesses that
     * the question exists outside the model that just wrote it. The agent's own
     * ignorance belongs in the digest as a fact, where `verify` can retire it —
     * never on the human's map as work.
     */
    if ((create.items ?? []).length === 0) continue;
    // A RESTATED QUESTION IS SKIPPED, the same guard `foldFacts` applies to a
    // restated fact. Two passes reaching the same conclusion is the ordinary
    // case, and it must not multiply the map.
    if (next.some((t) => sameQuestion(t.question, question))) continue;
    next.push({
      id: newThreadId(),
      subject,
      question,
      // TRIMMED TO SIX WORDS HERE rather than trusted to the model. A handle is
      // the one field whose whole value is its length, and a prompt is a request
      // while this is a guarantee — the map's layout depends on it.
      ...(create.handle?.trim() ? { handle: shortHandle(create.handle) } : {}),
      items: union([], create.items),
      facts: union([], create.facts),
      ...(normalizeWaiting(create.waiting) ? { waiting: normalizeWaiting(create.waiting)! } : {}),
      proposed: true,
      created: at,
      schemaVersion: 1,
    });
  }

  // A capture belongs to ONE thread. Where a pass put the same item in two, the
  // FIRST wins — later threads drop it rather than the map showing one capture
  // as evidence for two different questions, which is how a reader stops
  // trusting the ply.
  const claimed = new Set<string>();
  next = next.map((t) => {
    const items = t.items.filter((id) => !claimed.has(id));
    for (const id of items) claimed.add(id);
    return { ...t, items };
  });

  /**
   * THE NO-ORPHAN RULE IS ENFORCED HERE, AFTER THE DEDUPE — and for one round it
   * was enforced above it, which was a real hole.
   *
   * FOUND BY DRIVING IT, WITH THE GATE GREEN. A re-map of `aurora` turned two
   * captures into THREE threads: the third named a capture an earlier thread had
   * already claimed, so it passed the "has at least one item" check on the way
   * in and was then emptied by the dedupe two statements later. An orphan back on
   * the user's map, through a different door.
   *
   * So the check has to be the LAST thing that happens to a thread's items,
   * because anything after it can take the last one away. A thread that never
   * had a capture and a thread that LOST its only capture are the same defect.
   *
   * STORED THREADS ARE EXEMPT. One that predates this rule, or whose capture a
   * human re-filed away, is history rather than an agent inventing work — and
   * dropping it here would be the deletion path this store does not have.
   */
  const arrived = new Set(next.slice(stored.length).map((t) => t.id));
  return next.filter((t) => !arrived.has(t.id) || t.items.length > 0);
}

/**
 * SIX WORDS, ENFORCED — the map's layout is a promise and a prompt is a request.
 *
 * Trailing punctuation goes too: a handle is a LABEL, not a sentence, and
 * "Supermetrics parity?" on a card reads as a question the card is asking you.
 */
export function shortHandle(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .slice(0, 6)
    .join(" ")
    .replace(/[?.,:;!\s]+$/, "");
}

/**
 * WHAT THE MAP DRAWS FOR A THREAD, handle or fallback.
 *
 * A thread written before `handle` existed still has to draw, and a clipped
 * question is a worse label than a real handle but a far better one than a
 * paragraph. Shared so the surface and the tests agree by construction.
 */
export function threadLabel(thread: Pick<SpoolThread, "handle" | "question">): string {
  return thread.handle?.trim() ? thread.handle : shortHandle(thread.question);
}

/**
 * WORDS THAT MEAN "THE HUMAN READING THIS", not a third party.
 *
 * FOUND BY DRIVING IT. A live re-map returned `{kind: "person", who: "user"}`,
 * which the brief rendered as "waiting on user" — nonsense, and worse, it moved
 * the one thing only YOU can do out of the category the whole surface is built
 * to highlight. The model is not wrong about the fact; it is wrong about which
 * bucket, and a prompt is a request while this is a guarantee.
 */
const MEANS_YOU = /^(the )?(user|you|me|myself|human|owner|facundo)$/i;

/**
 * NORMALISE THE MARK, because the brief's whole value is the distinction.
 *
 * `person` with a name that means you IS `you`. And the note is trimmed to a
 * clause: the field's own description asks for "needs the live tracker" and a
 * live pass returned a two-line paragraph, which on the morning screen is the
 * text density complaint arriving through the last unguarded door.
 */
export function normalizeWaiting(waiting: SpoolThreadWaiting | undefined): SpoolThreadWaiting | undefined {
  if (!waiting) return undefined;
  const note = waiting.note?.trim() ? shortNote(waiting.note) : undefined;
  if (waiting.kind === "person" && (!waiting.who?.trim() || MEANS_YOU.test(waiting.who.trim()))) {
    return { kind: "you", ...(note ? { note } : {}) };
  }
  return {
    kind: waiting.kind,
    ...(waiting.who?.trim() ? { who: waiting.who.trim() } : {}),
    ...(note ? { note } : {}),
  };
}

/** A clause, not a paragraph. Cut at the first sentence end, then to twelve
 *  words — the same reasoning as `shortHandle`: the layout is a promise. */
export function shortNote(raw: string): string {
  // A CLAUSE ENDS AT THE FIRST BREAK, comma included: a live pass returned two
  // lines where the field asks for "needs the live tracker", and the leading
  // clause is almost always the whole point.
  const first = raw.trim().replace(/\s+/g, " ").split(/[.;,]/)[0] ?? "";
  return first.split(" ").slice(0, 12).join(" ").replace(/[,;:\s]+$/, "").replace(/\.$/, "");
}

/** Same rule `sameText` uses on facts: whitespace and case are not a difference
 *  a human would call a different question. */
export function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "");
  return norm(a) === norm(b);
}

// ── the human verbs ─────────────────────────────────────────────────────────

/**
 * THE EXIT THE STORE NEVER HAD, and the only writer of `settled`.
 *
 * AN ANSWER IS REQUIRED. A settle with an empty answer would be a status flip
 * wearing this field's name, which is the one thing `SpoolThread`'s header
 * promises this is not — so it is refused here rather than trusted to callers.
 */
export function settleThread(
  paths: SpoolPaths,
  subject: string,
  threadId: string,
  answer: string,
  at: Date = new Date(),
): SpoolThread | null {
  const trimmed = answer.trim();
  if (!trimmed) {
    throw new Error(
      "Settling a thread records WHAT WAS FOUND OUT. A settle with no answer is a status flip, which this record " +
        "deliberately cannot express — write the answer, or leave the thread open.",
    );
  }
  const threads = readThreads(paths, subject);
  const found = threads.find((t) => t.id === threadId);
  if (!found) return null;
  const next: SpoolThread = { ...found, settled: { at: capturedLabel(at), answer: trimmed } };
  writeThreads(
    paths,
    subject,
    threads.map((t) => (t.id === threadId ? next : t)),
  );
  return next;
}

/**
 * THE ANSWER THE CLOSE CASCADE RECORDS, verbatim — one string, exported so the
 * cascade and its tests cannot drift about the wording. It is an honest answer,
 * not a status flip: a human closing a task HAS answered every question the
 * system had about it, and this is how ("bureaucracy after a checkbox is how
 * trackers die", docs/spool-loops.md §9).
 */
export const CLOSE_CASCADE_ANSWER = "the user closed the task";

/**
 * ONE GESTURE, EVERYTHING OVER — the close cascade (docs/spool-loops.md §9).
 *
 * When the user closes an item, every OPEN thread holding that capture settles
 * through `settleThread` itself — the same machinery, the same laws, the same
 * single writer of `settled` — with `CLOSE_CASCADE_ANSWER` as the answer. The
 * attribution is the human's: the cascade runs only from the human close verb,
 * relaying their click exactly as the chat toolkit relays their spoken settle.
 *
 * A THREAD THAT REFUSES IS RECORDED, NOT THROWN OVER. The close itself has
 * already landed on the item; discarding it because one thread row would not
 * take the settle would un-do the user's own act over bookkeeping. So each
 * refusal comes back beside the settles, honestly, for the surface to say.
 *
 * ALREADY-SETTLED THREADS ARE LEFT ALONE — their answer is a record, and this
 * cascade must never overwrite what was actually found out with a close note.
 */
export function settleThreadsForClose(
  paths: SpoolPaths,
  subject: string,
  itemId: string,
  at: Date = new Date(),
): { settled: SpoolThread[]; refused: Array<{ threadId: string; reason: string }> } {
  const settled: SpoolThread[] = [];
  const refused: Array<{ threadId: string; reason: string }> = [];
  for (const thread of readThreads(paths, subject)) {
    if (thread.settled) continue;
    if (!thread.items.includes(itemId)) continue;
    try {
      const done = settleThread(paths, subject, thread.id, CLOSE_CASCADE_ANSWER, at);
      if (done) settled.push(done);
      else refused.push({ threadId: thread.id, reason: "the thread could not be re-read at settle time" });
    } catch (error) {
      refused.push({ threadId: thread.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { settled, refused };
}

/**
 * SETTLE MANY, EACH WITH ITS OWN ANSWER — the selection model's settle, and a
 * composition of `settleThread` exactly as the close cascade is: the same
 * machinery, the same single writer of `settled`, once per row.
 *
 * EVERY ANSWER IS STILL REQUIRED — there is no "settle all" that flips a
 * column of questions to done, because that would be the status flip this
 * record cannot express, performed in bulk. A row with no answer, an unknown
 * thread id, or an already-settled thread REFUSES THAT ROW with its sentence
 * and the rest land; a batch thrown away over one row would punish the user
 * for the store's own bookkeeping.
 */
export function settleThreadsMany(
  paths: SpoolPaths,
  subject: string,
  settles: ReadonlyArray<{ threadId: string; answer: string }>,
  at: Date = new Date(),
): { settled: SpoolThread[]; refused: Array<{ threadId: string; reason: string }> } {
  const settled: SpoolThread[] = [];
  const refused: Array<{ threadId: string; reason: string }> = [];
  for (const { threadId, answer } of settles) {
    const existing = readThreads(paths, subject).find((t) => t.id === threadId);
    if (existing?.settled) {
      // The cascade leaves settled threads alone; here the caller NAMED one, so
      // the honest answer names what it already holds rather than overwriting a
      // record with a second answer.
      refused.push({ threadId, reason: `already settled: "${existing.settled.answer}"` });
      continue;
    }
    try {
      const done = settleThread(paths, subject, threadId, answer, at);
      if (done) settled.push(done);
      else refused.push({ threadId, reason: `no thread goes by "${threadId}" on "${subject}"` });
    } catch (error) {
      refused.push({ threadId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { settled, refused };
}

/**
 * OPEN ONE QUESTION, deliberately — the conversational sibling of a mapping
 * pass, and it goes through `foldThreads` so every law that binds a pass binds
 * this too: no capture, no thread (the item ids are required and verified); a
 * restated question attaches rather than multiplying; a capture belongs to one
 * thread; the grouping arrives marked `proposed` until a human looks. Opening
 * is the ONLY grower in the conversational vocabulary, and it can only grow
 * around evidence that already exists — it cannot mint a top-level item.
 *
 * WHEN THE QUESTION ALREADY EXISTS, the existing thread comes back rather than
 * a refusal: the caller's intent — "this question is on the map" — is
 * satisfied, and telling a model "no" for agreeing with the map would only
 * teach it to rephrase until the dedupe stops recognising the duplicate.
 */
export function openQuestionThread(
  paths: SpoolPaths,
  subject: string,
  input: { question: string; handle?: string; items: string[]; waiting?: SpoolThreadWaiting },
  at: Date = new Date(),
): SpoolThread {
  const question = input.question.trim();
  if (!question) throw new Error("A thread is named by its question — write the thing that is not known.");
  const inSubject = new Set(
    listItems(paths)
      .items.filter((i) => i.project === subject)
      .map((i) => i.id),
  );
  const items = input.items.filter((id) => inSubject.has(id));
  if (items.length === 0) {
    throw new Error(
      `A question needs at least one capture filed to "${subject}" as its evidence — a thread with none would put ` +
        `the asker's own question on the user's map. File or name a capture first.`,
    );
  }

  const stored = readThreads(paths, subject);
  const existing = stored.find((t) => sameQuestion(t.question, question));
  if (existing) return existing;

  const next = foldThreads(
    stored,
    {
      create: [
        {
          question,
          ...(input.handle?.trim() ? { handle: input.handle } : {}),
          items,
          ...(input.waiting ? { waiting: input.waiting } : {}),
        },
      ],
    },
    capturedLabel(at),
    subject,
  );
  writeThreads(paths, subject, next);
  const created = next.find((t) => sameQuestion(t.question, question));
  if (!created) {
    // Every path that drops the create names a reason above; reaching here
    // means the fold's own rules (a capture already claimed, say) removed it.
    throw new Error(
      `The question was not opened: every capture named is already evidence for another thread. Attach to that ` +
        `thread instead — one capture is never evidence for two questions.`,
    );
  }
  return created;
}

/**
 * WHO A THREAD IS STUCK ON, set directly — the mark `foldThreads` lets a pass
 * write, reachable without paying for a pass. Normalised by the same rule
 * (`person` naming the human IS `you`; the note trims to a clause), refused on
 * a settled thread for the reason attach is: an answered question is not stuck
 * on anyone, and marking it would un-answer it in every reader's eyes.
 */
export function setThreadWaiting(
  paths: SpoolPaths,
  subject: string,
  threadId: string,
  waiting: SpoolThreadWaiting,
): SpoolThread | null {
  const threads = readThreads(paths, subject);
  const found = threads.find((t) => t.id === threadId);
  if (!found) return null;
  if (found.settled) {
    throw new Error(
      "This thread is settled — its question has an answer, so it is not waiting on anyone. New evidence about it " +
        "is a new question: open one.",
    );
  }
  const normalized = normalizeWaiting(waiting);
  if (!normalized) throw new Error("Say who this is stuck on: you, the agent, or a named person.");
  const next: SpoolThread = { ...found, waiting: normalized };
  writeThreads(
    paths,
    subject,
    threads.map((t) => (t.id === threadId ? next : t)),
  );
  return next;
}

/**
 * A HUMAN LOOKED AT THE GROUPING. Clears `proposed`, and nothing else — the
 * provenance law's whole content is that an agent's artifact is marked until
 * someone has seen it, so the verb that unmarks it may not also edit it.
 */
export function reviewThread(paths: SpoolPaths, subject: string, threadId: string): SpoolThread | null {
  const threads = readThreads(paths, subject);
  const found = threads.find((t) => t.id === threadId);
  if (!found) return null;
  const { proposed: _dropped, ...rest } = found;
  const next = rest as SpoolThread;
  writeThreads(
    paths,
    subject,
    threads.map((t) => (t.id === threadId ? next : t)),
  );
  return next;
}

/**
 * MOVE A CAPTURE. The mitigation `SpoolThread.proposed` names: a wrong grouping
 * is the documented way problem-oriented records fail, so re-filing has to be
 * one gesture rather than an edit of two records.
 *
 * `to: null` DETACHES — the capture goes back to `loose`, which is a resting
 * state the map draws rather than a hole.
 */
export function refileCapture(
  paths: SpoolPaths,
  subject: string,
  itemId: string,
  to: string | null,
): SpoolThread[] {
  const threads = readThreads(paths, subject).map((t) => ({
    ...t,
    items: t.items.filter((id) => id !== itemId),
  }));
  const target = to ? threads.find((t) => t.id === to) : undefined;
  if (to && !target) return readThreads(paths, subject);
  if (target) target.items = union(target.items, [itemId]);
  return writeThreads(paths, subject, threads);
}

// ── the projection ──────────────────────────────────────────────────────────

/**
 * THE MARK, COMPUTED — never stored, per `SpoolThreadPly`.
 *
 * A RETIRED FACT COUNTS AS NEITHER. "Dismissing drains" keeps it on disk and out
 * of the prompt; a drained fact still thickening the ply would make the
 * retraction verb visibly do nothing, which is the same defect as a button that
 * opens a panel `display: none` can never show.
 */
export function plyOf(
  thread: SpoolThread,
  digest: SpoolExpertDigest | null,
  items: readonly SpoolItem[],
): SpoolThreadPly {
  const byId = new Map((digest?.facts ?? []).map((f) => [f.id, f]));
  let verified = 0;
  let unchecked = 0;
  for (const id of thread.facts) {
    const fact = byId.get(id);
    if (!fact || fact.retired) continue;
    if (fact.verifiedAt) verified += 1;
    else unchecked += 1;
  }

  const mine = items.filter((i) => thread.items.includes(i.id));
  const open = mine.reduce((n, i) => n + (i.openQuestions?.length ?? 0), 0);
  // YOUR OWN WORDS, and only those. An item seeded by a session with no `raw`
  // is a real item and not something you said, so it draws no capture tick —
  // the mark would otherwise claim provenance the packet does not have.
  const captures = mine.filter((i) => (i.raw ?? "").trim().length > 0).length;

  return { verified, unchecked, open, captures };
}

/**
 * ONE SUBJECT'S MAP, IN ONE READ — the rule `SpoolSnapshot` states, applied
 * here: threads, plies and loose captures are three views of the same items and
 * the same digest, and a client that fetched them separately could draw a map
 * whose ply disagrees with its own rows.
 *
 * SETTLED THREADS ARE INCLUDED. They are the record of what you worked out, and
 * the surface dims them rather than the store hiding them.
 */
export function subjectThreads(paths: SpoolPaths, subject: string): SpoolSubjectThreads {
  const threads = readThreads(paths, subject);
  const digest = readExpertDigest(paths, subject);
  const all = listItems(paths).items.filter((i) => i.project === subject);
  /**
   * YOUR WORDS RIDE WITH THE CAPTURE. Trimmed to a line, because the map draws
   * it inline as the thing that makes every derived sentence legible — see
   * `SpoolCaptureBrief.said`. Absent when the item has no raw, and the surface
   * then says nothing rather than inventing a source.
   */
  const brief = (i: SpoolItem) => {
    const said = (i.raw ?? "").trim().replace(/\s+/g, " ");
    return {
      id: i.id,
      title: i.title,
      ...(said ? { said: said.length > 160 ? `${said.slice(0, 160)}…` : said } : {}),
      // The user's own day rides with the capture, so the map can draw the pin
      // chip the desk and the queue already draw — quoted, never compared.
      ...(i.pinned ? { pinned: i.pinned } : {}),
      // The user's own close rides too — the map DIMS a closed capture the way
      // it dims a settled thread, and never drops it: hiding it would be a
      // delete path, and a map you cannot trust to be complete.
      ...(i.closed ? { closed: true } : {}),
    };
  };

  const views: SpoolThreadView[] = threads.map((thread) => ({
    thread,
    ply: plyOf(thread, digest, all),
    items: all.filter((i) => thread.items.includes(i.id)).map(brief),
  }));

  const claimed = new Set(threads.flatMap((t) => t.items));
  return {
    subject,
    // THE EFFECTIVE LEVEL, not the stated one: the map is what the master chat
    // and the room read to say what may happen here unattended, and a subject
    // in a ceilinged area reporting its own higher permit would be the display
    // promising what the night refuses. The stated level stays readable on the
    // subject record itself.
    permits: effectivePermits(findSubject(paths, subject), readAreas(paths)),
    threads: views,
    loose: all.filter((i) => !claimed.has(i.id)).map(brief),
  };
}

// ── the proposal pass ───────────────────────────────────────────────────────

/**
 * WHAT A PASS MAY RETURN. Mirrors `ThreadChanges` exactly, because the schema IS
 * the wall — `agent.ts` forces the model through `emit_result` with this shape,
 * so "an agent cannot settle a thread" is enforced by the tool's input schema
 * rather than by a check someone has to remember to write.
 */
export const ThreadProposal = z.object({
  create: z
    .array(
      z.object({
        question: z
          .string()
          .describe(
            "The thing that is NOT KNOWN, phrased as a question a person would ask out loud. " +
              "NOT a task, not an imperative, not a restatement of the capture's title. " +
              'Good: "Does what we report from Supermetrics match what the ad platforms actually say?" ' +
              'Bad: "Run the Supermetrics parity check."',
          ),
        handle: z
          .string()
          .describe(
            "THE SAME THING IN THREE TO SIX WORDS — a label, not a sentence. This is the ONLY string " +
              "shown on the map; the question is read after opening. No question mark, no full stop, no " +
              'verb if you can avoid one. Think of a folder name or a whiteboard heading. ' +
              'Good: "Supermetrics parity" · "Hito 1 readiness" · "September budget mismatch". ' +
              'Bad: "Does our data match?" (a sentence) · "Parity" (too vague to tell apart) · ' +
              '"Supermetrics vs direct API parity check for Google and Meta" (that is the question again).',
          ),
        items: z
          .array(z.string())
          .describe(
            "Capture ids that are evidence for THIS question. AT LEAST ONE IS REQUIRED — a thread with no " +
              "capture is rejected, because nothing witnesses that the question exists outside you. Two " +
              "captures that are two angles on one question belong in ONE thread — that is the entire point " +
              "of this record. Use only ids you were given; never invent one.",
          ),
        facts: z
          .array(z.string())
          .describe("Ids of memory facts that bear on this question. Only ids from the list you were given."),
        waiting: z
          .object({
            kind: z.enum(["you", "agent", "person"]),
            who: z.string().optional().describe('For "person" only: the name the capture already contained.'),
            note: z.string().optional().describe('What it is stuck on, one short clause: "needs the live tracker".'),
          })
          .describe(
            'REQUIRED. Who cannot move until someone acts — every open question is stuck on somebody, and ' +
              'this is the single most useful thing the morning screen shows. "you" = only the human can ' +
              'unblock it (a decision, an access token, an answer only they have). "agent" = an unattended ' +
              'pass could make progress right now. "person" = a third party owes something; name them in ' +
              '`who` using the name the capture already contained. `note` is one short clause naming what ' +
              'it is stuck on — "needs the live tracker", "needs the Vault token".',
          ),
      }),
    )
    .describe("New questions. Prefer attaching to an existing thread over creating a near-duplicate."),
  attach: z
    .array(
      z.object({
        threadId: z.string().describe("An id from the EXISTING THREADS list. Never a new one."),
        items: z.array(z.string()),
        facts: z.array(z.string()),
      }),
    )
    .describe("Captures and facts that belong to a question already on the map."),
  note: z.string().describe("One sentence on what you concluded, for the pass timeline."),
});
export type ThreadProposal = z.infer<typeof ThreadProposal>;

/**
 * THE PROMPT — and the hard part is stated first, because it is the only thing
 * that decides whether this record is worth having.
 *
 * A PASS THAT RETURNS ONE THREAD PER CAPTURE HAS DONE NOTHING. It has renamed
 * the queue. The instruction to look for the shared question is therefore the
 * opening line rather than a caveat at the bottom, and the failure mode is named
 * so the model can recognise itself doing it.
 */
export function threadPrompt(input: {
  subject: string;
  digest: SpoolExpertDigest | null;
  threads: readonly SpoolThread[];
  items: readonly SpoolItem[];
}): string {
  const { subject, digest, threads, items } = input;

  const captures = items
    .map((i) => {
      const lines = [`  id: ${i.id}`, `  title: ${i.title}`];
      if (i.raw?.trim()) lines.push(`  what they actually said: ${i.raw.trim()}`);
      if (i.fixed?.trim()) lines.push(`  the brief: ${i.fixed.trim()}`);
      if (i.openQuestions?.length) lines.push(`  still unanswered: ${i.openQuestions.join(" | ")}`);
      if (i.commitments?.length)
        lines.push(`  promised: ${i.commitments.map((c) => `${c.what} (${c.when})`).join(" | ")}`);
      return lines.join("\n");
    })
    .join("\n\n");

  const facts = (digest?.facts ?? [])
    .filter((f) => !f.retired)
    .map((f) => `  ${f.id} [${f.kind}] ${f.text}`)
    .join("\n");

  const existing = threads.length
    ? threads
        .map(
          (t) =>
            `  ${t.id}${t.settled ? " (SETTLED — do not attach)" : ""}: [${threadLabel(t)}] ${t.question}`,
        )
        .join("\n")
    : "  (none yet — this is the first pass over this subject)";

  return [
    `You are mapping the subject "${subject}" into the OPEN QUESTIONS it is actually made of.`,
    "",
    "THE ONE THING THAT MAKES THIS WORTH DOING",
    "Several captures are usually the same question seen from different angles. Finding that is the",
    "whole job. If you return one thread per capture you have achieved nothing — you have renamed a",
    "list. Before you create anything, read every capture and ask: which of these are the same person",
    "worrying about the same unknown on two different days?",
    "",
    "WHAT A THREAD IS",
    "A live line of inquiry, named by what is NOT KNOWN. It is a question, not a task. The work that",
    "would answer it is downstream and is not your concern here.",
    "",
    "  · A question survives its captures. \"Does our reported data match reality?\" outlives the three",
    "    times someone noticed it might not.",
    "  · If you cannot phrase it as a question, it is probably a task and belongs INSIDE a thread as",
    "    one of its captures — not as a thread of its own.",
    "  · Name it only as precisely as the evidence supports. If two captures might be one question but",
    "    you cannot tell, make two threads and say so in the note. A wrong grouping hides a capture,",
    "    which is worse than a map that is too fine.",
    "",
    "WHOSE QUESTION IT HAS TO BE — READ THIS TWICE",
    "A thread is a question THE USER HAS, and at least one capture below is the evidence they have it.",
    "It is NEVER a question YOU have about how to do your job.",
    "",
    "  · \"What is this subject, concretely?\" — YOUR ignorance. Not a thread.",
    "  · \"How would I reach that tracker — a URL, a login, a token?\" — YOUR access problem. Not a thread.",
    "  · \"Should there be a process for handling these?\" — work YOU invented. Nobody asked for it.",
    "",
    "Every one of those is a real thing to write down, and the place for it is a memory fact, not the",
    "user's map. Putting your own blockers on their map is how a map stops being worth opening.",
    "",
    "EVERY THREAD MUST HOLD AT LEAST ONE CAPTURE, and it is rejected otherwise. If you find yourself",
    "writing a question with no capture attached, that is the signal it is your question and not theirs.",
    "",
    "EVERY THREAD NEEDS A HANDLE AS WELL AS A QUESTION",
    "The handle is three to six words and it is the ONLY thing shown on the morning screen — the",
    "question is read after opening. Someone arriving with no context sees a column of handles and has",
    "to be able to tell them apart at a glance. \"Supermetrics parity\", \"Hito 1 readiness\",",
    "\"September budget mismatch\". Not a sentence, not a question, and not one word so vague that two",
    "threads on this subject would get the same one.",
    "",
    "RETURNING NOTHING IS A GOOD ANSWER",
    "If the captures here are too thin to tell what the real questions are — or if you have no useful",
    "knowledge of this subject — return empty lists and say so in the note. An empty map is honest and",
    "costs nothing. A map padded with plausible questions is worse than no map, because the user cannot",
    "tell your guesses from their own concerns. Do not fill space.",
    "",
    "WHAT YOU MAY NOT DO",
    "  · Do not invent a capture id or a fact id. Use only what is listed below.",
    "  · Do not attach to a thread marked SETTLED. That question has an answer; new evidence about it",
    "    is a NEW question.",
    "  · Do not decide anything is finished, done, accepted or resolved. You cannot express that here",
    "    and you should not try to in prose either.",
    "  · Do not resolve or assert today's date. Quote a date only if a capture or a file states it,",
    "    with its source.",
    "",
    `EXISTING THREADS on this subject:`,
    existing,
    "",
    "MEMORY FACTS available to cite (id, kind, text):",
    facts || "  (none)",
    "",
    "CAPTURES filed to this subject:",
    "",
    captures || "  (none)",
    "",
    digest?.summary?.trim() ? `WHAT YOU ALREADY KNOW ABOUT ${subject}:\n${digest.summary.trim()}` : "",
    "",
    "Return the threads to create and the attachments to make. Prefer attaching over creating a",
    "near-duplicate of a question already on the map.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export type ThreadPassRequest = {
  subject: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  binaryPath?: string;
  abort?: AbortController;
  onStep?: (step: { n: number; label: string }) => void;
};

export type ThreadPassOutcome =
  | { ok: true; threads: SpoolThread[]; created: number; attached: number; note: string; usage?: unknown }
  | { ok: false; reason: string };

/** The dispatch seam — a stub drives every branch without a subprocess, the
 *  shape `ExpertDeps` already established. */
export type ThreadDeps = {
  invoke: (prompt: string, req: ThreadPassRequest) => Promise<StructuredAgentResult<ThreadProposal>>;
};

const liveInvoke: ThreadDeps["invoke"] = (prompt, req) =>
  structuredAgent(prompt, {
    schema: ThreadProposal,
    label: `threads:${req.subject}`,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    ...(req.env ? { env: req.env } : {}),
    ...(req.binaryPath ? { binaryPath: req.binaryPath } : {}),
    ...(req.abort ? { abort: req.abort } : {}),
    ...(req.onStep ? { onStep: req.onStep } : {}),
  });

/**
 * ONE CALL, ONE PASS. Returns a reason rather than throwing for everything a
 * caller can act on, exactly as `runExpertPass` does.
 *
 * NOTHING IS WRITTEN ON FAILURE. A half-written map is worse than none: the next
 * pass would start from a grouping no model finished making.
 */
export async function runThreadPass(
  paths: SpoolPaths,
  req: ThreadPassRequest,
  deps: ThreadDeps = { invoke: liveInvoke },
  at: Date = new Date(),
): Promise<ThreadPassOutcome> {
  try {
    threadsPath(paths, req.subject);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  // CLOSED ITEMS ARE NOT HANDED TO THE PASS. The user closed them, so no model
  // should be proposing new questions around them — and because `known` below
  // derives from this list, a proposal naming a closed capture is filtered out
  // the same way one naming a foreign capture is. The captures themselves stay
  // on the map (`subjectThreads` carries them, dimmed); only the PROPOSING
  // stops.
  const items = listItems(paths).items.filter((i) => i.project === req.subject && !i.closed);
  if (items.length === 0) {
    // A REFUSAL, NOT A FAILURE — the same first-class outcome the night reports.
    return { ok: false, reason: `Nothing is filed to "${req.subject}", so there is nothing to map.` };
  }

  const stored = readThreads(paths, req.subject);
  const digest = readExpertDigest(paths, req.subject);
  const prompt = threadPrompt({ subject: req.subject, digest, threads: stored, items });

  const result = await deps.invoke(prompt, req);
  if (!result.ok) return { ok: false, reason: result.reason };

  // IDS ARE FILTERED AGAINST WHAT EXISTS before anything is written. A model
  // naming an item that is not in this subject would otherwise put a capture on
  // a map it does not belong to, and the ply would count evidence twice.
  const known = new Set(items.map((i) => i.id));
  const knownFacts = new Set((digest?.facts ?? []).map((f) => f.id));
  const keep = (ids: string[] = []) => ids.filter((id) => known.has(id));
  const keepFacts = (ids: string[] = []) => ids.filter((id) => knownFacts.has(id));

  const changes: ThreadChanges = {
    create: result.value.create.map((c) => ({
      question: c.question,
      ...(c.handle ? { handle: c.handle } : {}),
      items: keep(c.items),
      facts: keepFacts(c.facts),
      ...(c.waiting ? { waiting: c.waiting } : {}),
    })),
    attach: result.value.attach.map((a) => ({
      threadId: a.threadId,
      items: keep(a.items),
      facts: keepFacts(a.facts),
    })),
  };

  const next = foldThreads(stored, changes, capturedLabel(at), req.subject);
  writeThreads(paths, req.subject, next);

  return {
    ok: true,
    threads: next,
    created: next.length - stored.length,
    attached: changes.attach?.length ?? 0,
    note: result.value.note,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
