// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { chipBasename, chipIsDirectory, chipPath, detectComposerTrigger, replaceTextRange, segmentDraft } from "./composer-tokens";
import { checkReference, directoryReference, fileReference, issueReference, pageReference, pullReference, taskReference } from "./drag-reference";

describe("what the caret is in the middle of", () => {
  test("an at-sign opens the path menu and carries what follows it", () => {
    expect(detectComposerTrigger("look at @src/dri", 16)).toEqual({ kind: "path", query: "src/dri", rangeStart: 8, rangeEnd: 16 });
  });

  test("a bare at-sign is already a trigger, so the menu opens before anything is typed", () => {
    expect(detectComposerTrigger("look at @", 9)).toEqual({ kind: "path", query: "", rangeStart: 8, rangeEnd: 9 });
  });

  test("whitespace ends the token, so a completed mention is no longer live", () => {
    // The `@` is still on the line; the caret is past the word it opened.
    expect(detectComposerTrigger("@src/a.ts and then", 18)).toBeNull();
  });

  test("a slash only triggers at the start of a line", () => {
    expect(detectComposerTrigger("/full", 5)).toEqual({ kind: "command", query: "full", rangeStart: 0, rangeEnd: 5 });
    // THE RULE THAT MATTERS: a slash mid-sentence is a fraction, a date or a
    // path separator, and every one of those would open a menu over the words
    // being typed.
    expect(detectComposerTrigger("9/10 tests pass", 4)).toBeNull();
    expect(detectComposerTrigger("see apps/engine", 15)).toBeNull();
  });

  test("a slash on a later line still triggers, because the line is the unit", () => {
    expect(detectComposerTrigger("first line\n/stop", 16)).toEqual({ kind: "command", query: "stop", rangeStart: 11, rangeEnd: 16 });
  });

  test("the argument after a command is part of the query, so a row can be narrowed", () => {
    // `/model Opus` is a ROW, so "model op" has to reach it. Stopping the token
    // at the space would leave every multi-word row selectable only by arrow.
    expect(detectComposerTrigger("/model op", 9)).toEqual({ kind: "command", query: "model op", rangeStart: 0, rangeEnd: 9 });
  });

  test("a line that merely starts with a slash is still a trigger, and matches nothing", () => {
    // Costs nothing: no command matches, so no menu opens and Enter sends it.
    expect(detectComposerTrigger("/Users/bixku/notes.md is the file", 32)).toMatchObject({ kind: "command" });
  });

  test("a caret past the end of the text is clamped rather than read out of bounds", () => {
    expect(detectComposerTrigger("@a", 999)).toEqual({ kind: "path", query: "a", rangeStart: 0, rangeEnd: 2 });
  });
});

describe("splicing", () => {
  test("a replacement reports where the caret lands, not where it started", () => {
    expect(replaceTextRange("look at @dri", 8, 12, "`src/driver.ts`")).toEqual({ text: "look at `src/driver.ts`", cursor: 23 });
  });

  test("an out-of-range span is clamped instead of producing undefined text", () => {
    expect(replaceTextRange("abc", -5, 99, "z")).toEqual({ text: "z", cursor: 1 });
  });
});

describe("which runs of a draft draw as chips", () => {
  /** Concatenating the segments must reproduce the draft exactly — the property
   *  the editor's offset arithmetic depends on. */
  const rebuild = (draft: string) =>
    segmentDraft(draft)
      .map((segment) => (segment.type === "text" ? segment.text : segment.reference.text))
      .join("");

  test("a backticked path is a file chip and keeps its own text", () => {
    const draft = `please read ${fileReference("apps/engine/src/driver.ts").text} first`;
    const [before, chip, after] = segmentDraft(draft);
    expect(before).toEqual({ type: "text", text: "please read " });
    expect(chip).toMatchObject({ type: "chip", reference: { kind: "file", label: "driver.ts" } });
    expect(after).toEqual({ type: "text", text: " first" });
    expect(rebuild(draft)).toBe(draft);
  });

  test("a backticked COMMAND is left as prose", () => {
    // The distinction the whole file turns on: both are written the same way,
    // so only the shape can tell an address from a shell line.
    expect(segmentDraft("run `git status` again")).toEqual([{ type: "text", text: "run `git status` again" }]);
    expect(segmentDraft("pass `--force`")).toEqual([{ type: "text", text: "pass `--force`" }]);
    expect(segmentDraft("just `ls`")).toEqual([{ type: "text", text: "just `ls`" }]);
  });

  test("a directory keeps its trailing slash, in the label as well as the text", () => {
    const reference = directoryReference("apps/engine");
    const [chip] = segmentDraft(reference.text);
    expect(chip).toMatchObject({ type: "chip", reference: { label: "engine/" } });
    expect(chipIsDirectory((chip as { reference: typeof reference }).reference)).toBe(true);
    expect(chipPath((chip as { reference: typeof reference }).reference)).toBe("apps/engine/");
  });

  test("a pull request wins over the issue reference hiding inside it", () => {
    // `PR #82 "…" (…)` CONTAINS `#82 "…" (…)`. Earliest start wins, and the PR
    // match starts two characters earlier.
    const draft = pullReference({ number: 82, title: "Fold the model list", url: "https://example.test/pull/82" }).text;
    const segments = segmentDraft(draft);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: "chip", reference: { kind: "pull", label: "PR #82" } });
    expect(rebuild(draft)).toBe(draft);
  });

  test("an issue chips, and the URL inside it is not torn out as a page", () => {
    const draft = issueReference({ number: 7, title: "Phantom declines", url: "https://example.test/issues/7" }).text;
    const segments = segmentDraft(draft);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: "chip", reference: { kind: "issue", label: "#7" } });
  });

  test("a sub-agent and a page each chip as themselves", () => {
    const task = taskReference({ id: "task_a", title: "Audit the parser", state: "completed" });
    expect(segmentDraft(task.text)[0]).toMatchObject({ type: "chip", reference: { kind: "task", label: "Audit the parser" } });
    const page = pageReference({ title: "Docs", url: "https://example.test/docs" });
    expect(segmentDraft(page.text)[0]).toMatchObject({ type: "chip", reference: { kind: "page" } });
  });

  test("a failing check chips its head line and leaves the log below it as text", () => {
    // THE RULE: a chip that swallowed the fence would hide the thing the reader
    // dropped it for.
    const draft = checkReference({
      name: "typecheck",
      status: "completed",
      conclusion: "failure",
      url: "https://example.test/runs/1",
      log: ["error TS2304", "  at line 4"],
    }).text;
    const segments = segmentDraft(draft);
    expect(segments[0]).toMatchObject({ type: "chip", reference: { kind: "check", label: "typecheck" } });
    expect(segments[1]?.type).toBe("text");
    expect((segments[1] as { text: string }).text).toContain("```log");
    expect(rebuild(draft)).toBe(draft);
  });

  test("a title carrying a double quote falls back to prose rather than half a chip", () => {
    // A missing decoration; the message is byte-identical either way.
    const draft = `#5 "the "quoted" one" (https://example.test/issues/5)`;
    expect(rebuild(draft)).toBe(draft);
  });

  test("two references in one sentence both chip, with the prose between them intact", () => {
    const draft = `fix ${issueReference({ number: 4, title: "Boom", url: "https://example.test/i/4" }).text} in ${fileReference("src/a.ts").text}`;
    const kinds = segmentDraft(draft).map((segment) => (segment.type === "chip" ? segment.reference.kind : "text"));
    expect(kinds).toEqual(["text", "issue", "text", "file"]);
    expect(rebuild(draft)).toBe(draft);
  });

  test("an empty draft has no segments at all", () => {
    expect(segmentDraft("")).toEqual([]);
  });
});

describe("naming a path", () => {
  test("a file is its basename and a directory keeps the slash that says so", () => {
    expect(chipBasename("apps/engine/src/driver.ts")).toBe("driver.ts");
    expect(chipBasename("apps/engine/")).toBe("engine/");
    expect(chipBasename("README.md")).toBe("README.md");
  });
});
