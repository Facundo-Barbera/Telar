/**
 * PRIMING THE RECOGNISER WITH THE APP'S OWN VOCABULARY (#581).
 *
 * The bug was that we sent NOTHING. The headset has always put up to forty
 * `keyterm=` parameters on its socket, built from session titles and project
 * names; the web and the phone sent model, language, formatting and endpointing
 * and stopped — so the one surface that understood the glossary was the one
 * nobody was asking about.
 *
 * What must not drift:
 *
 *   - the person's OWN terms come first, because they typed them into a box for
 *     this and a branch name must never push them off the end;
 *   - the app's own words survive a Mac with forty open conversations, which is
 *     the failure mode the obvious ordering has;
 *   - both bounds cut FROM THE TAIL, so the list is always a prefix — never a
 *     set chosen by which strings happened to be short;
 *   - deduplication is case-insensitive, because a branch and the title it was
 *     cut from collide constantly;
 *   - and the whole thing rides the token answer, so a press of the mic button
 *     is still one round trip.
 */
import { expect, test } from "bun:test";
import {
  DEEPGRAM_KEYTERM_LIMIT,
  DEEPGRAM_KEYTERM_TOKEN_BUDGET,
  TELAR_KEYTERMS,
  deepgramKeyterms,
  type DictationContext,
} from "../src/dictation/keyterms";

const EMPTY: DictationContext = { sessionTitles: [], projectNames: [], branches: [] };

const context = (parts: Partial<DictationContext>): DictationContext => ({ ...EMPTY, ...parts });

const built = (input: { vocabulary?: string[]; context?: Partial<DictationContext> }): string[] =>
  deepgramKeyterms({ vocabulary: input.vocabulary ?? [], context: context(input.context ?? {}) });

test("the app's own name is in there, which is the whole point of the issue", () => {
  // Deepgram has no reason to guess "Telar", and every one of these is a word
  // it otherwise hears as something else.
  expect(built({})).toContain("Telar");
  expect(built({})).toEqual([...TELAR_KEYTERMS]);
});

test("what this Mac is about goes on it: titles, projects, branches", () => {
  const terms = built({
    context: { sessionTitles: ["Nightly build triage"], projectNames: ["Telar Mobile"], branches: ["telar/dictation-keyterms-b781ea"] },
  });
  expect(terms).toContain("Nightly build triage");
  expect(terms).toContain("Telar Mobile");
  expect(terms).toContain("telar/dictation-keyterms-b781ea");
});

test("the person's own terms come FIRST, ahead of everything the engine found", () => {
  // THE ONE ORDERING RULE SOMEBODY ASKED FOR. A glossary typed into a box and
  // then dropped for a branch slug would be the setting not working.
  const terms = built({ vocabulary: ["Kubernetes", "Wispr"], context: { sessionTitles: ["A conversation"] } });
  expect(terms.slice(0, 2)).toEqual(["Kubernetes", "Wispr"]);
});

test("and the app's own words sit second, ahead of anything read off the store", () => {
  // A Mac with forty unsettled conversations would otherwise push "Telar" off
  // the end of its own vocabulary prompt — the issue's title, reintroduced by
  // the order it was fixed in.
  const terms = built({ vocabulary: ["Kubernetes"], context: { sessionTitles: ["A conversation"] } });
  expect(terms.slice(0, 1 + TELAR_KEYTERMS.length)).toEqual(["Kubernetes", ...TELAR_KEYTERMS]);
});

test("forty is the ceiling, and it cuts from the tail", () => {
  const many = Array.from({ length: 120 }, (_, index) => `Term${index}`);
  const terms = built({ vocabulary: many });
  expect(terms).toHaveLength(DEEPGRAM_KEYTERM_LIMIT);
  // A PREFIX, not a selection: the first forty of what was offered, in order.
  expect(terms).toEqual(many.slice(0, DEEPGRAM_KEYTERM_LIMIT));
});

test("the token budget bounds it too, since forty titles can be two thousand characters", () => {
  // Sixty characters each: the count alone would let all forty through at 2400
  // characters, which is past the budget.
  const long = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, "0")}-${"x".repeat(57)}`);
  const terms = built({ vocabulary: long });
  const spent = terms.join("").length;
  expect(spent).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_TOKEN_BUDGET * 4);
  expect(terms.length).toBeLessThan(DEEPGRAM_KEYTERM_LIMIT);
  expect(terms).toEqual(long.slice(0, terms.length));
});

test("a long term does not get skipped so a short one behind it can fit", () => {
  // The alternative — `continue` rather than `break` — makes what got sent
  // depend on lengths nobody can see, and the answer stops being a prefix.
  const filler = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, "0")}${"y".repeat(78)}`);
  const terms = built({ vocabulary: [...filler, "Short"] });
  expect(terms).not.toContain("Short");
  expect(terms).toEqual(filler.slice(0, terms.length));
});

test("a whole sentence is not a keyterm and is dropped without spending the budget", () => {
  const sentence = "z".repeat(200);
  const terms = built({ vocabulary: [sentence, "Kubernetes"] });
  expect(terms).not.toContain(sentence);
  // AND THE ONE BEHIND IT STILL LANDS: this is a filter on what a term is, not
  // a budget stop.
  expect(terms[0]).toBe("Kubernetes");
});

test("duplicates go, whatever case they were spelled in, and the first spelling wins", () => {
  const terms = built({ vocabulary: ["Deepgram", "deepgram", "DEEPGRAM"] });
  expect(terms.filter((term) => term.toLowerCase() === "deepgram")).toEqual(["Deepgram"]);
});

test("a branch and the title it was cut from are one term, not two", () => {
  // The commonest collision here by far, and the reason dedup is not an
  // optimisation.
  const terms = built({ context: { sessionTitles: ["Dictation keyterms"], branches: ["dictation keyterms"] } });
  expect(terms.filter((term) => term.toLowerCase() === "dictation keyterms")).toHaveLength(1);
});

test("blank and whitespace-only entries are not terms, and newlines are collapsed", () => {
  const terms = built({ vocabulary: ["  ", "", "  Two   words \n here  "] });
  expect(terms).toContain("Two words here");
  expect(terms.every((term) => term.trim() === term && !term.includes("\n"))).toBe(true);
});

test("a Mac with nothing on it still sends the app's own words rather than an empty list", () => {
  // `off` sends nothing because it mints nothing; a switched-on Mac with no
  // projects and no conversations still has a vocabulary.
  expect(built({})).toHaveLength(TELAR_KEYTERMS.length);
});
