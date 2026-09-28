// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  browserPageReference,
  checkReference,
  failingChecksReference,
  fileReference,
  insertReference,
  issueReference,
  lineRangeReference,
  noteReference,
  pageReference,
  pullReference,
  readReferenceDrag,
  REFERENCE_MIME,
  startReferenceDrag,
  taskReference,
} from "./drag-reference";

/** The two-slot subset of DataTransfer these functions touch. */
function transfer() {
  const slots = new Map<string, string>();
  return {
    effectAllowed: "none",
    setData: (type: string, value: string) => void slots.set(type, value),
    getData: (type: string) => slots.get(type) ?? "",
  } as unknown as DataTransfer;
}

describe("what a reference says", () => {
  test("an issue carries its title, not just its number", () => {
    // `#82` alone is unreadable in a transcript six weeks later, and the
    // transcript is the part that has to survive.
    expect(issueReference({ number: 82, title: "Navigation freezes", url: "https://github.com/o/r/issues/82" }).text).toBe(
      '#82 "Navigation freezes" (https://github.com/o/r/issues/82)',
    );
    expect(pullReference({ number: 45, title: "Fix the rail", url: "https://github.com/o/r/pull/45" }).text).toBe(
      'PR #45 "Fix the rail" (https://github.com/o/r/pull/45)',
    );
  });

  test("a file is a backticked path — not a URL and not a copy of the file", () => {
    // The agent is working in this checkout; a path is what its Read tool takes,
    // and backticks are what stop a model reading it as prose.
    const reference = fileReference("apps/web/src/auth.ts");
    expect(reference.text).toBe("`apps/web/src/auth.ts`");
    // A full path in a 12-character chip is just the middle of a path.
    expect(reference.label).toBe("auth.ts");
  });

  test("a page is its URL, and a titleless page still labels as something", () => {
    expect(pageReference({ title: "Settings", url: "http://localhost:3000/settings" }).text).toBe("http://localhost:3000/settings");
    expect(pageReference({ url: "http://localhost:3000/x" }).label).toBe("http://localhost:3000/x");
  });

  test("a title's double quotes become single ones, because the chip pattern finds a title BY its quotes", () => {
    // Inner quotes would break the pattern that turns the text back into a chip.
    const issue = issueReference({ number: 167, title: 'kernel runs elsewhere than the env marked "In use"', url: "https://github.com/o/r/issues/167" });
    expect(issue.text).toBe("#167 \"kernel runs elsewhere than the env marked 'In use'\" (https://github.com/o/r/issues/167)");
    const pull = pullReference({ number: 9, title: 'Revert "the revert"', url: "https://github.com/o/r/pull/9" });
    expect(pull.text).toBe("PR #9 \"Revert 'the revert'\" (https://github.com/o/r/pull/9)");
  });

  test("a page open in the session's browser SAYS so — the words that point the agent at its browser tools", () => {
    expect(browserPageReference({ title: "Checkout — Acme", url: "http://localhost:3000/checkout" }).text).toBe(
      "the \"Checkout — Acme\" page open in the session's browser (http://localhost:3000/checkout)",
    );
    // No title yet (still loading): the bare URL is still actionable.
    expect(browserPageReference({ url: "http://localhost:3000/x" }).text).toBe("http://localhost:3000/x");
  });

  test("a sub-agent names itself and says how it ended", () => {
    expect(taskReference({ id: "task_1", title: "reviewer", state: "failed" }).text).toBe('the "reviewer" sub-agent (failed)');
  });
});

describe("project notes", () => {
  const note = { id: "n-abc123", title: "Deploy", body: "run `bun run ship` from main" };

  test("A NOTE CARRIES ITS BODY — a reference that inserted only a title is a link the model cannot follow", () => {
    const reference = noteReference(note);
    expect(reference.kind).toBe("note");
    expect(reference.label).toBe("Deploy");
    expect(reference.text).toBe('the "Deploy" project note (n-abc123):\n\n```note\nrun `bun run ship` from main\n```');
  });

  test("the id rides in the head line, so an agent holding notes_write can edit what it was shown", () => {
    expect(noteReference(note).text.startsWith('the "Deploy" project note (n-abc123)')).toBe(true);
  });

  test("a note containing its own fence cannot close the block early", () => {
    // One backtick longer than the longest run inside, as markdown itself does.
    const text = noteReference({ id: "n-1", title: "Snippet", body: "```ts\nexport const a = 1;\n```" }).text;
    expect(text).toContain("````note\n```ts\nexport const a = 1;\n```\n````");
  });

  test("an empty note is its head line and nothing else", () => {
    // "+, type a title, come back to it" is a real state, and a fence around
    // nothing would be noise in the middle of a sentence.
    expect(noteReference({ id: "n-2", title: "Later", body: "   " }).text).toBe('the "Later" project note (n-2)');
  });

  test("a title's double quotes become single ones here too, for the same reason", () => {
    // The chip pattern finds a note by the quotes around its title.
    expect(noteReference({ id: "n-3", title: 'The "why" file', body: "x" }).text).toContain("the \"The 'why' file\" project note (n-3)");
  });
});

describe("the drag payload", () => {
  test("carries structure and plain text, so a drop elsewhere still does something", () => {
    const data = transfer();
    const reference = issueReference({ number: 7, title: "T", url: "u" });
    startReferenceDrag(data, reference);
    expect(readReferenceDrag(data)).toEqual(reference);
    expect(data.getData("text/plain")).toBe(reference.text);
  });

  test("a drag from outside the app is not a reference, and is not an error", () => {
    // A link dragged from a browser, a selection from an editor. The caller
    // falls back to whatever plain text arrived.
    expect(readReferenceDrag(transfer())).toBeUndefined();
    const malformed = transfer();
    malformed.setData(REFERENCE_MIME, "{not json");
    expect(readReferenceDrag(malformed)).toBeUndefined();
  });
});

describe("insertReference", () => {
  test("spaces the insertion the way a person would have typed it", () => {
    // "fix " + "#82" must not become "fix  #82", and dropping mid-sentence must
    // not weld the reference to the word before it.
    expect(insertReference("fix ", "#82", 4).draft).toBe("fix #82 ");
    expect(insertReference("fix", "#82", 3).draft).toBe("fix #82 ");
    expect(insertReference("", "#82", 0).draft).toBe("#82 ");
    expect(insertReference("look at and tell me", "#82", 8)).toEqual({ draft: "look at #82 and tell me", caret: 12 });
  });

  test("a caret outside the draft is clamped rather than trusted", () => {
    // A stale selection index from a textarea that re-rendered under the drop.
    expect(insertReference("abc", "#1", 99).draft).toBe("abc #1 ");
    expect(insertReference("abc", "#1", -5).draft).toBe("#1 abc");
  });
});

describe("check references", () => {
  const failing = { name: "test", workflow: "CI", status: "COMPLETED", conclusion: "FAILURE", url: "https://gh/job/1" };

  test("a check nobody opened drags as its name, status and URL", () => {
    expect(checkReference(failing).text).toBe('the "CI / test" check (failure) — https://gh/job/1');
  });

  test("A CHECK WITH ITS LOG CARRIES THE LOG, which is the one exception in this file", () => {
    const text = checkReference({ ...failing, log: ["FAIL src/a.test.ts", "expected 1, got 2"] }).text;
    expect(text).toContain("its failing log");
    // Fenced, or a stack trace's backticks and hashes are read as markdown.
    expect(text).toContain("```log\nFAIL src/a.test.ts\nexpected 1, got 2\n```");
  });

  test("a truncated log says how much of it this is", () => {
    const text = checkReference({ ...failing, log: ["a", "b"], logTruncated: true }).text;
    expect(text).toContain("last 2 lines of its failing log");
  });

  test("a workflow that repeats the check name is not said twice", () => {
    expect(checkReference({ name: "lint", workflow: "lint", status: "COMPLETED", conclusion: "FAILURE" }).text).toBe('the "lint" check (failure)');
  });

  test("an unfinished check reads as its STATUS, since it has no conclusion", () => {
    expect(checkReference({ name: "build", status: "IN_PROGRESS" }).text).toBe('the "build" check (in progress)');
  });

  test("all the failures in one drag, and one failure is just that failure", () => {
    const many = failingChecksReference([failing, { name: "build", status: "COMPLETED", conclusion: "TIMED_OUT" }]);
    expect(many.label).toBe("2 failing checks");
    expect(many.text).toContain("2 failing checks:");
    expect(many.text).toContain('"CI / test"');
    expect(many.text).toContain('"build"');
    // A single failure does not get a header saying "1 failing checks".
    expect(failingChecksReference([failing]).text).toBe(checkReference(failing).text);
  });

  test("every reference still travels as both payloads", () => {
    const slots = transfer();
    startReferenceDrag(slots, checkReference({ ...failing, log: ["boom"] }));
    expect(readReferenceDrag(slots)).toMatchObject({ kind: "check" });
    // The plain-text half is what lands in a textarea in another application.
    expect(slots.getData("text/plain")).toContain("boom");
  });
});

describe("line ranges (#855)", () => {
  test("a range is path:start-end, and one line is path:line", () => {
    expect(lineRangeReference("apps/web/src/lib/a.ts", { start: 10, end: 20 })).toEqual({ kind: "file", label: "a.ts:10-20", text: "`apps/web/src/lib/a.ts:10-20`" });
    expect(lineRangeReference("apps/web/src/lib/a.ts", { start: 7, end: 7 }).text).toBe("`apps/web/src/lib/a.ts:7`");
  });

  test("a selection dragged upwards reads the same as one dragged down", () => {
    expect(lineRangeReference("a.ts", { start: 20, end: 10 }).text).toBe("`a.ts:10-20`");
  });

  test("a renamed file is referenced by its new path, the one on disk", () => {
    // The surface hands over the row's path, which for a rename is the new
    // one; the old path has nothing at it for a Read tool to open.
    expect(lineRangeReference("src/new-name.ts", { start: 3, end: 5, startSide: "after" }).text).toBe("`src/new-name.ts:3-5`");
  });

  test("removed lines say their numbers count the file before the change", () => {
    expect(lineRangeReference("a.ts", { start: 4, end: 6, startSide: "before", endSide: "before" }).text).toBe("`a.ts:4-6` (lines before the change)");
  });

  test("a selection across both sides names each end rather than mixing two numberings", () => {
    expect(lineRangeReference("a.ts", { start: 4, end: 9, startSide: "before", endSide: "after" }).text).toBe(
      "`a.ts` from line 4 before the change to line 9 after it",
    );
  });

  test("it lands in a half-written message spaced like a typed word", () => {
    const { text } = lineRangeReference("a.ts", { start: 10, end: 20 });
    expect(insertReference("why does", text, 8).draft).toBe("why does `a.ts:10-20` ");
    expect(insertReference("see  here", text, 4).draft).toBe("see `a.ts:10-20` here");
  });
});
