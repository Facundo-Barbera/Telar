/**
 * FOCUS — the record that says what you are ON, and the pickup computed from it.
 *
 * The assertions that matter most are the ones about HONESTY: a correction that
 * keeps the old value, a proposal that only appears when there is nothing to
 * interrupt, and a day reading that survives a gap. Each of those is a rule that
 * would look fine if broken and would quietly make the record untrustworthy.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  amendFocus,
  closeFocus,
  currentFocus,
  dayLabel,
  focusDays,
  focusPath,
  lastLeftOff,
  openFocus,
  pickupFrom,
  proposeFrom,
  readFocus,
  writeFocus,
} from "../src/spool/focus";
import { spoolPaths, type SpoolPaths } from "../src/spool/store";
import type { SpoolFocusEntry, SpoolSubjectThreads, SpoolThreadView } from "@telar/engine-client";

function tmpStore(): SpoolPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spool-focus-"));
  const paths = spoolPaths(root);
  fs.mkdirSync(paths.root, { recursive: true });
  return paths;
}

/** Fixed dates so the day axis is deterministic — 2026-08-15 is a Saturday. */
const SAT = new Date("2026-08-15T10:00:00Z");
const SUN = new Date("2026-08-16T10:00:00Z");
const MON = new Date("2026-08-17T10:00:00Z");

const view = (over: Partial<SpoolThreadView["thread"]> = {}, ply: Partial<SpoolThreadView["ply"]> = {}): SpoolThreadView => ({
  thread: {
    id: "t-1",
    subject: "ozom-gv",
    question: "Does our ad data match what the platforms say?",
    handle: "Supermetrics parity",
    items: [],
    facts: [],
    created: "Sat 12:00",
    schemaVersion: 1,
    ...over,
  },
  ply: { verified: 0, unchecked: 0, open: 0, captures: 0, ...ply },
  items: [],
});

const subject = (over: Partial<SpoolSubjectThreads> = {}): SpoolSubjectThreads => ({
  subject: "ozom-gv",
  permits: "draft",
  threads: [],
  loose: [],
  ...over,
});

describe("the verbs", () => {
  test("opening records the subject, a day label and a real stamp", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "ozom-gv", note: "reading reconciliation.ts" }, SAT);
    expect(entry.subject).toBe("ozom-gv");
    expect(entry.day).toBe("Saturday");
    expect(entry.at).toBe(SAT.getTime());
    expect(entry.note).toBe("reading reconciliation.ts");
  });

  test("re-opening what is already open is ONE stance, not two rows", () => {
    const paths = tmpStore();
    const first = openFocus(paths, { subject: "ozom-gv" }, SAT);
    const again = openFocus(paths, { subject: "ozom-gv" }, SAT);
    expect(again.id).toBe(first.id);
    expect(readFocus(paths)).toHaveLength(1);
  });

  test("two subjects at once is two open entries, not a mode", () => {
    const paths = tmpStore();
    openFocus(paths, { subject: "ozom-gv" }, SAT);
    openFocus(paths, { subject: "telar-vnext" }, SAT);
    expect(currentFocus(readFocus(paths))).toHaveLength(2);
  });

  /**
   * THIS TEST USED TO ASSERT THE BUG.
   *
   * It read "the same subject narrowed to a thread is a DIFFERENT stance" and
   * required TWO open entries — so the suite was green precisely because it
   * agreed with the defect. The first surface that made thread rows clickable
   * turned three clicks into four concurrent entries on one subject, and the
   * Spool told its user they were working on four instances of the same thing.
   *
   * A thread is WHERE INSIDE a subject you are. Parallel focus is across
   * subjects, and the test below is the one that guards it.
   */
  test("narrowing to a thread MOVES the open entry — it does not open a second", () => {
    const paths = tmpStore();
    const first = openFocus(paths, { subject: "ozom-gv" }, SAT);
    const narrowed = openFocus(paths, { subject: "ozom-gv", threadId: "t-1" }, SAT);
    expect(currentFocus(readFocus(paths))).toHaveLength(1);
    // SAME ENTRY: the id and the start survive, because "how long have I been on
    // ozom-gv" must not restart every time you look at a different question.
    expect(narrowed.id).toBe(first.id);
    expect(narrowed.at).toBe(first.at);
    expect(narrowed.threadId).toBe("t-1");
  });

  test("moving between threads stays one entry, and is NOT logged as a correction", () => {
    const paths = tmpStore();
    openFocus(paths, { subject: "ozom-gv", threadId: "t-1" }, SAT);
    const moved = openFocus(paths, { subject: "ozom-gv", threadId: "t-2" }, SAT);
    expect(currentFocus(readFocus(paths))).toHaveLength(1);
    expect(moved.threadId).toBe("t-2");
    // `amended[]` is for having been WRONG about what you were on. Working
    // through a subject's questions is the ordinary shape of working, and
    // logging each step as a correction would bury the real ones.
    expect(moved.amended ?? []).toHaveLength(0);
  });

  test("widening back to the whole subject clears the thread, still one entry", () => {
    const paths = tmpStore();
    openFocus(paths, { subject: "ozom-gv", threadId: "t-1" }, SAT);
    const wide = openFocus(paths, { subject: "ozom-gv" }, SAT);
    expect(currentFocus(readFocus(paths))).toHaveLength(1);
    expect(wide.threadId).toBeUndefined();
  });

  test("closing records WHERE YOU LEFT IT, which is what pick-up means", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "ozom-gv" }, SAT);
    const closed = closeFocus(paths, entry.id, { reason: "paused", note: "stuck on the Vault token" }, SAT);
    expect(closed?.ended?.reason).toBe("paused");
    expect(closed?.ended?.note).toBe("stuck on the Vault token");
    expect(currentFocus(readFocus(paths))).toHaveLength(0);
  });

  test("closing something already closed does nothing rather than restamping it", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "ozom-gv" }, SAT);
    closeFocus(paths, entry.id, { reason: "done" }, SAT);
    expect(closeFocus(paths, entry.id, { reason: "switched" }, MON)).toBeNull();
    expect(readFocus(paths)[0]!.ended?.reason).toBe("done");
  });
});

describe("correcting within the day", () => {
  test("an amendment KEEPS the old value — the log stays trustworthy", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "ozom-gv", note: "budgets" }, SAT);
    const fixed = amendFocus(paths, entry.id, { subject: "aurora" }, "I was actually on aurora", SAT);
    expect(fixed?.subject).toBe("aurora");
    expect(fixed?.amended).toHaveLength(1);
    expect(fixed?.amended?.[0]!.was).toContain("ozom-gv");
    expect(fixed?.amended?.[0]!.why).toBe("I was actually on aurora");
  });

  test("correcting twice keeps BOTH prior values", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "a" }, SAT);
    amendFocus(paths, entry.id, { subject: "b" }, undefined, SAT);
    const twice = amendFocus(paths, entry.id, { subject: "c" }, undefined, SAT);
    expect(twice?.amended).toHaveLength(2);
    expect(twice?.amended?.map((a) => a.was).join(" ")).toContain("a");
    expect(twice?.amended?.map((a) => a.was).join(" ")).toContain("b");
  });

  test("`threadId: null` CLEARS it — \"I was on the subject, not that thread\"", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "ozom-gv", threadId: "t-1" }, SAT);
    const fixed = amendFocus(paths, entry.id, { threadId: null }, undefined, SAT);
    expect(fixed?.threadId).toBeUndefined();
  });

  test("an amendment never removes the entry", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "ozom-gv" }, SAT);
    amendFocus(paths, entry.id, { subject: "aurora" }, undefined, SAT);
    expect(readFocus(paths)).toHaveLength(1);
  });
});

describe("the Saturday / Sunday / Monday reading", () => {
  test("groups by day, oldest first, and a gap does not break the sequence", () => {
    const paths = tmpStore();
    const sat = openFocus(paths, { subject: "ozom-gv" }, SAT);
    closeFocus(paths, sat.id, { reason: "paused", note: "left mid-way" }, SAT);
    const sun = openFocus(paths, { subject: "telar-vnext" }, SUN);
    closeFocus(paths, sun.id, { reason: "paused" }, SUN);
    openFocus(paths, { subject: "ozom-gv" }, MON);

    const days = focusDays(readFocus(paths));
    expect(days.map((d) => d.day)).toEqual(["Saturday", "Sunday", "Monday"]);
    expect(days[2]!.entries[0]!.subject).toBe("ozom-gv");
  });

  test("picking a subject back up finds WHERE YOU LEFT IT, across the gap", () => {
    const paths = tmpStore();
    const sat = openFocus(paths, { subject: "ozom-gv" }, SAT);
    closeFocus(paths, sat.id, { reason: "paused", note: "stuck on the Vault token" }, SAT);
    const sun = openFocus(paths, { subject: "telar-vnext" }, SUN);
    closeFocus(paths, sun.id, { reason: "paused" }, SUN);

    expect(lastLeftOff(readFocus(paths), "ozom-gv")?.ended?.note).toBe("stuck on the Vault token");
  });

  test("a subject you have never been on has no left-off point, rather than a made-up one", () => {
    expect(lastLeftOff([], "ozom-gv")).toBeUndefined();
  });

  test("the most recent close wins when a subject was picked up twice", () => {
    const paths = tmpStore();
    const first = openFocus(paths, { subject: "ozom-gv" }, SAT);
    closeFocus(paths, first.id, { reason: "paused", note: "first stop" }, SAT);
    const second = openFocus(paths, { subject: "ozom-gv" }, MON);
    closeFocus(paths, second.id, { reason: "paused", note: "second stop" }, MON);
    expect(lastLeftOff(readFocus(paths), "ozom-gv")?.ended?.note).toBe("second stop");
  });

  test("dayLabel is the store minting a label, not a surface computing one", () => {
    expect(dayLabel(SAT)).toBe("Saturday");
    expect(dayLabel(MON)).toBe("Monday");
  });
});

describe("the pickup", () => {
  const map = [
    subject({
      threads: [
        view({ id: "t-1", handle: "Supermetrics parity", waiting: { kind: "person", who: "Ana" } }),
        view({ id: "t-2", handle: "Hito 1 readiness", waiting: { kind: "you", note: "reach the tracker" } }),
      ],
    }),
  ];

  test("says what moved on what you are on, as a sentence", () => {
    const entries: SpoolFocusEntry[] = [
      { id: "f-1", subject: "ozom-gv", label: "Sat 10:00", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
    ];
    const withSettled = [
      subject({ threads: [view({ id: "t-1", handle: "Supermetrics parity", settled: { at: "Sat", answer: "No — Meta diverges 6.83%." } })] }),
    ];
    expect(pickupFrom(entries, withSettled).moved).toEqual([
      { subject: "ozom-gv", text: "Supermetrics parity — answered: No — Meta diverges 6.83%." },
    ]);
  });

  test("a moved line names the subject it came from — several can be open at once", () => {
    // A person can be on several subjects at once (`currentFocus` never ends
    // the others), so a moved line with no subject attached is unattributable
    // the moment two are open — this is the fact a focused room needs to
    // filter on.
    const entries: SpoolFocusEntry[] = [
      { id: "f-1", subject: "ozom-gv", label: "x", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
      { id: "f-2", subject: "telar-vnext", label: "y", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
    ];
    const twoSubjects = [
      subject({
        subject: "ozom-gv",
        threads: [view({ id: "t-1", handle: "Supermetrics parity", settled: { at: "Sat", answer: "No." } })],
      }),
      subject({
        subject: "telar-vnext",
        threads: [view({ id: "t-2", handle: "Stance scoping", settled: { at: "Sat", answer: "Fixed." } })],
      }),
    ];
    expect(pickupFrom(entries, twoSubjects).moved).toEqual([
      { subject: "ozom-gv", text: "Supermetrics parity — answered: No." },
      { subject: "telar-vnext", text: "Stance scoping — answered: Fixed." },
    ]);
  });

  /** ON SOMETHING, so no proposal fires — otherwise it absorbs the line, which
   *  is the "one fact, one place" rule below and not a bug here. */
  const onSomething: SpoolFocusEntry[] = [
    { id: "f-on", subject: "ozom-gv", label: "x", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
  ];

  test("names the person who is waiting", () => {
    expect(pickupFrom(onSomething, map).waiting.map((w) => w.derived)).toContain("Ana is waiting on Supermetrics parity.");
  });

  /**
   * FOUND BY READING THE LIVE OUTPUT. This band also listed every `you`-blocked
   * thread, which duplicated the proposal AND depended on the model writing a
   * note that finishes "…until you ___" grammatically. A live pass produced
   * "can't move until you Needs the user to confirm or rule out that this item
   * is." A composed sentence may never need a model to complete it.
   */
  test("a `you`-blocked thread is NOT here — that is the proposal's job", () => {
    expect(pickupFrom(onSomething, map).waiting.map((w) => w.derived)).toEqual(["Ana is waiting on Supermetrics parity."]);
  });

  test("no sentence here is built by appending a model's prose to a template", () => {
    const odd = [
      subject({
        threads: [view({ waiting: { kind: "you", note: "Needs the user to confirm or rule out that this item is" } })],
      }),
    ];
    expect(pickupFrom([], odd).waiting.map((w) => w.derived)).toEqual([]);
  });

  test("a focus narrowed to a thread reports only THAT thread", () => {
    const entries: SpoolFocusEntry[] = [
      { id: "f-1", subject: "ozom-gv", threadId: "t-9", label: "x", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
    ];
    expect(pickupFrom(entries, map).moved).toEqual([]);
  });

  test("a settled thread never appears as something waiting", () => {
    const settled = [subject({ threads: [view({ waiting: { kind: "person", who: "Ana" }, settled: { at: "Sat", answer: "done" } })] })];
    expect(pickupFrom([], settled).waiting.map((w) => w.derived)).toEqual([]);
  });
});

describe("the proposal", () => {
  const map = [
    subject({
      threads: [
        view({ id: "t-1", handle: "Supermetrics parity", waiting: { kind: "person", who: "Ana" } }),
        view({ id: "t-2", handle: "Ready thing" }, { verified: 3, open: 0 }),
      ],
    }),
  ];

  test("appears when you are on nothing", () => {
    const proposal = proposeFrom([], map);
    expect(proposal?.why).toBe("You're not on anything right now.");
    expect(proposal?.options.length).toBeGreaterThan(0);
  });

  test("DOES NOT APPEAR while you are on something — that would be an interruption", () => {
    const entries: SpoolFocusEntry[] = [
      { id: "f-1", subject: "ozom-gv", label: "x", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
    ];
    expect(proposeFrom(entries, map)).toBeUndefined();
    expect(pickupFrom(entries, map).proposal).toBeUndefined();
  });

  test("every option carries a REASON you can disagree with", () => {
    for (const option of proposeFrom([], map)?.options ?? []) {
      expect(option.derived.length).toBeGreaterThan(0);
    }
  });

  test("someone waiting comes before something merely ready", () => {
    expect(proposeFrom([], map)?.options[0]!.derived).toContain("Ana is waiting");
  });

  test("offers at most three — a list of everything is what it exists instead of", () => {
    const many = [
      subject({
        threads: Array.from({ length: 9 }, (_, i) =>
          view({ id: `t-${i}`, handle: `Thing ${i}`, waiting: { kind: "person", who: "Ana" } }),
        ),
      }),
    ];
    expect(proposeFrom([], many)?.options).toHaveLength(3);
  });

  test("an unmapped subject is offered as a LAST resort and says so", () => {
    const unmapped = [subject({ subject: "aurora", threads: [], loose: [{ id: "i-a", title: "x" }] })];
    expect(proposeFrom([], unmapped)?.options[0]!.derived).toContain("nothing has been worked out yet");
  });

  test("nothing to suggest means NO proposal, rather than an empty one", () => {
    expect(proposeFrom([], [subject({ threads: [], loose: [] })])).toBeUndefined();
  });

  test("a CLOSED loose capture is never proposed — the user ticked the box, and proposing it would be nagging it open", () => {
    // docs/spool-loops.md §9: only the hand closes, and only the hand reopens.
    const allClosed = [subject({ threads: [], loose: [{ id: "i-a", title: "x", closed: true }] })];
    expect(proposeFrom([], allClosed)).toBeUndefined();
    // A live capture beside a closed one grounds the offer; the closed one is
    // skipped rather than hiding the subject.
    const mixed = [
      subject({
        threads: [],
        loose: [
          { id: "i-closed", title: "over", said: "hecho", closed: true },
          { id: "i-live", title: "still real", said: "pendiente" },
        ],
      }),
    ];
    const option = proposeFrom([], mixed)?.options[0];
    expect(option?.itemId).toBe("i-live");
  });

  test("a settled thread is never proposed", () => {
    const done = [subject({ threads: [view({ settled: { at: "Sat", answer: "done" } })] })];
    expect(proposeFrom([], done)).toBeUndefined();
  });
});

describe("the store", () => {
  test("a never-written file reads as no history rather than throwing", () => {
    expect(readFocus(tmpStore())).toEqual([]);
  });

  test("reading is tolerant per row", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "ozom-gv" }, SAT);
    fs.writeFileSync(focusPath(paths), JSON.stringify([{ broken: true }, entry]));
    expect(readFocus(paths)).toHaveLength(1);
  });

  test("a duplicate id is dropped rather than read twice", () => {
    const paths = tmpStore();
    const entry = openFocus(paths, { subject: "ozom-gv" }, SAT);
    fs.writeFileSync(focusPath(paths), JSON.stringify([entry, entry]));
    expect(readFocus(paths)).toHaveLength(1);
  });

  test("writeFocus validates, so a bad entry cannot reach disk", () => {
    expect(() => writeFocus(tmpStore(), [{ id: "f-1" } as unknown as SpoolFocusEntry])).toThrow();
  });
});

/**
 * ONE FACT, ONE PLACE — found in a screenshot rather than by the gate.
 *
 * "Ana is waiting on September budget mismatch." rendered under WAITING and
 * again under COULD PICK UP, a hundred pixels apart. Both true; the repetition
 * was most of what made the surface read as noise.
 */
describe("nothing is said twice", () => {
  const map = [
    subject({ threads: [view({ id: "t-1", handle: "September budget mismatch", waiting: { kind: "person", who: "Ana" } })] }),
  ];

  test("a line the proposal offers is not repeated under waiting", () => {
    const pickup = pickupFrom([], map);
    for (const line of pickup.waiting) {
      expect(pickup.proposal?.options.map((o) => o.derived)).not.toContain(line);
    }
  });

  test("but it still appears SOMEWHERE — the proposal keeps it, because it can be acted on", () => {
    const pickup = pickupFrom([], map);
    expect(pickup.proposal?.options.map((o) => o.derived)).toContain("Ana is waiting on September budget mismatch.");
  });

  test("with no proposal showing, waiting states it itself", () => {
    const on: SpoolFocusEntry[] = [
      { id: "f-1", subject: "ozom-gv", label: "x", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
    ];
    expect(pickupFrom(on, map).waiting.map((w) => w.derived)).toContain("Ana is waiting on September budget mismatch.");
  });
});

/**
 * NOTHING IS REPORTED WITHOUT THE WORDS THAT CAUSED IT.
 *
 * "We can't have the system reporting to me things I don't understand." A line
 * carrying your own capture needs no explaining; one that is only the system's
 * bookkeeping cannot be checked by reading it, so it must never outrank one that
 * can.
 */
describe("grounding", () => {
  const said = "los presupuestos de sept no cuadran. ana lo preguntó el jueves";
  const grounded = [
    subject({
      threads: [
        {
          ...view({ id: "t-1", handle: "September budget mismatch", waiting: { kind: "person", who: "Ana" } }),
          items: [{ id: "i-a", title: "presupuestos sept no cuadran", said }],
        },
      ],
    }),
  ];

  test("a waiting line carries the capture behind it", () => {
    const on: SpoolFocusEntry[] = [
      { id: "f-1", subject: "ozom-gv", label: "x", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
    ];
    const [line] = pickupFrom(on, grounded).waiting;
    expect(line?.said).toBe(said);
    expect(line?.itemId).toBe("i-a");
  });

  test("a proposal option carries it too, and names where to act", () => {
    const [option] = proposeFrom([], grounded)?.options ?? [];
    expect(option?.said).toBe(said);
    expect(option?.subject).toBe("ozom-gv");
    expect(option?.threadId).toBe("t-1");
  });

  test("a line with NO capture is still allowed — it just cannot outrank one that has", () => {
    const mixed = [
      subject({
        subject: "a",
        threads: [{ ...view({ id: "t-bare", handle: "Bare" }, { verified: 2, open: 0 }), items: [] }],
      }),
      subject({
        subject: "b",
        threads: [
          {
            ...view({ id: "t-said", handle: "Said" }, { verified: 2, open: 0 }),
            items: [{ id: "i-b", title: "x", said: "something I typed" }],
          },
        ],
      }),
    ];
    const options = proposeFrom([], mixed)?.options ?? [];
    expect(options[0]?.said).toBe("something I typed");
    expect(options.some((o) => !o.said)).toBe(true);
  });

  test("a thread whose captures have no raw grounds nothing rather than inventing a source", () => {
    const bare = [subject({ threads: [{ ...view({ waiting: { kind: "person", who: "Ana" } }), items: [{ id: "i", title: "t" }] }] })];
    const on: SpoolFocusEntry[] = [
      { id: "f-1", subject: "ozom-gv", label: "x", day: "Saturday", at: SAT.getTime(), schemaVersion: 1 },
    ];
    expect(pickupFrom(on, bare).waiting[0]?.said).toBeUndefined();
  });
});
