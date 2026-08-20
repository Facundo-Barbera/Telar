/**
 * THE SEARCH — one deterministic, model-free lexical search over everything
 * the Spool holds (`docs/spool-loops.md` §10.2).
 *
 * ── LEXICAL, AND HONEST ABOUT IT ────────────────────────────────────────────
 * No external embedding models for now — Telar does not support them — so this
 * is tokenized text with field weights and nothing more. Semantic search
 * waits, named, until local or provider embeddings exist; a lexical hit list
 * that exists beats a vector index that cannot run.
 *
 * ── PURE, AND NO INDEX ON DISK ──────────────────────────────────────────────
 * The store is small; the corpus is read on demand by the caller and scanned
 * here. An index would be a cache that disagrees with the store the moment
 * anything else writes, and there is nothing to amortise.
 *
 * ── DIACRITICS FOLD, BECAUSE THE STORE IS HALF SPANISH ──────────────────────
 * "facturación" and "facturacion" are the same word to the person typing.
 * Folding is NFD plus combining-mark strip, applied identically to query and
 * corpus, so the match is symmetric and the stored text is never touched.
 *
 * ── CLOSED IS INCLUDED, MARKED, AND RANKED BELOW OPEN ───────────────────────
 * A closed item, a settled thread, a retired note and an acknowledged
 * observation are all still findable — hiding them from search would be a
 * delete path wearing a filter's name. They carry `closed: true` and sort
 * after every open hit regardless of score.
 */
import type { SpoolItem, SpoolNote, SpoolObservation, SpoolSearchHit, SpoolThread } from "@telar/engine-client";

/** Lowercase, diacritics folded — the one text normalisation, applied to both
 *  sides of every comparison. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Fold, then split on anything that is not a letter or digit. Empty tokens
 *  are dropped, so punctuation-only input searches for nothing. */
export function tokenize(text: string): string[] {
  return foldText(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * The field weights, in one table: what a thing is CALLED outranks what it
 * SAYS, and an observation — a machine-composed sentence about movement —
 * ranks below both.
 */
const WEIGHT = { name: 3, body: 2, observation: 1 } as const;

type Field = { text: string; weight: number };

/** Term frequency, weighted: each query token counts once per occurrence in
 *  each field, times the field's weight. Simple on purpose — deterministic
 *  and explainable beats clever here. */
function scoreFields(queryTokens: readonly string[], fields: readonly Field[]): number {
  let score = 0;
  for (const field of fields) {
    const tokens = tokenize(field.text);
    for (const wanted of queryTokens) {
      for (const token of tokens) if (token === wanted) score += field.weight;
    }
  }
  return score;
}

/**
 * A LINE OF THE MATCHING TEXT, built word-wise so diacritic folding cannot
 * misalign an index: the original text is split into words, each word folded
 * for the match, and the snippet is the original words around the first hit.
 */
export function snippetOf(text: string, queryTokens: readonly string[], width = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= width) return oneLine;
  const words = oneLine.split(" ");
  const hit = words.findIndex((word) => {
    const folded = foldText(word);
    return queryTokens.some((token) => folded.includes(token));
  });
  if (hit < 0) return `${oneLine.slice(0, width)}…`;
  const parts: string[] = [words[hit]!];
  let before = hit - 1;
  let after = hit + 1;
  while (parts.join(" ").length < width && (before >= 0 || after < words.length)) {
    if (after < words.length) parts.push(words[after++]!);
    if (before >= 0) parts.unshift(words[before--]!);
  }
  return `${before >= 0 ? "…" : ""}${parts.join(" ")}${after < words.length ? "…" : ""}`;
}

/** Everything the caller read for one scan. Threads and observations arrive
 *  with their subject because the records themselves may not carry one the
 *  hit can quote. */
export type SearchCorpus = {
  items: readonly SpoolItem[];
  threads: readonly SpoolThread[];
  notes: readonly SpoolNote[];
  observations: readonly { subject: string; observation: SpoolObservation }[];
};

type Candidate = { hit: SpoolSearchHit; score: number; at: number };

/** A thread's display name — the handle when the pass wrote one, the question
 *  otherwise. Same fallback the map draws. */
const threadTitle = (thread: SpoolThread): string => thread.handle ?? thread.question;

/**
 * THE SCAN. Deterministic: same corpus, same query, same order. Ranking is
 * open-before-closed, then score, then recency where a stored `at` exists
 * (notes and observations carry one; items only when closed; threads carry
 * labels only, which are not comparable and are not compared).
 */
export function searchSpool(
  query: string,
  corpus: SearchCorpus,
  options: { subject?: string; limit?: number } = {},
): SpoolSearchHit[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  const subject = options.subject;
  const limit = options.limit !== undefined && options.limit > 0 ? Math.floor(options.limit) : 20;
  const candidates: Candidate[] = [];

  const consider = (
    fields: readonly Field[],
    hit: SpoolSearchHit,
    snippetSources: readonly string[],
    at: number,
  ): void => {
    const score = scoreFields(queryTokens, fields);
    if (score <= 0) return;
    const source =
      snippetSources.find((text) => tokenize(text).some((token) => queryTokens.includes(token))) ??
      snippetSources[0] ??
      hit.title;
    candidates.push({ hit: { ...hit, snippet: snippetOf(source, queryTokens) }, score, at });
  };

  for (const item of corpus.items) {
    if (subject !== undefined && item.project !== subject) continue;
    consider(
      [
        { text: item.title, weight: WEIGHT.name },
        { text: (item.tags ?? []).join(" "), weight: WEIGHT.name },
        { text: item.raw ?? "", weight: WEIGHT.body },
        { text: item.mirrored ?? "", weight: WEIGHT.body },
      ],
      {
        kind: "item",
        id: item.id,
        ...(item.project ? { subject: item.project } : {}),
        title: item.title,
        snippet: "",
        ...(item.closed ? { closed: true } : {}),
      },
      [item.raw ?? "", item.title],
      item.closed?.at ?? 0,
    );
  }

  for (const thread of corpus.threads) {
    if (subject !== undefined && thread.subject !== subject) continue;
    consider(
      [
        { text: thread.handle ?? "", weight: WEIGHT.name },
        { text: thread.question, weight: WEIGHT.body },
        { text: thread.settled?.answer ?? "", weight: WEIGHT.body },
      ],
      {
        kind: "thread",
        id: thread.id,
        subject: thread.subject,
        title: threadTitle(thread),
        snippet: "",
        ...(thread.settled ? { closed: true } : {}),
      },
      [thread.question, thread.settled?.answer ?? ""],
      0,
    );
  }

  for (const note of corpus.notes) {
    if (subject !== undefined && note.subjectKey !== subject) continue;
    consider(
      [
        { text: note.title, weight: WEIGHT.name },
        { text: note.tags.join(" "), weight: WEIGHT.name },
        { text: note.body, weight: WEIGHT.body },
      ],
      {
        kind: "note",
        id: note.id,
        ...(note.subjectKey ? { subject: note.subjectKey } : {}),
        title: note.title,
        snippet: "",
        ...(note.retired ? { closed: true } : {}),
      },
      [note.body, note.title],
      note.updated.at,
    );
  }

  for (const { subject: observationSubject, observation } of corpus.observations) {
    if (subject !== undefined && observationSubject !== subject) continue;
    consider(
      [{ text: observation.text, weight: WEIGHT.observation }],
      {
        kind: "observation",
        id: observation.id,
        subject: observationSubject,
        title: observation.text,
        snippet: "",
        ...(observation.acknowledged ? { closed: true } : {}),
      },
      [observation.text],
      observation.seenAt,
    );
  }

  candidates.sort((a, b) => {
    const aClosed = a.hit.closed === true ? 1 : 0;
    const bClosed = b.hit.closed === true ? 1 : 0;
    if (aClosed !== bClosed) return aClosed - bClosed;
    if (a.score !== b.score) return b.score - a.score;
    if (a.at !== b.at) return b.at - a.at;
    return a.hit.id.localeCompare(b.hit.id);
  });
  return candidates.slice(0, limit).map((candidate) => candidate.hit);
}
