/**
 * The search — deterministic, lexical, model-free (`docs/spool-loops.md`
 * §10.2), tested as the pure function it is.
 *
 * The properties that matter are the ones the doc promises: diacritics fold
 * both ways (the store is half Spanish), what a thing is CALLED outranks what
 * it says, closed things are INCLUDED, marked, and ranked below open ones —
 * because hiding them would be a delete path wearing a filter's name.
 */
import { describe, expect, test } from "bun:test";
import type { SpoolItem, SpoolNote, SpoolThread } from "@telar/engine-client";
import { foldText, searchSpool, snippetOf, tokenize, type SearchCorpus } from "../src/spool/search";

const item = (over: Partial<SpoolItem> & { id: string; title: string }): SpoolItem => ({
  provenance: "you",
  captured: "Tue 16:42",
  schemaVersion: 1,
  ...over,
});

const thread = (over: Partial<SpoolThread> & { id: string; subject: string; question: string }): SpoolThread => ({
  items: [],
  facts: [],
  created: "Tue 16:42",
  schemaVersion: 1,
  ...over,
});

const note = (over: Partial<SpoolNote> & { id: string; title: string; body: string }): SpoolNote => ({
  tags: [],
  created: { label: "Tue 16:42", at: 10 },
  updated: { label: "Tue 16:42", at: 10 },
  author: "you",
  schemaVersion: 1,
  ...over,
});

const empty: SearchCorpus = { items: [], threads: [], notes: [], observations: [] };

describe("tokenization and folding", () => {
  test("diacritics fold both ways — facturación finds facturacion and the reverse", () => {
    expect(foldText("Facturación")).toBe("facturacion");
    expect(tokenize("¿María, la facturación?")).toEqual(["maria", "la", "facturacion"]);

    const corpus: SearchCorpus = { ...empty, items: [item({ id: "i-1", title: "facturación de septiembre" })] };
    expect(searchSpool("facturacion", corpus).map((h) => h.id)).toEqual(["i-1"]);
    expect(searchSpool("FACTURACIÓN", corpus).map((h) => h.id)).toEqual(["i-1"]);
  });

  test("a punctuation-only query searches for nothing rather than matching everything", () => {
    const corpus: SearchCorpus = { ...empty, items: [item({ id: "i-1", title: "anything" })] };
    expect(searchSpool("¿¿ — !!", corpus)).toEqual([]);
  });
});

describe("ranking", () => {
  test("what a thing is CALLED outranks what it says: a title hit beats a body hit", () => {
    const corpus: SearchCorpus = {
      ...empty,
      items: [
        item({ id: "i-body", title: "otra cosa", raw: "revisar paridad con supermetrics" }),
        item({ id: "i-title", title: "paridad supermetrics" }),
      ],
    };
    expect(searchSpool("paridad", corpus).map((h) => h.id)).toEqual(["i-title", "i-body"]);
  });

  test("closed, settled, retired and acknowledged are INCLUDED, marked, and ranked below every open hit", () => {
    const corpus: SearchCorpus = {
      items: [
        item({ id: "i-closed", title: "paridad vieja", closed: { label: "Tue 16:42", at: 5 } }),
        item({ id: "i-open", title: "algo de paridad" }),
      ],
      threads: [
        thread({
          id: "t-settled",
          subject: "ozom-gv",
          question: "¿cuadra la paridad?",
          settled: { at: "Tue", answer: "no — Meta diverge 6.83%" },
        }),
      ],
      notes: [
        note({ id: "n-retired", title: "paridad — guía", body: "x", retired: { label: "Tue", at: 6, reason: "superseded" } }),
      ],
      observations: [],
    };
    const hits = searchSpool("paridad", corpus);
    // Every open hit first, every closed one after — regardless of score.
    // Inside the closed band the ordinary order holds: score, then the stored
    // `at`s (the retired note is newer than the closed item).
    expect(hits.map((h) => [h.id, h.closed === true])).toEqual([
      ["i-open", false],
      ["n-retired", true],
      ["i-closed", true],
      ["t-settled", true],
    ]);
  });

  test("tags match at title weight, threads answer by handle, observations rank under both", () => {
    const corpus: SearchCorpus = {
      items: [item({ id: "i-tagged", title: "cerrar factura", tags: ["facturación"] })],
      threads: [thread({ id: "t-1", subject: "ozom-gv", question: "does our ad data match?", handle: "facturación parity" })],
      notes: [],
      observations: [
        {
          subject: "ozom-gv",
          observation: { id: "o-1", text: "ana opened #12 (\"facturación\")", refs: [], seen: "Sat", seenAt: 3 },
        },
      ],
    };
    const hits = searchSpool("facturación", corpus);
    expect(hits.map((h) => h.kind).at(-1)).toBe("observation");
    expect(hits.map((h) => h.id)).toContain("i-tagged");
    expect(hits.find((h) => h.id === "t-1")!.title).toBe("facturación parity");
  });

  test("recency breaks ties from the stored `at`s — the newer note first", () => {
    const corpus: SearchCorpus = {
      ...empty,
      notes: [
        note({ id: "n-old", title: "runbook deploy", body: "a", updated: { label: "Mon", at: 1 } }),
        note({ id: "n-new", title: "runbook deploy", body: "a", updated: { label: "Tue", at: 2 } }),
      ],
    };
    expect(searchSpool("runbook", corpus).map((h) => h.id)).toEqual(["n-new", "n-old"]);
  });

  test("the subject narrows every kind, and the limit caps the list", () => {
    const corpus: SearchCorpus = {
      items: [
        item({ id: "i-in", title: "budget check", project: "ozom-gv" }),
        item({ id: "i-out", title: "budget other", project: "aurora" }),
        item({ id: "i-floating", title: "budget floating" }),
      ],
      threads: [],
      notes: [note({ id: "n-out", title: "budget note", body: "x", subjectKey: "aurora" })],
      observations: [],
    };
    expect(searchSpool("budget", corpus, { subject: "ozom-gv" }).map((h) => h.id)).toEqual(["i-in"]);
    expect(searchSpool("budget", corpus, { limit: 2 })).toHaveLength(2);
  });
});

describe("snippets", () => {
  test("short text comes back whole; long text is windowed around the first folded match", () => {
    expect(snippetOf("call maría re invoice", ["invoice"])).toBe("call maría re invoice");
    const long = `${"palabra ".repeat(40)}facturación pendiente ${"cola ".repeat(40)}`;
    const snippet = snippetOf(long, ["facturacion"]);
    expect(snippet).toContain("facturación");
    expect(snippet.length).toBeLessThan(200);
    expect(snippet.startsWith("…")).toBe(true);
  });

  test("a hit's snippet comes from the field that matched — the raw words when they did", () => {
    const corpus: SearchCorpus = {
      ...empty,
      items: [item({ id: "i-1", title: "presupuestos", raw: "ana lo preguntó el jueves" })],
    };
    expect(searchSpool("jueves", corpus)[0]!.snippet).toBe("ana lo preguntó el jueves");
  });
});
