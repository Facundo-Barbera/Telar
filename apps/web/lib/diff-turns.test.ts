/**
 * WHAT ONE TURN REPORTED WRITING — issue #694's third scope.
 *
 * A PURE FOLD over two lists, so none of this needs a repository or a
 * transcript. The cases worth pinning are the ones where the journal and git
 * would disagree, because that disagreement is the reason this scope is a
 * different witness and has to say so.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Item, Turn } from "@telar/engine-client";
import { diffTurns, turnFor, turnLabel } from "./diff-turns";

const item = (over: Partial<Item> & { runId: string; detail: Item["detail"] }): Item =>
  ({ id: `i${Math.random()}`, sessionId: "s", status: "completed", startedAt: 1_000, ...over }) as Item;

const wrote = (runId: string, path: string, over: Record<string, unknown> = {}, at = 1_000): Item =>
  item({ runId, startedAt: at, detail: { type: "file_change", change: { path, kind: "edit", ...over } } as Item["detail"] });

const turn = (runId: string, sequence: number, input: string): Turn =>
  ({ runId, sessionId: "s", sequence, state: "completed", input, origin: "user", createdAt: 1, updatedAt: 1 }) as unknown as Turn;

describe("the turns a diff can be scoped to", () => {
  test("only turns that reported writing something appear", () => {
    // A turn that read and reasoned and wrote nothing is ordinary, and a picker
    // full of them is a picker nobody can use.
    const turns = diffTurns([
      wrote("run_a", "src/a.ts"),
      item({ runId: "run_b", detail: { type: "file_read", read: { path: "src/b.ts" } } as Item["detail"] }),
    ]);
    expect(turns.map((entry) => entry.runId)).toEqual(["run_a"]);
  });

  test("newest first, because the question is what the agent JUST did", () => {
    const turns = diffTurns([wrote("run_old", "a.ts", {}, 1_000), wrote("run_new", "b.ts", {}, 5_000)]);
    expect(turns.map((entry) => entry.runId)).toEqual(["run_new", "run_old"]);
  });

  test("a declined or failed change never landed, so it is not counted", () => {
    // The same refusal `journalWrites` makes: counting either would claim the
    // turn edited a file it did not.
    const turns = diffTurns([
      item({ runId: "run_a", status: "declined", detail: { type: "file_change", change: { path: "a.ts", kind: "edit" } } as Item["detail"] }),
      item({ runId: "run_a", status: "failed", detail: { type: "file_change", change: { path: "b.ts", kind: "edit" } } as Item["detail"] }),
      wrote("run_a", "c.ts"),
    ]);
    expect(turns[0]!.files.map((file) => file.path)).toEqual(["c.ts"]);
  });

  test("a path written twice in one turn is one row, showing the LAST patch", () => {
    // Two rows for one file in one turn would be two answers to one question;
    // the turn's net result is what the reviewer is looking at.
    const turns = diffTurns([
      wrote("run_a", "a.ts", { unifiedDiff: "first" }, 1_000),
      wrote("run_a", "a.ts", { unifiedDiff: "second" }, 2_000),
    ]);
    expect(turns[0]!.files).toHaveLength(1);
    expect(turns[0]!.patches.get("a.ts")).toBe("second");
  });

  test("the journal's kinds arrive in git's vocabulary", () => {
    // One row component serves both witnesses, so the status letters have to
    // mean the same thing in every scope.
    const turns = diffTurns([
      wrote("run_a", "made.ts", { kind: "create" }),
      wrote("run_a", "gone.ts", { kind: "delete" }),
      wrote("run_a", "moved.ts", { kind: "rename", renamedFrom: "old.ts" }),
      wrote("run_a", "edited.ts", { kind: "edit" }),
    ]);
    const byPath = new Map(turns[0]!.files.map((file) => [file.path, file]));
    expect(byPath.get("made.ts")!.status).toBe("added");
    expect(byPath.get("gone.ts")!.status).toBe("deleted");
    expect(byPath.get("moved.ts")!.status).toBe("renamed");
    expect(byPath.get("moved.ts")!.renamedFrom).toBe("old.ts");
    expect(byPath.get("edited.ts")!.status).toBe("modified");
  });

  test("a rename with no previous name is modified, not a rename with an invented one", () => {
    const turns = diffTurns([wrote("run_a", "moved.ts", { kind: "rename" })]);
    expect(turns[0]!.files[0]!.status).toBe("modified");
    expect(turns[0]!.files[0]!.renamedFrom).toBeUndefined();
  });

  test("NOTHING maps to untracked — the journal has never looked at git's index", () => {
    const turns = diffTurns([wrote("run_a", "a.ts", { kind: "create" }), wrote("run_a", "b.ts", { kind: "edit" })]);
    expect(turns[0]!.files.map((file) => file.status)).not.toContain("untracked");
  });

  test("a path the tool wrote without a patch has a row and no patch", () => {
    // The row still belongs in the list — the turn did write it — and the
    // surface says so rather than drawing an empty diff.
    const turns = diffTurns([wrote("run_a", "a.ts")]);
    expect(turns[0]!.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(turns[0]!.patches.has("a.ts")).toBe(false);
  });

  test("the turn record supplies the number and the prompt; the journal alone does not", () => {
    // The journal says WHICH run wrote a file and nothing about why, so a fold
    // with no turn records still works and just cannot name them.
    const items = [wrote("run_a", "a.ts")];
    const unnamed = diffTurns(items)[0]!;
    expect(unnamed.sequence).toBeUndefined();
    expect(unnamed.input).toBeUndefined();
    expect(diffTurns(items, [turn("run_a", 3, "Fix the parser")])[0]).toMatchObject({ sequence: 3, input: "Fix the parser" });
  });
});

describe("naming and choosing a turn", () => {
  test("a named turn that is gone falls back to the newest rather than to nothing", () => {
    // A turn can genuinely disappear — the window slid past it, it was
    // discarded — and an empty surface with no explanation is the worse answer.
    const turns = diffTurns([wrote("run_new", "a.ts", {}, 5_000), wrote("run_old", "b.ts", {}, 1_000)]);
    expect(turnFor(turns, "run_missing")?.runId).toBe("run_new");
    expect(turnFor(turns, "run_old")?.runId).toBe("run_old");
    expect(turnFor(turns, undefined)?.runId).toBe("run_new");
    expect(turnFor([], "run_old")).toBeUndefined();
  });

  test("the label is the prompt's first line, cut to fit a menu row", () => {
    const turns = diffTurns([wrote("run_a", "a.ts")], [turn("run_a", 1, "  Fix the parser  \nand then the printer")]);
    expect(turnLabel(turns[0]!)).toBe("Fix the parser");
    const long = diffTurns([wrote("run_b", "a.ts")], [turn("run_b", 1, "x".repeat(200))]);
    expect(turnLabel(long[0]!)).toHaveLength(80);
    expect(turnLabel(long[0]!).endsWith("…")).toBe(true);
  });

  test("with no prompt it is the turn's number, and with neither it is still a label", () => {
    expect(turnLabel(diffTurns([wrote("run_a", "a.ts")], [turn("run_a", 4, "   ")])[0]!)).toBe("Turn 4");
    expect(turnLabel(diffTurns([wrote("run_a", "a.ts")])[0]!)).toBe("A turn");
  });
});
