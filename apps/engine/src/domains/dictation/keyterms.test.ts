import { expect, test } from "bun:test";
import {
  DEEPGRAM_KEYTERM_BYTE_BUDGET,
  DEEPGRAM_KEYTERM_PROVABLE_BYTES,
  TELAR_KEYTERMS,
  deepgramKeyterms,
  type DictationContext,
} from "./keyterms";

const EMPTY: DictationContext = { sessionTitles: [], projectNames: [], branches: [] };

const context = (parts: Partial<DictationContext>): DictationContext => ({ ...EMPTY, ...parts });

const built = (input: { vocabulary?: string[]; context?: Partial<DictationContext> }): string[] =>
  deepgramKeyterms({ vocabulary: input.vocabulary ?? [], context: context(input.context ?? {}) });

const bytes = (terms: readonly string[]): number => new TextEncoder().encode(terms.join("")).length;

test("the app's own name is in there, which is the whole point of the issue", () => {
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
  const terms = built({ vocabulary: ["Kubernetes", "Wispr"], context: { sessionTitles: ["A conversation"] } });
  expect(terms.slice(0, 2)).toEqual(["Kubernetes", "Wispr"]);
});

test("and the app's own words sit second, ahead of anything read off the store", () => {
  const terms = built({ vocabulary: ["Kubernetes"], context: { sessionTitles: ["A conversation"] } });
  expect(terms.slice(0, 1 + TELAR_KEYTERMS.length)).toEqual(["Kubernetes", ...TELAR_KEYTERMS]);
});

test("the budget is the only ceiling, and short terms get far past the old forty", () => {
  const many = Array.from({ length: 400 }, (_, index) => `Term${index}`);
  const terms = built({ vocabulary: many });
  expect(terms.length).toBeGreaterThan(40);
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
  const accented = "revisión · Creatio — pgTAP §4";
  const plain = "x".repeat(accented.length);
  const withAccents = built({ vocabulary: Array.from({ length: 60 }, (_, index) => `${index}${accented}`) });
  const withPlain = built({ vocabulary: Array.from({ length: 60 }, (_, index) => `${index}${plain}`) });
  expect(withAccents.length).toBeLessThan(withPlain.length);
  expect(bytes(withAccents)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_BYTE_BUDGET);
});

test("nothing anybody can type pushes the list over Deepgram's limit", () => {
  for (const material of ["🎙️", "日本語", "é", "a", "§·—"]) {
    const terms = built({
      vocabulary: Array.from({ length: 200 }, (_, index) => `${index}${material.repeat(10)}`),
      context: { sessionTitles: Array.from({ length: 200 }, (_, index) => `t${index}${material.repeat(8)}`) },
    });
    expect(bytes(terms)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_BYTE_BUDGET);
  }
});

test("the glossary this Mac was failing on now fits, and keeps the words worth keeping", () => {
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
  expect(terms).toContain("Telar");
  expect(terms).toContain("BUG: el dictado falla el 100% de las veces en el cockpit");
});

test("a long term does not get skipped so a short one behind it can fit", () => {
  const filler = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, "0")}${"y".repeat(78)}`);
  const terms = built({ vocabulary: [...filler, "Short"] });
  expect(terms).not.toContain("Short");
  expect(terms).toEqual(filler.slice(0, terms.length));
});

test("a whole sentence is not a keyterm and is dropped without spending the budget", () => {
  const sentence = "z".repeat(200);
  const terms = built({ vocabulary: [sentence, "Kubernetes"] });
  expect(terms).not.toContain(sentence);
  expect(terms[0]).toBe("Kubernetes");
});

test("duplicates go, whatever case they were spelled in, and the first spelling wins", () => {
  const terms = built({ vocabulary: ["Deepgram", "deepgram", "DEEPGRAM"] });
  expect(terms.filter((term) => term.toLowerCase() === "deepgram")).toEqual(["Deepgram"]);
});

test("a branch and the title it was cut from are one term, not two", () => {
  const terms = built({ context: { sessionTitles: ["Dictation keyterms"], branches: ["dictation keyterms"] } });
  expect(terms.filter((term) => term.toLowerCase() === "dictation keyterms")).toHaveLength(1);
});

test("blank and whitespace-only entries are not terms, and newlines are collapsed", () => {
  const terms = built({ vocabulary: ["  ", "", "  Two   words \n here  "] });
  expect(terms).toContain("Two words here");
  expect(terms.every((term) => term.trim() === term && !term.includes("\n"))).toBe(true);
});

test("the bound is a parameter, because the shrink builds shorter lists with it (#712)", () => {
  const many = Array.from({ length: 200 }, (_, index) => `Term${String(index).padStart(3, "0")}`);
  const wide = deepgramKeyterms({ vocabulary: many, context: EMPTY, budgetBytes: 4000 });
  const narrow = deepgramKeyterms({ vocabulary: many, context: EMPTY, budgetBytes: 200 });
  expect(bytes(wide)).toBeGreaterThan(DEEPGRAM_KEYTERM_BYTE_BUDGET);
  expect(bytes(narrow)).toBeLessThanOrEqual(200);
  expect(narrow).toEqual(wide.slice(0, narrow.length));
});

test("the provable floor is below the built bound, or the shrink has no rungs", () => {
  expect(DEEPGRAM_KEYTERM_PROVABLE_BYTES).toBeLessThan(DEEPGRAM_KEYTERM_BYTE_BUDGET);
});

test("a Mac with nothing on it still sends the app's own words rather than an empty list", () => {
  expect(built({})).toHaveLength(TELAR_KEYTERMS.length);
});
