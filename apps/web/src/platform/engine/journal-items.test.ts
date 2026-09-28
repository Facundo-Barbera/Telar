// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { item, turn } from "@/test/journal-fixtures";
import { projectJournal } from "./journal";
import { isCompacting, isToolItem, itemLabel, toolOutput } from "./journal-items";

describe("item rendering helpers", () => {
  test("tool rows are classified as tools and prose is not", () => {
    const command = item({ id: "c", detail: { type: "command_execution", command: { command: "ls -la" } } });
    const message = item({ id: "m", detail: { type: "assistant_message", text: "hi" } });
    const [projected] = projectJournal([turn], [command, message], []);
    const [tool, prose] = projected!.items;
    expect(isToolItem(tool!)).toBe(true);
    expect(isToolItem(prose!)).toBe(false);
  });

  test("labels prefer the engine-stored title over a derived one", () => {
    const [projected] = projectJournal(
      [turn],
      [item({ id: "c", title: "engine label", detail: { type: "command_execution", command: { command: "ls" } } })],
      [],
    );
    expect(itemLabel(projected!.items[0]!)).toBe("engine label");
  });

  test("a label is still derived when the engine stored none", () => {
    const [projected] = projectJournal(
      [turn],
      [item({ id: "f", detail: { type: "file_change", change: { path: "src/a.ts", kind: "edit" } } })],
      [],
    );
    expect(itemLabel(projected!.items[0]!)).toBe("src/a.ts");
  });

  test("command output is exposed for the collapsed body", () => {
    const [projected] = projectJournal(
      [turn],
      [item({ id: "c", status: "completed", detail: { type: "command_execution", command: { command: "ls", outputPreview: "a\nb" } } })],
      [],
    );
    expect(toolOutput(projected!.items[0]!)).toBe("a\nb");
  });
});

describe("isCompacting", () => {
  test("true exactly while a context_compaction row is open", () => {
    const during = projectJournal(
      [turn],
      [item({ id: "cc", detail: { type: "context_compaction" } })],
      [],
    )[0];
    expect(isCompacting(during)).toBe(true);
    const after = projectJournal(
      [turn],
      [item({ id: "cc", status: "completed", detail: { type: "context_compaction", preTokens: 9, postTokens: 3 } })],
      [],
    )[0];
    expect(isCompacting(after)).toBe(false);
    expect(isCompacting(undefined)).toBe(false);
  });
});
