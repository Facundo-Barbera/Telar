// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { chipBasename, chipIsDirectory, chipPath, detectComposerTrigger, replaceTextRange, segmentDraft } from "./composer-tokens";
import { browserPageReference, checkReference, directoryReference, fileReference, issueReference, noteReference, pageReference, pullReference, skillReference, taskReference } from "./drag-reference";

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

  test("a dollar opens the skill menu, at the start of a word and nowhere else", () => {
    expect(detectComposerTrigger("$commit", 7)).toEqual({ kind: "skill", query: "commit", rangeStart: 0, rangeEnd: 7 });
    expect(detectComposerTrigger("now run $rel", 12)).toEqual({ kind: "skill", query: "rel", rangeStart: 8, rangeEnd: 12 });
    // Bare, before anything is typed — the same as `@`.
    expect(detectComposerTrigger("use $", 5)).toEqual({ kind: "skill", query: "", rangeStart: 4, rangeEnd: 5 });
  });

  test("a dollar after a non-space character is somebody's shell, not a trigger", () => {
    expect(detectComposerTrigger("PATH=$HOME", 10)).toBeNull();
    expect(detectComposerTrigger("it costs US$40", 14)).toBeNull();
    expect(detectComposerTrigger("echo x$y", 8)).toBeNull();
  });

  test("a substitution is never a trigger, however far into it the caret is", () => {
    expect(detectComposerTrigger("${TELAR_ROOT", 12)).toBeNull();
    expect(detectComposerTrigger("run ${HOME}/bin", 11)).toBeNull();
    // The brace check is about the token, not the caret: `${` on its own is
    // already the opening of a substitution.
    expect(detectComposerTrigger("${", 2)).toBeNull();
  });

  test("whitespace ends a skill token too, so a completed pick is no longer live", () => {
    expect(detectComposerTrigger("$commit-messages and then", 25)).toBeNull();
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

  test("a skill chips mid-sentence, and the draft is still exactly what was typed", () => {
    const draft = `please use ${skillReference({ name: "commit-messages" }).text} for this`;
    const [before, chip, after] = segmentDraft(draft);
    expect(before).toEqual({ type: "text", text: "please use " });
    expect(chip).toMatchObject({ type: "chip", reference: { kind: "skill", label: "commit-messages" } });
    expect(after).toEqual({ type: "text", text: " for this" });
    expect(rebuild(draft)).toBe(draft);
    // A plugin's skill keeps its namespace, which is the only spelling that
    // resolves at the provider.
    expect(segmentDraft(skillReference({ name: "vercel:deploy" }).text)[0]).toMatchObject({
      type: "chip",
      reference: { kind: "skill", label: "vercel:deploy" },
    });
  });

  test("a sentence that merely says the word skill is prose", () => {
    // The name shape is literal, so only something that COULD be a command name
    // is read back as one.
    expect(segmentDraft('the "old way" skill was better')).toEqual([{ type: "text", text: 'the "old way" skill was better' }]);
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
    // A missing decoration; the message is byte-identical either way. (New
    // drops never produce this string — `issueReference` sanitizes quotes —
    // but a draft typed by hand or saved by an older build still might.)
    const draft = `#5 "the "quoted" one" (https://example.test/issues/5)`;
    expect(rebuild(draft)).toBe(draft);
  });

  test("an issue whose TITLE had quotes still chips, because the reference sanitized them (the #167 regression)", () => {
    const draft = `fix ${issueReference({ number: 167, title: 'the environment marked "In use" (+ UX follow-ups)', url: "https://example.test/issues/167" }).text} please`;
    const segments = segmentDraft(draft);
    expect(segments).toHaveLength(3);
    expect(segments[1]).toMatchObject({ type: "chip", reference: { kind: "issue", label: "#167" } });
    expect(rebuild(draft)).toBe(draft);
  });

  test("a page open in the session's browser chips with its title, and its URL is not torn out", () => {
    const draft = `pull the pricing table from ${browserPageReference({ title: "Pricing — Acme", url: "http://localhost:3000/pricing" }).text}`;
    const segments = segmentDraft(draft);
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({ type: "chip", reference: { kind: "page", label: "Pricing — Acme" } });
    expect(rebuild(draft)).toBe(draft);
  });

  test("a bare URL does not swallow the sentence's punctuation after it", () => {
    // `\S+` used to take the closing paren and the full stop with it, and the
    // chip's text was a URL that 404s.
    const draft = "see (https://example.test/docs), then https://example.test/a.";
    const chips = segmentDraft(draft).filter((segment) => segment.type === "chip");
    expect(chips.map((chip) => chip.reference.text)).toEqual(["https://example.test/docs", "https://example.test/a"]);
    // A Wikipedia-style path keeps ITS OWN closing paren.
    const wiki = segmentDraft("read https://en.example.org/wiki/Bun_(software) now").filter((segment) => segment.type === "chip");
    expect(wiki[0]?.reference.text).toBe("https://en.example.org/wiki/Bun_(software)");
    expect(rebuild(draft)).toBe(draft);
  });

  test("two references in one sentence both chip, with the prose between them intact", () => {
    const draft = `fix ${issueReference({ number: 4, title: "Boom", url: "https://example.test/i/4" }).text} in ${fileReference("src/a.ts").text}`;
    const kinds = segmentDraft(draft).map((segment) => (segment.type === "chip" ? segment.reference.kind : "text"));
    expect(kinds).toEqual(["text", "issue", "text", "file"]);
    expect(rebuild(draft)).toBe(draft);
  });

  test("a project note chips on its HEAD LINE and leaves its body in the draft", () => {
    // The rule a failing check's log already set: the chip must not swallow the
    // block the reader dropped it FOR — the body is what the model reads.
    const draft = `summarise ${noteReference({ id: "n-abc123", title: "Deploy", body: "bun run ship" }).text}`;
    const segments = segmentDraft(draft);
    const chip = segments.find((segment) => segment.type === "chip");
    expect(chip?.reference.kind).toBe("note");
    expect(chip?.reference.label).toBe("Deploy");
    expect(chip?.reference.text).toBe('the "Deploy" project note (n-abc123)');
    // The fence survives as prose after the chip, and the draft is unchanged.
    expect(segments.at(-1)).toEqual({ type: "text", text: ":\n\n```note\nbun run ship\n```" });
    expect(rebuild(draft)).toBe(draft);
  });

  test("prose that merely mentions a project note is prose", () => {
    // The id shape is literal in the pattern precisely so a sentence a person
    // typed does not half-render as a reference that goes nowhere.
    const draft = 'check the "Deploy" project note before you ship';
    expect(segmentDraft(draft).filter((segment) => segment.type === "chip")).toEqual([]);
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
