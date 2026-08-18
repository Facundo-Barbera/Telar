/**
 * THREADS — the merge rule, the ply, and the two things an agent may not do.
 *
 * The load-bearing assertions here are the NEGATIVE ones. A pass that could
 * replace the thread array, settle a question, or attach to a settled one would
 * each look fine in a happy-path test and destroy the record in use — the same
 * class of defect `foldFacts` was written to prevent on memory.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  foldThreads,
  openQuestionThread,
  setThreadWaiting,
  newThreadId,
  readThreads,
  refileCapture,
  reviewThread,
  runThreadPass,
  sameQuestion,
  settleThread,
  settleThreadsForClose,
  CLOSE_CASCADE_ANSWER,
  subjectThreads,
  threadPrompt,
  threadsPath,
  plyOf,
  normalizeWaiting,
  shortHandle,
  shortNote,
  threadLabel,
  writeThreads,
  ThreadProposal,
  type ThreadChanges,
} from "../src/spool/threads";
import { closeItem, createItem, spoolPaths, writeExpertDigest, type SpoolPaths } from "../src/spool/store";
import { deriveSubjects, ensureSubject, readSubjects } from "../src/spool/subjects";
import type { SpoolExpertDigest, SpoolItem, SpoolThread } from "@telar/engine-client";

function tmpStore(): SpoolPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spool-threads-"));
  return spoolPaths(root);
}

const thread = (over: Partial<SpoolThread> = {}): SpoolThread => ({
  id: "t-1",
  subject: "ozom-gv",
  question: "Does our ad data match what the platforms say?",
  items: [],
  facts: [],
  created: "Sat 12:00",
  schemaVersion: 1,
  ...over,
});

const digestWith = (facts: SpoolExpertDigest["facts"]): SpoolExpertDigest => ({
  project: "ozom-gv",
  schemaVersion: 1,
  updated: "Sat 12:00",
  summary: "",
  methodology: "",
  glossary: [],
  facts,
});

const fact = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: `fact ${id}`,
  kind: "howItWorks" as const,
  source: { pass: "Sat 12:00" },
  ...over,
});

describe("the merge rule", () => {
  test("a pass ADDS a thread and cannot replace the array", () => {
    const stored = [thread({ id: "t-old", question: "An older question?" })];
    const next = foldThreads(stored, { create: [{ question: "A new question?", items: ["i-new"] }] }, "Sat 13:00", "ozom-gv");
    expect(next).toHaveLength(2);
    expect(next.map((t) => t.question)).toContain("An older question?");
  });

  test("a restated question does not multiply the map", () => {
    const stored = [thread({ question: "Does our ad data match?" })];
    const next = foldThreads(
      stored,
      // Different case, trailing punctuation, extra whitespace — none of which
      // a human would call a different question.
      { create: [{ question: "  does our ad DATA match  ", items: ["i-x"] }] },
      "Sat 13:00",
      "ozom-gv",
    );
    expect(next).toHaveLength(1);
  });

  test("attach folds captures into an existing thread without touching the rest", () => {
    const stored = [thread({ id: "t-1", items: ["i-a"], facts: ["f-1"] })];
    const next = foldThreads(
      stored,
      { attach: [{ threadId: "t-1", items: ["i-b"], facts: ["f-2"] }] },
      "Sat 13:00",
      "ozom-gv",
    );
    expect(next[0]!.items).toEqual(["i-a", "i-b"]);
    expect(next[0]!.facts).toEqual(["f-1", "f-2"]);
    expect(next[0]!.question).toBe(stored[0]!.question);
  });

  test("attaching the same capture twice does not double it", () => {
    const stored = [thread({ items: ["i-a"] })];
    const next = foldThreads(stored, { attach: [{ threadId: "t-1", items: ["i-a"] }] }, "Sat 13:00", "ozom-gv");
    expect(next[0]!.items).toEqual(["i-a"]);
  });

  test("A SETTLED THREAD IS NOT ATTACHED TO — new evidence is a new question", () => {
    const stored = [thread({ settled: { at: "Sat 12:30", answer: "No — Meta diverges 6.83%." }, items: ["i-a"] })];
    const next = foldThreads(stored, { attach: [{ threadId: "t-1", items: ["i-b"] }] }, "Sat 13:00", "ozom-gv");
    expect(next[0]!.items).toEqual(["i-a"]);
    expect(next[0]!.settled?.answer).toBe("No — Meta diverges 6.83%.");
  });

  test("an attach naming an unknown thread is DROPPED, never created", () => {
    const next = foldThreads([], { attach: [{ threadId: "t-hallucinated", items: ["i-a"] }] }, "Sat 13:00", "ozom-gv");
    expect(next).toHaveLength(0);
  });

  test("a capture belongs to ONE thread — the first claim wins", () => {
    const next = foldThreads(
      [],
      {
        create: [
          { question: "First question?", items: ["i-a", "i-b"] },
          { question: "Second question?", items: ["i-b", "i-c"] },
        ],
      },
      "Sat 13:00",
      "ozom-gv",
    );
    expect(next[0]!.items).toEqual(["i-a", "i-b"]);
    expect(next[1]!.items).toEqual(["i-c"]);
  });

  test("a created thread arrives MARKED as an agent's grouping", () => {
    const next = foldThreads([], { create: [{ question: "Anything?", items: ["i-a"] }] }, "Sat 13:00", "ozom-gv");
    expect(next[0]!.proposed).toBe(true);
  });

  test("an empty question is refused rather than minting a nameless thread", () => {
    expect(foldThreads([], { create: [{ question: "   " }] }, "Sat 13:00", "ozom-gv")).toHaveLength(0);
  });

  /**
   * FOUND BY RUNNING IT, not by the gate. The first live pass over `aurora`
   * turned two captures into FOUR threads, two holding no capture at all — the
   * agent's own access problems on the user's map. 7 captures became 9 threads
   * across the store, which is the multiplication §4 forbids by name.
   */
  test("A THREAD WITH NO CAPTURE IS REFUSED — the agent inventing work", () => {
    const next = foldThreads(
      [],
      {
        create: [
          { question: "What is aurora, concretely?" },
          { question: "How would I reach that tracker?", items: [] },
          { question: "A question someone actually asked?", items: ["i-a"] },
        ],
      },
      "Sat 13:00",
      "ozom-gv",
    );
    expect(next).toHaveLength(1);
    expect(next[0]!.question).toBe("A question someone actually asked?");
  });

  test("A PASS CANNOT GROW THE MAP FASTER THAN ITS EVIDENCE — compress, never multiply", () => {
    // Three captures cannot become four threads, whatever the model returns.
    const captures = ["i-a", "i-b", "i-c"];
    const next = foldThreads(
      [],
      {
        create: [
          { question: "One?", items: ["i-a"] },
          { question: "Two?", items: ["i-b"] },
          { question: "Three?", items: ["i-c"] },
          { question: "Four, from nothing?", items: [] },
        ],
      },
      "Sat 13:00",
      "ozom-gv",
    );
    expect(next.length).toBeLessThanOrEqual(captures.length);
  });

  test("`ThreadChanges` CANNOT EXPRESS A SETTLE — the type is the wall", () => {
    // If this ever compiles with `settled` on it, the moat has a hole in it.
    const changes: ThreadChanges = { create: [{ question: "Anything?" }] };
    expect(Object.keys(changes)).toEqual(["create"]);
    expect("settle" in changes).toBe(false);
  });
});

describe("sameQuestion", () => {
  test("ignores case, surrounding space and trailing punctuation", () => {
    expect(sameQuestion("Does it match?", "  does it match  ")).toBe(true);
    expect(sameQuestion("Does it match?", "Does it match!")).toBe(true);
  });
  test("does not collapse two genuinely different questions", () => {
    expect(sameQuestion("Does it match?", "Why does it not match?")).toBe(false);
  });
});

describe("the ply", () => {
  const items: SpoolItem[] = [
    { id: "i-a", title: "a", provenance: "chat", captured: "Sat", schemaVersion: 1, raw: "something I typed", openQuestions: ["q1", "q2"] },
    { id: "i-b", title: "b", provenance: "session", captured: "Sat", schemaVersion: 1 },
  ];

  test("splits facts by whether anything has checked them", () => {
    const digest = digestWith([fact("f-1", { verifiedAt: "abc" }), fact("f-2")]);
    const ply = plyOf(thread({ facts: ["f-1", "f-2"] }), digest, items);
    expect(ply).toMatchObject({ verified: 1, unchecked: 1 });
  });

  test("A RETIRED FACT COUNTS AS NEITHER — draining has to be visible", () => {
    const digest = digestWith([fact("f-1", { retired: { at: "Sat", why: "no longer true" } })]);
    const ply = plyOf(thread({ facts: ["f-1"] }), digest, items);
    expect(ply.verified + ply.unchecked).toBe(0);
  });

  test("open counts the questions across this thread's items only", () => {
    const ply = plyOf(thread({ items: ["i-a"] }), null, items);
    expect(ply.open).toBe(2);
  });

  test("captures counts YOUR words — an item with no raw draws none", () => {
    const ply = plyOf(thread({ items: ["i-a", "i-b"] }), null, items);
    expect(ply.captures).toBe(1);
  });

  test("a fact id naming nothing in the digest is ignored rather than counted", () => {
    const ply = plyOf(thread({ facts: ["f-gone"] }), digestWith([]), items);
    expect(ply.verified + ply.unchecked).toBe(0);
  });
});

describe("the human verbs", () => {
  test("settle records the ANSWER, and refuses without one", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    writeThreads(paths, "ozom-gv", [thread()]);

    expect(() => settleThread(paths, "ozom-gv", "t-1", "   ")).toThrow(/records WHAT WAS FOUND OUT/);
    const settled = settleThread(paths, "ozom-gv", "t-1", "No — Meta diverges 6.83%.");
    expect(settled?.settled?.answer).toBe("No — Meta diverges 6.83%.");
  });

  test("A SETTLED THREAD STAYS ON DISK — there is no deletion path", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    writeThreads(paths, "ozom-gv", [thread()]);
    settleThread(paths, "ozom-gv", "t-1", "It matched.");
    expect(readThreads(paths, "ozom-gv")).toHaveLength(1);
    expect(subjectThreads(paths, "ozom-gv").threads).toHaveLength(1);
  });

  test("review clears `proposed` and edits nothing else", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    writeThreads(paths, "ozom-gv", [thread({ proposed: true, items: ["i-a"] })]);
    const reviewed = reviewThread(paths, "ozom-gv", "t-1");
    expect(reviewed?.proposed).toBeUndefined();
    expect(reviewed?.question).toBe(thread().question);
    expect(reviewed?.items).toEqual(["i-a"]);
  });

  test("refile moves a capture, and `to: null` takes it off the map", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    writeThreads(paths, "ozom-gv", [
      thread({ id: "t-1", items: ["i-a"] }),
      thread({ id: "t-2", question: "Another?", items: [] }),
    ]);

    refileCapture(paths, "ozom-gv", "i-a", "t-2");
    let stored = readThreads(paths, "ozom-gv");
    expect(stored.find((t) => t.id === "t-1")!.items).toEqual([]);
    expect(stored.find((t) => t.id === "t-2")!.items).toEqual(["i-a"]);

    refileCapture(paths, "ozom-gv", "i-a", null);
    stored = readThreads(paths, "ozom-gv");
    expect(stored.every((t) => t.items.length === 0)).toBe(true);
  });
});

describe("the projection", () => {
  test("a capture no thread claims is NAMED as loose rather than hidden", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    const held = createItem(paths, { title: "held", provenance: "chat", project: "ozom-gv" });
    const alone = createItem(paths, { title: "alone", provenance: "chat", project: "ozom-gv" });
    writeThreads(paths, "ozom-gv", [thread({ items: [held.id] })]);

    const map = subjectThreads(paths, "ozom-gv");
    expect(map.threads[0]!.items.map((i) => i.id)).toEqual([held.id]);
    expect(map.loose.map((i) => i.id)).toEqual([alone.id]);
  });

  test("a capture's pin rides its brief — held and loose alike — so the map can draw the user's day", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    const held = createItem(paths, { title: "held", provenance: "chat", project: "ozom-gv", pinned: { day: "2026-08-19" } });
    const alone = createItem(paths, { title: "alone", provenance: "chat", project: "ozom-gv", pinned: { day: "2026-08-21" } });
    const bare = createItem(paths, { title: "bare", provenance: "chat", project: "ozom-gv" });
    writeThreads(paths, "ozom-gv", [thread({ items: [held.id] })]);

    const map = subjectThreads(paths, "ozom-gv");
    expect(map.threads[0]!.items.find((i) => i.id === held.id)!.pinned).toEqual({ day: "2026-08-19" });
    expect(map.loose.find((i) => i.id === alone.id)!.pinned).toEqual({ day: "2026-08-21" });
    // Absent stays ABSENT — no null, no default, nothing a renderer must guard.
    expect(map.loose.find((i) => i.id === bare.id)!.pinned).toBeUndefined();
  });

  test("another subject's items never appear on this map", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    createItem(paths, { title: "elsewhere", provenance: "chat", project: "aurora" });
    createItem(paths, { title: "floating", provenance: "chat" });
    expect(subjectThreads(paths, "ozom-gv").loose).toHaveLength(0);
  });

  test("the map carries the subject's permits so the surface needs no second read", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv", { permits: "read" });
    expect(subjectThreads(paths, "ozom-gv").permits).toBe("read");
  });

  /**
   * FOUND BY LOOKING, not by the gate: `spoolMap()` mapped over the subject
   * registry, so a floating capture appeared on NO map at all — a silent hole in
   * the surface that is now the default tab.
   *
   * These two assert the fix AND the thing the fix must not do: mint a subject
   * called "floating". `deriveSubjects` refuses to, and this keeps the map
   * honest about it from the other side.
   */
  test("a floating capture is not silently absent — it rides beside the subjects", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    createItem(paths, { title: "filed", provenance: "chat", project: "ozom-gv" });
    const adrift = createItem(paths, { title: "Call María — invoice", provenance: "chat" });

    // The per-subject projection cannot see it, which is correct — it has no
    // subject — so the WHOLE-map read is the thing that has to carry it.
    expect(subjectThreads(paths, "ozom-gv").loose.map((i) => i.id)).not.toContain(adrift.id);
  });

  test("a floating capture never becomes a subject called \"floating\"", () => {
    const paths = tmpStore();
    createItem(paths, { title: "Call María — invoice", provenance: "chat" });
    deriveSubjects(paths);
    expect(readSubjects(paths).map((s) => s.key)).not.toContain("floating");
  });
});

describe("the store", () => {
  test("a subject name the store cannot address is refused before any write", () => {
    const paths = tmpStore();
    expect(() => threadsPath(paths, "My Project")).toThrow(/plain slug/);
    expect(() => threadsPath(paths, "../escape")).toThrow(/plain slug/);
  });

  test("reading is tolerant per row — one broken thread does not cost the rest", () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    writeThreads(paths, "ozom-gv", [thread()]);
    const file = threadsPath(paths, "ozom-gv");
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify([{ nonsense: true }, ...rows]));
    expect(readThreads(paths, "ozom-gv")).toHaveLength(1);
  });

  test("a never-written file reads as no threads rather than throwing", () => {
    expect(readThreads(tmpStore(), "ozom-gv")).toEqual([]);
  });

  test("ids are minted, never derived from position", () => {
    expect(newThreadId()).not.toBe(newThreadId());
    expect(newThreadId()).toMatch(/^t-[a-f0-9]{12}$/);
  });
});

describe("the prompt", () => {
  test("leads with the failure mode it has to avoid", () => {
    const prompt = threadPrompt({ subject: "ozom-gv", digest: null, threads: [], items: [] });
    expect(prompt).toContain("one thread per capture you have achieved nothing");
  });

  test("marks a settled thread as unavailable to attach to", () => {
    const prompt = threadPrompt({
      subject: "ozom-gv",
      digest: null,
      threads: [thread({ settled: { at: "Sat", answer: "yes" } })],
      items: [],
    });
    expect(prompt).toContain("SETTLED — do not attach");
  });

  test("shows the raw capture beside the brief, never instead of it", () => {
    const prompt = threadPrompt({
      subject: "ozom-gv",
      digest: null,
      threads: [],
      items: [
        {
          id: "i-a",
          title: "paridad supermetrics vs apis",
          provenance: "chat",
          captured: "Sat",
          schemaVersion: 1,
          raw: "hay que ver si lo de supermetrics cuadra",
          fixed: "Run the parity check.",
        },
      ],
    });
    expect(prompt).toContain("hay que ver si lo de supermetrics cuadra");
    expect(prompt).toContain("Run the parity check.");
  });

  test("a retired fact is absent from the prompt but still on disk", () => {
    const digest = digestWith([fact("f-live"), fact("f-dead", { retired: { at: "Sat", why: "wrong" } })]);
    const prompt = threadPrompt({ subject: "ozom-gv", digest, threads: [], items: [] });
    expect(prompt).toContain("f-live");
    expect(prompt).not.toContain("f-dead");
  });

  test("forbids resolving today's date — the §3.2 rule the expert learned live", () => {
    const prompt = threadPrompt({ subject: "ozom-gv", digest: null, threads: [], items: [] });
    expect(prompt).toContain("Do not resolve or assert today's date");
  });

  /** Both of these were written after the live aurora pass, and each names the
   *  exact sentence that pass produced. */
  test("says whose question it has to be, with the aurora failures as the examples", () => {
    const prompt = threadPrompt({ subject: "aurora", digest: null, threads: [], items: [] });
    expect(prompt).toContain("NEVER a question YOU have about how to do your job");
    expect(prompt).toContain("YOUR access problem");
  });

  test("says out loud that returning nothing is a good answer", () => {
    const prompt = threadPrompt({ subject: "aurora", digest: null, threads: [], items: [] });
    expect(prompt).toContain("RETURNING NOTHING IS A GOOD ANSWER");
    expect(prompt).toContain("Do not fill space");
  });
});

describe("runThreadPass", () => {
  const stub = (value: unknown) => ({
    invoke: async () => ({ ok: true as const, value: value as never }),
  });

  test("refuses a subject with nothing filed to it, before spending anything", async () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    let called = false;
    const outcome = await runThreadPass(paths, { subject: "ozom-gv" }, {
      invoke: async () => {
        called = true;
        throw new Error("should not be reached");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("IDS ARE FILTERED against what exists — a hallucinated capture is dropped", async () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    const real = createItem(paths, { title: "real", provenance: "chat", project: "ozom-gv" });

    const outcome = await runThreadPass(
      paths,
      { subject: "ozom-gv" },
      stub({
        create: [{ question: "Real question?", items: [real.id, "i-invented"], facts: ["f-invented"] }],
        attach: [],
        note: "one thread",
      }),
    );

    expect(outcome.ok).toBe(true);
    const stored = readThreads(paths, "ozom-gv");
    expect(stored[0]!.items).toEqual([real.id]);
    expect(stored[0]!.facts).toEqual([]);
  });

  test("NOTHING IS WRITTEN when the model never answered", async () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    createItem(paths, { title: "real", provenance: "chat", project: "ozom-gv" });
    const outcome = await runThreadPass(paths, { subject: "ozom-gv" }, {
      invoke: async () => ({ ok: false as const, reason: "the model never answered" }),
    });
    expect(outcome.ok).toBe(false);
    expect(readThreads(paths, "ozom-gv")).toEqual([]);
  });

  test("a fact id the digest DOES hold survives the filter", async () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    const real = createItem(paths, { title: "real", provenance: "chat", project: "ozom-gv" });
    writeExpertDigest(paths, digestWith([fact("f-1")]));

    await runThreadPass(
      paths,
      { subject: "ozom-gv" },
      stub({ create: [{ question: "Q?", items: [real.id], facts: ["f-1"] }], attach: [], note: "" }),
    );
    expect(readThreads(paths, "ozom-gv")[0]!.facts).toEqual(["f-1"]);
  });

  test("a second pass over the same subject does not duplicate its questions", async () => {
    const paths = tmpStore();
    ensureSubject(paths, "ozom-gv");
    const real = createItem(paths, { title: "real", provenance: "chat", project: "ozom-gv" });
    const proposal = { create: [{ question: "Q?", items: [real.id], facts: [] }], attach: [], note: "" };

    await runThreadPass(paths, { subject: "ozom-gv" }, stub(proposal));
    await runThreadPass(paths, { subject: "ozom-gv" }, stub(proposal));
    expect(readThreads(paths, "ozom-gv")).toHaveLength(1);
  });
});

/**
 * THE HANDLE — the data half of the fix for "everything is still too textual".
 *
 * The map led with `question`, and the live pass wrote a 27-word sentence. No
 * layout is shape-first while its primary element is a paragraph, so the short
 * string has to exist as DATA and its length has to be a guarantee rather than a
 * request made of a model.
 */
describe("the handle", () => {
  test("is cut to six words, whatever the model returns", () => {
    expect(shortHandle("Supermetrics vs direct API parity check for Google and Meta")).toBe(
      "Supermetrics vs direct API parity check",
    );
  });

  test("loses trailing punctuation — it is a label, not a question", () => {
    expect(shortHandle("Does our ad data match?")).toBe("Does our ad data match");
    expect(shortHandle("September budget mismatch.")).toBe("September budget mismatch");
  });

  test("collapses whitespace so a ragged handle does not draw ragged", () => {
    expect(shortHandle("  Hito 1    readiness  ")).toBe("Hito 1 readiness");
  });

  test("a thread with no handle still draws — the map clips the question", () => {
    expect(
      threadLabel({
        question: "Which of Hito 1's 8 open items are genuinely unblocked before it closes in two weeks?",
      }),
    ).toBe("Which of Hito 1's 8 open");
  });

  test("a handle the model supplied wins over the question", () => {
    expect(threadLabel({ handle: "Hito 1 readiness", question: "Which of the 8 are unblocked?" })).toBe(
      "Hito 1 readiness",
    );
  });

  test("the fold trims it on the way in, so the store never holds a long one", () => {
    const next = foldThreads(
      [],
      { create: [{ question: "Q?", handle: "one two three four five six seven eight", items: ["i-a"] }] },
      "Sat 13:00",
      "ozom-gv",
    );
    expect(next[0]!.handle).toBe("one two three four five six");
  });

  test("the prompt asks for one and says what it is for", () => {
    const prompt = threadPrompt({ subject: "ozom-gv", digest: null, threads: [], items: [] });
    expect(prompt).toContain("EVERY THREAD NEEDS A HANDLE AS WELL AS A QUESTION");
    expect(prompt).toContain("ONLY thing shown on the morning screen");
  });
});

/**
 * THE ORPHAN THAT GOT THROUGH — found by driving a re-map, with the gate green.
 *
 * `aurora` returned two captures as three threads: the third named a capture an
 * earlier thread had already claimed, so it passed the "has at least one item"
 * check on the way in and was emptied by the dedupe two statements later. The
 * guard has to be the LAST thing that touches a thread's items.
 */
describe("the no-orphan rule survives the dedupe", () => {
  test("a thread whose only capture was already claimed is DROPPED, not left empty", () => {
    const next = foldThreads(
      [],
      {
        create: [
          { question: "First?", items: ["i-a"] },
          { question: "Second, on the same capture?", items: ["i-a"] },
        ],
      },
      "Sat 13:00",
      "aurora",
    );
    expect(next).toHaveLength(1);
    expect(next.every((t) => t.items.length > 0)).toBe(true);
  });

  test("two captures can never become three threads", () => {
    const next = foldThreads(
      [],
      {
        create: [
          { question: "One?", items: ["i-a"] },
          { question: "Two?", items: ["i-b"] },
          { question: "Three?", items: ["i-a", "i-b"] },
        ],
      },
      "Sat 13:00",
      "aurora",
    );
    expect(next.length).toBeLessThanOrEqual(2);
  });

  test("a STORED thread that lost its capture is kept — history, not invention", () => {
    // Dropping it here would be the deletion path this store does not have.
    const stored = [thread({ id: "t-old", items: [] })];
    const next = foldThreads(stored, { create: [{ question: "New?", items: ["i-a"] }] }, "Sat 13:00", "aurora");
    expect(next.map((t) => t.id)).toContain("t-old");
  });

  test("the prompt now REQUIRES a waiting mark — every open question is stuck on somebody", () => {
    expect(ThreadProposal.shape.create.element.shape.waiting.isOptional()).toBe(false);
  });
});

/**
 * THE WAITING MARK, NORMALISED — found by driving a re-map.
 *
 * A live pass returned `{kind: "person", who: "user"}`, which the brief rendered
 * as "waiting on user": nonsense, and worse, it moved the one thing only YOU can
 * do out of the category the whole surface exists to highlight.
 */
describe("the waiting mark", () => {
  test('a "person" who is really you becomes "you"', () => {
    for (const who of ["user", "the user", "you", "me", "Facundo"]) {
      expect(normalizeWaiting({ kind: "person", who })?.kind).toBe("you");
    }
  });

  test("a real third party keeps their name", () => {
    expect(normalizeWaiting({ kind: "person", who: "Ana" })).toMatchObject({ kind: "person", who: "Ana" });
  });

  test('a "person" with nobody named is you, not an anonymous someone', () => {
    expect(normalizeWaiting({ kind: "person" })?.kind).toBe("you");
  });

  test("the note is cut to a clause — the layout is a promise", () => {
    expect(
      shortNote("Needs the user to confirm whether the mirror is real, since it's currently only fixture data. Also unclear."),
    ).toBe("Needs the user to confirm whether the mirror is real");
  });

  test("a short note is left alone", () => {
    expect(shortNote("needs the live tracker")).toBe("needs the live tracker");
  });

  test("the fold normalises on the way in, so the store never holds a bad mark", () => {
    const next = foldThreads(
      [],
      { create: [{ question: "Q?", items: ["i-a"], waiting: { kind: "person", who: "user" } }] },
      "Sat 13:00",
      "aurora",
    );
    expect(next[0]!.waiting?.kind).toBe("you");
    expect(next[0]!.waiting?.who).toBeUndefined();
  });
});

/**
 * THE CONVERSATIONAL VERBS — a chat opening a question and marking who it is
 * stuck on, under exactly the laws that bind a pass. The load-bearing cases
 * are, as ever, the refusals.
 */
describe("openQuestionThread and setThreadWaiting", () => {
  const seed = (paths: SpoolPaths, title: string) =>
    createItem(paths, { title, project: "aurora", raw: title });

  test("opening goes through the fold: created, proposed, and holding its capture", () => {
    const paths = tmpStore();
    const item = seed(paths, "onboarding feels clunky");
    const thread = openQuestionThread(paths, "aurora", {
      question: "Is onboarding actually clunky?",
      handle: "Onboarding friction",
      items: [item.id],
    });
    expect(thread.items).toEqual([item.id]);
    // The provenance law: an agent's grouping arrives marked until a human looks.
    expect(thread.proposed).toBe(true);
    expect(readThreads(paths, "aurora")).toHaveLength(1);
  });

  test("no capture, no thread — an item from another subject does not count", () => {
    const paths = tmpStore();
    createItem(paths, { title: "elsewhere", project: "ozom-gv" });
    expect(() =>
      openQuestionThread(paths, "aurora", { question: "Whose question is this?", items: ["i-not-here"] }),
    ).toThrow(/at least one capture/);
  });

  test("a restated question returns the existing thread rather than multiplying", () => {
    const paths = tmpStore();
    const item = seed(paths, "first capture");
    const first = openQuestionThread(paths, "aurora", { question: "Does it work?", items: [item.id] });
    const again = openQuestionThread(paths, "aurora", { question: "  does it WORK ", items: [item.id] });
    expect(again.id).toBe(first.id);
    expect(readThreads(paths, "aurora")).toHaveLength(1);
  });

  test("waiting is normalised on the direct verb too, and a settled thread refuses it", () => {
    const paths = tmpStore();
    const item = seed(paths, "budgets");
    const thread = openQuestionThread(paths, "aurora", { question: "Do budgets match?", items: [item.id] });
    const marked = setThreadWaiting(paths, "aurora", thread.id, { kind: "person", who: "user", note: "needs a decision" });
    // "person" naming the human IS "you" — the same guarantee the fold makes.
    expect(marked?.waiting?.kind).toBe("you");

    settleThread(paths, "aurora", thread.id, "They match within rounding.");
    expect(() => setThreadWaiting(paths, "aurora", thread.id, { kind: "person", who: "Ana" })).toThrow(/settled/);
  });
});

// ── the close cascade — docs/spool-loops.md §9's "one gesture, everything over" ─

describe("settleThreadsForClose", () => {
  test("every open thread holding the capture settles with the exact answer, through settleThread's own machinery", () => {
    const paths = tmpStore();
    const item = createItem(paths, { title: "tracker", project: "ozom-gv", raw: "el tracker" });
    writeThreads(paths, "ozom-gv", [
      thread({ id: "t-hit", items: [item.id] }),
      thread({ id: "t-other", question: "A different question?", items: ["i-elsewhere"] }),
    ]);

    const at = new Date("2026-08-18T16:42:00");
    const { settled, refused } = settleThreadsForClose(paths, "ozom-gv", item.id, at);
    expect(refused).toEqual([]);
    expect(settled.map((t) => t.id)).toEqual(["t-hit"]);
    // THE WORDING IS THE CONTRACT: the honest record of what actually happened.
    expect(settled[0]!.settled).toEqual({ at: "Tue 16:42", answer: "the user closed the task" });
    expect(settled[0]!.settled!.answer).toBe(CLOSE_CASCADE_ANSWER);
    // And it landed on disk; the untouched thread stayed open.
    const stored = readThreads(paths, "ozom-gv");
    expect(stored.find((t) => t.id === "t-hit")?.settled?.answer).toBe(CLOSE_CASCADE_ANSWER);
    expect(stored.find((t) => t.id === "t-other")?.settled).toBeUndefined();
  });

  test("an already-settled thread keeps ITS answer — the cascade never overwrites what was found out", () => {
    const paths = tmpStore();
    const item = createItem(paths, { title: "x", project: "ozom-gv" });
    writeThreads(paths, "ozom-gv", [
      thread({ id: "t-done", items: [item.id], settled: { at: "Sat 12:00", answer: "Meta diverges 6.83%." } }),
    ]);
    const { settled } = settleThreadsForClose(paths, "ozom-gv", item.id);
    expect(settled).toEqual([]);
    expect(readThreads(paths, "ozom-gv")[0]!.settled!.answer).toBe("Meta diverges 6.83%.");
  });

  test("a subject with no threads file cascades to nothing, quietly", () => {
    const paths = tmpStore();
    expect(settleThreadsForClose(paths, "ozom-gv", "i-any")).toEqual({ settled: [], refused: [] });
  });
});

describe("the map under a closed item", () => {
  test("a closed capture stays on the map, marked, in thread rows and loose alike", () => {
    const paths = tmpStore();
    const inThread = createItem(paths, { title: "in a thread", project: "ozom-gv", raw: "dicho" });
    const loose = createItem(paths, { title: "loose", project: "ozom-gv" });
    writeThreads(paths, "ozom-gv", [thread({ id: "t-1", items: [inThread.id] })]);
    closeItem(paths, inThread.id);
    closeItem(paths, loose.id);

    const view = subjectThreads(paths, "ozom-gv");
    // CONSERVATION: nothing dropped. DISTINCTION: both carry the mark.
    expect(view.threads[0]!.items).toEqual([
      expect.objectContaining({ id: inThread.id, closed: true }),
    ]);
    expect(view.loose).toEqual([expect.objectContaining({ id: loose.id, closed: true })]);
  });

  test("runThreadPass does not hand closed items to the model, and refuses when only closed ones remain", async () => {
    const paths = tmpStore();
    const open = createItem(paths, { title: "still live", project: "ozom-gv", raw: "vivo" });
    const done = createItem(paths, { title: "closed one", project: "ozom-gv", raw: "cerrado" });
    closeItem(paths, done.id);

    let prompt = "";
    const outcome = await runThreadPass(paths, { subject: "ozom-gv" }, {
      invoke: async (p) => {
        prompt = p;
        return { ok: true as const, value: { create: [], attach: [], note: "looked" } as never };
      },
    });
    expect(outcome.ok).toBe(true);
    expect(prompt).toContain(open.id);
    expect(prompt).not.toContain(done.id);

    // With the live one closed too, there is nothing to map — a refusal, before
    // anything is spent.
    closeItem(paths, open.id);
    const refused = await runThreadPass(paths, { subject: "ozom-gv" }, {
      invoke: async () => {
        throw new Error("should not be reached");
      },
    });
    expect(refused.ok).toBe(false);
  });
});
