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
  fileReference,
  insertReference,
  issueReference,
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

  test("a sub-agent names itself and says how it ended", () => {
    // It has no address a tool can fetch, so the reference is the transcript's
    // own words plus the part you are usually asking about.
    expect(taskReference({ id: "task_1", title: "reviewer", state: "failed" }).text).toBe('the "reviewer" sub-agent (failed)');
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
