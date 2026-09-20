/**
 * PRIMING THE RECOGNISER WITH THE APP'S OWN VOCABULARY (#581).
 *
 * The bug was that we sent NOTHING. The headset has always put up to forty
 * `keyterm=` parameters on its socket, built from session titles and project
 * names; the web and the phone sent model, language, formatting and endpointing
 * and stopped — so the one surface that understood the glossary was the one
 * nobody was asking about.
 *
 * THE COUNT OF FORTY IS NO LONGER A BOUND (owner, 2026-09-17): it was the
 * headset's habit, and the terms it hid were free — keyterm prompting is billed
 * per minute dictated, not per term. Deepgram's 500-token budget is what is
 * left, and it always was the real one.
 *
 * AND THAT BUDGET IS NOW CHARGED IN BYTES (#707), which is the thing these
 * tests exist for hardest. Spending it against an ESTIMATE — four characters to
 * a token — took dictation down on every press: a Spanish glossary the builder
 * called 313 tokens was refused by Deepgram with `400 Bad Request — Keyterm
 * limit exceeded`, and a browser cannot report why, so the whole feature failed
 * silently. A term's UTF-8 byte length is an upper bound on its token cost
 * rather than a guess at it, so the list can be short but never illegal.
 *
 * THE BOUND IS NOW THE MEASURED ONE AND NOT THE PROVABLE ONE (#712). 500 bytes
 * assumed the pathological one-byte-per-token case, which real words never
 * reach; the boundary was walked against the live endpoint and sits between
 * 1.70 and 2.83 bytes per token depending on the content, so the list is built
 * to 700. WHAT MAKES THAT SAFE IS NOT THESE TESTS — it is `fit.ts`, which asks
 * Deepgram and falls back to `DEEPGRAM_KEYTERM_PROVABLE_BYTES` when it cannot
 * get an answer. What these tests still hold is that the builder respects
 * whatever bound it is given, because the shrink depends on it.
 *
 * What must not drift:
 *
 *   - the person's OWN terms come first, because they typed them into a box for
 *     this and a branch name must never push them off the end;
 *   - the app's own words survive a Mac with forty open conversations, which is
 *     the failure mode the obvious ordering has;
 *   - the budget cuts FROM THE TAIL, so the list is always a prefix — never a
 *     set chosen by which strings happened to be short;
 *   - and NOTHING a person can type or title can push the list over Deepgram's
 *     limit, because being over it costs dictation entirely rather than costing
 *     a term;
 *   - deduplication is case-insensitive, because a branch and the title it was
 *     cut from collide constantly;
 *   - and the whole thing rides the token answer, so a press of the mic button
 *     is still one round trip.
 */
import { expect, test } from "bun:test";
import {
  DEEPGRAM_KEYTERM_BYTE_BUDGET,
  DEEPGRAM_KEYTERM_PROVABLE_BYTES,
  DEEPGRAM_KEYTERM_TOKEN_BUDGET,
  TELAR_KEYTERMS,
  deepgramKeyterms,
  type DictationContext,
} from "../src/dictation/keyterms";

const EMPTY: DictationContext = { sessionTitles: [], projectNames: [], branches: [] };

const context = (parts: Partial<DictationContext>): DictationContext => ({ ...EMPTY, ...parts });

const built = (input: { vocabulary?: string[]; context?: Partial<DictationContext> }): string[] =>
  deepgramKeyterms({ vocabulary: input.vocabulary ?? [], context: context(input.context ?? {}) });

/** WHAT THE LIST COSTS, in the unit the budget is charged in — see the header.
 *  A token never covers fewer than one byte, so this is the ceiling on what
 *  Deepgram will count. */
const bytes = (terms: readonly string[]): number => new TextEncoder().encode(terms.join("")).length;

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

test("the budget is the only ceiling, and short terms get far past the old forty", () => {
  // THE COUNT OF FORTY IS GONE (owner, 2026-09-17): keyterm prompting bills per
  // minute dictated rather than per term, so the terms it was hiding cost
  // nothing. Six-character terms fit the budget roughly three hundred times.
  const many = Array.from({ length: 400 }, (_, index) => `Term${index}`);
  const terms = built({ vocabulary: many });
  expect(terms.length).toBeGreaterThan(40);
  // A PREFIX, not a selection: what was offered, in order, until the budget.
  expect(terms).toEqual(many.slice(0, terms.length));
});

test("the token budget bounds it, since a few dozen titles can be two thousand characters", () => {
  const long = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, "0")}-${"x".repeat(57)}`);
  const terms = built({ vocabulary: long });
  expect(bytes(terms)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_BYTE_BUDGET);
  expect(terms.length).toBeLessThan(long.length);
  expect(terms).toEqual(long.slice(0, terms.length));
});

test("a term is charged what it weighs on the wire, not what it looks like", () => {
  // THE DEFECT THIS FILE EXISTS FOR (#707). `ó`, `·`, `—` and `§` are one
  // character each and two or three BYTES each, and a budget that counted
  // characters was undercharging every Spanish title on the list.
  const accented = "revisión · Creatio — pgTAP §4";
  const plain = "x".repeat(accented.length);
  const withAccents = built({ vocabulary: Array.from({ length: 60 }, (_, index) => `${index}${accented}`) });
  const withPlain = built({ vocabulary: Array.from({ length: 60 }, (_, index) => `${index}${plain}`) });
  // Same character count, fewer terms — because they cost more.
  expect(withAccents.length).toBeLessThan(withPlain.length);
  expect(bytes(withAccents)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_BYTE_BUDGET);
});

test("nothing anybody can type pushes the list over Deepgram's limit", () => {
  // OVER THE LIMIT IS NOT A DEGRADATION, IT IS AN OUTAGE: Deepgram refuses the
  // upgrade, and a browser's WebSocket error event carries no reason, so the
  // whole feature fails with a sentence nobody can act on. Four-byte emoji are
  // the worst case a title can hold and they are not hypothetical — people name
  // conversations with them.
  for (const material of ["🎙️", "日本語", "é", "a", "§·—"]) {
    const terms = built({
      vocabulary: Array.from({ length: 200 }, (_, index) => `${index}${material.repeat(10)}`),
      context: { sessionTitles: Array.from({ length: 200 }, (_, index) => `t${index}${material.repeat(8)}`) },
    });
    expect(bytes(terms)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_BYTE_BUDGET);
  }
});

test("the glossary this Mac was failing on now fits, and keeps the words worth keeping", () => {
  // THE REPORTED CASE, from the store the bug was filed against: 45 terms and
  // 1250 characters, which the old estimator called 313 tokens and Deepgram
  // called more than 500.
  const terms = built({
    context: {
      sessionTitles: [
        "BUG: el dictado falla el 100% de las veces en el cockpit",
        "#671 · Worktree listing + reclaim",
        "Coordinador · batch 2 (#49 — Issues, PRs y Diff)",
        "#691 · Las tarjetas deben pintar (§4)",
        "#690 · Diff miente en sesiones local (§3a)",
        "#692 · El hilo de issue/PR no se lee (§1b)",
        "Triage · PR #478 red + iOS nightly red",
        "Agent lab: comparar #529 vs #530 y decidir rumbo (#528)",
        "#974 revisión: Creatio sin ruta OData + pgTAP con datos reales",
        "NuSkills Revamp · arreglos WhatsApp 18 sep",
      ],
      projectNames: ["Telar", "ozom-gv", "NuSkills-Coach-v2", "linear-regression-from-scratch"],
      branches: ["telar/974-revision-creatio-sin-ruta-odata-pgta-f7bd33", "telar/690-diff-miente-en-sesiones-local-3a-89157c"],
    },
  });
  expect(bytes(terms)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_BYTE_BUDGET);
  // AND IT IS STILL A GLOSSARY. The app's own words survive the cut, which is
  // what the priority order is for — a bound that kept the branch slugs and
  // dropped "Telar" would be inside the budget and useless.
  expect(terms).toContain("Telar");
  expect(terms).toContain("BUG: el dictado falla el 100% de las veces en el cockpit");
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

test("the bound is a parameter, because the shrink builds shorter lists with it (#712)", () => {
  // `fit.ts` shortens a refused glossary by rebuilding it under a smaller
  // budget, and the probe that measured the boundary had to build lists ABOVE
  // it. Both need the same builder — ordering, dedup and collapsing included —
  // with only the ceiling moved.
  const many = Array.from({ length: 200 }, (_, index) => `Term${String(index).padStart(3, "0")}`);
  const wide = deepgramKeyterms({ vocabulary: many, context: EMPTY, budgetBytes: 4000 });
  const narrow = deepgramKeyterms({ vocabulary: many, context: EMPTY, budgetBytes: 200 });
  expect(bytes(wide)).toBeGreaterThan(DEEPGRAM_KEYTERM_BYTE_BUDGET);
  expect(bytes(narrow)).toBeLessThanOrEqual(200);
  // AND THE SHORTER ONE IS A PREFIX OF THE LONGER, which is what lets the
  // shrink drop the tail without reordering anything a person can see.
  expect(narrow).toEqual(wide.slice(0, narrow.length));
});

test("the provable floor is below the built bound, or the shrink has no rungs", () => {
  // If these ever met, `fit.ts` would have nothing to shrink TO and the raised
  // bound would become load-bearing — which is exactly what #707 showed a
  // measured number must never be.
  expect(DEEPGRAM_KEYTERM_PROVABLE_BYTES).toBeLessThan(DEEPGRAM_KEYTERM_BYTE_BUDGET);
  // And the floor is the token budget itself, because a token never covers
  // fewer than one byte — that identity is the proof, not a coincidence.
  expect(DEEPGRAM_KEYTERM_PROVABLE_BYTES).toBe(DEEPGRAM_KEYTERM_TOKEN_BUDGET);
});

test("a Mac with nothing on it still sends the app's own words rather than an empty list", () => {
  // `off` sends nothing because it mints nothing; a switched-on Mac with no
  // projects and no conversations still has a vocabulary.
  expect(built({})).toHaveLength(TELAR_KEYTERMS.length);
});
