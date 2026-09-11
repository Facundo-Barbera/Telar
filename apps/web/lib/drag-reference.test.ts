/**
 * The drag payload and the caret splice.
 *
 * Both are pure, and both are where this feature is actually decided: what a
 * reference SAYS once it is in the message, and whether dropping one into a
 * half-written sentence produces something a person would have typed.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  browserPageReference,
  checkReference,
  failingChecksReference,
  fileReference,
  insertReference,
  issueReference,
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
    // The chip says the basename, because a full path in a 12-character chip is
    // just the middle of a path.
    expect(reference.label).toBe("auth.ts");
  });

  test("a page is its URL, and a titleless page still labels as something", () => {
    expect(pageReference({ title: "Settings", url: "http://localhost:3000/settings" }).text).toBe("http://localhost:3000/settings");
    expect(pageReference({ url: "http://localhost:3000/x" }).label).toBe("http://localhost:3000/x");
  });

  test("a title's double quotes become single ones, because the chip pattern finds a title BY its quotes", () => {
    // The #167 regression: an issue literally titled `…marked "In use"…`
    // dropped as prose, because the inner quotes broke the pattern that turns
    // the text back into a chip. Sanitized at write time, once.
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
    // It has no address a tool can fetch, so the reference is the transcript's
    // own words plus the part you are usually asking about.
    expect(taskReference({ id: "task_1", title: "reviewer", state: "failed" }).text).toBe('the "reviewer" sub-agent (failed)');
  });
});

describe("project notes", () => {
  const note = { id: "n-abc123", title: "Deploy", body: "run `bun run ship` from main" };

  test("A NOTE CARRIES ITS BODY — a reference that inserted only a title is a link the model cannot follow", () => {
    // The second and last exception in this module, earned the way the check's
    // log is: the note lives in the engine's notebook, and there is no address
    // an ordinary agent could dereference.
    const reference = noteReference(note);
    expect(reference.kind).toBe("note");
    expect(reference.label).toBe("Deploy");
    expect(reference.text).toBe('the "Deploy" project note (n-abc123):\n\n```note\nrun `bun run ship` from main\n```');
  });

  test("the id rides in the head line, so an agent holding notes_write can edit what it was shown", () => {
    expect(noteReference(note).text.startsWith('the "Deploy" project note (n-abc123)')).toBe(true);
  });

  test("a note containing its own fence cannot close the block early", () => {
    // The rule markdown itself uses: one backtick longer than the longest run
    // inside. A note ABOUT fenced code is an ordinary note.
    const text = noteReference({ id: "n-1", title: "Snippet", body: "```ts\nexport const a = 1;\n```" }).text;
    expect(text).toContain("````note\n```ts\nexport const a = 1;\n```\n````");
  });

  test("an empty note is its head line and nothing else", () => {
    // "+, type a title, come back to it" is a real state, and a fence around
    // nothing would be noise in the middle of a sentence.
    expect(noteReference({ id: "n-2", title: "Later", body: "   " }).text).toBe('the "Later" project note (n-2)');
  });

  test("a title's double quotes become single ones here too, for the same reason", () => {
    // The chip pattern finds a note BY the quotes around its title.
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
    // Enough for an agent with `gh` to go and look, which is what every other
    // reference in this module is.
    expect(checkReference(failing).text).toBe('the "CI / test" check (failure) — https://gh/job/1');
  });

  test("A CHECK WITH ITS LOG CARRIES THE LOG, which is the one exception in this file", () => {
    // Every other reference is an address because the agent can fetch the thing. A
    // GitHub Actions log needs an authenticated call it cannot make, so a URL alone
    // turns "fix this failure" into "go and find out what it was, which you cannot".
    const text = checkReference({ ...failing, log: ["FAIL src/a.test.ts", "expected 1, got 2"] }).text;
    expect(text).toContain("its failing log");
    // FENCED, or a stack trace's backticks and hashes are read as markdown.
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
    // "CI is red, fix it" is one sentence and one drag rather than five.
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
