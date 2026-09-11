/**
 * WHAT `@` OFFERS FROM THE NOTEBOOK.
 *
 * The decision under test is the one §5 of `docs/design/project-notes.md` makes:
 * notes rank BESIDE paths under the one `@` trigger, and the row a person picks
 * inserts the note's BODY rather than its title — the same text dragging the
 * chip produces, because two spellings of one gesture is how a transcript ends
 * up looking like two people wrote it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { ProjectNote } from "@telar/engine-client";
import { noteReference } from "./drag-reference";
import { rankNotes } from "./project-notes";

const stamp = { label: "Thu 10:00", at: 1 };
const note = (title: string, body = "", extra: Partial<ProjectNote> = {}): ProjectNote =>
  ({ id: `n-${title.toLowerCase().replace(/\W+/g, "")}`, projectId: "p", title, body, created: stamp, updated: stamp, author: "you", schemaVersion: 1, ...extra }) as ProjectNote;

const NOTEBOOK = [
  note("Architecture decisions", "The engine owns every rule about a session."),
  note("Deploy", "bun run ship, then watch the Mac mini."),
  note("Review checklist", "Ask for tests. Ask for the WHY in the commit."),
];

describe("ranking the notebook", () => {
  test("an empty query is the notebook's own order — pinned first, as the strip draws it", () => {
    // A bare `@` should surface what the user said to keep where they can see
    // it, which is the only ordering signal they set by hand.
    const pinnedLast = [...NOTEBOOK, note("Pinned", "x", { pinned: true })];
    // The engine hands the list already ordered, so ranking must not re-sort it
    // — it takes the front of what it was given.
    expect(rankNotes(pinnedLast, "").map((row) => row.label)).toEqual(["Architecture decisions", "Deploy", "Review checklist", "Pinned"]);
  });

  test("a query finds a note by its title, and initials work", () => {
    expect(rankNotes(NOTEBOOK, "arch")[0]?.label).toBe("Architecture decisions");
    expect(rankNotes(NOTEBOOK, "dep")[0]?.label).toBe("Deploy");
    // The fuzzy tier: "ad" is not a prefix of "Architecture decisions" and does
    // not appear in it — the two letters are the two words.
    expect(rankNotes(NOTEBOOK, "ad")[0]?.label).toBe("Architecture decisions");
  });

  test("the body is searchable but cannot outrank a real title match", () => {
    // "Ask for tests" is only in the checklist's body; `deploy` is a title.
    expect(rankNotes(NOTEBOOK, "checklist")[0]?.label).toBe("Review checklist");
    expect(rankNotes(NOTEBOOK, "mac mini")[0]?.label).toBe("Deploy");
    // A note whose BODY mentions "deploy" must not displace the one CALLED it.
    const withDecoy = [note("Runbook", "deploy deploy deploy"), ...NOTEBOOK];
    expect(rankNotes(withDecoy, "deploy")[0]?.label).toBe("Deploy");
  });

  test("a query nothing matches offers nothing, rather than the whole notebook", () => {
    expect(rankNotes(NOTEBOOK, "zzzzz")).toEqual([]);
  });

  test("the notebook is capped, because the checkout is thousands of rows and this is four", () => {
    const many = Array.from({ length: 20 }, (_, index) => note(`Note ${index}`, "body"));
    expect(rankNotes(many, "note")).toHaveLength(4);
    expect(rankNotes(many, "", 2)).toHaveLength(2);
  });

  test("a pinned note wins a tie, so the pin means the same thing in the menu as in the strip", () => {
    const tie = [note("Deploy steps", "a"), note("Deploy steps", "a", { id: "n-pinned", pinned: true })];
    expect(rankNotes(tie, "deploy steps")[0]?.id).toBe("note:n-pinned");
  });
});

describe("what a picked row inserts", () => {
  test("the SAME text dragging its chip produces — body included", () => {
    const picked = rankNotes(NOTEBOOK, "deploy")[0]!;
    expect(picked.action).toEqual({ type: "insert", text: noteReference(NOTEBOOK[1]!).text });
    expect(picked.action.text).toContain("bun run ship");
  });

  test("the muted half is the body's first line, so two similar titles are told apart", () => {
    expect(rankNotes(NOTEBOOK, "arch")[0]?.detail).toBe("The engine owns every rule about a session.");
    // A heading marker is not content; a bodyless note still says what it is.
    expect(rankNotes([note("Setup", "# Getting started\nrun it")], "setup")[0]?.detail).toBe("Getting started");
    expect(rankNotes([note("Empty")], "empty")[0]?.detail).toBe("project note");
  });
});
