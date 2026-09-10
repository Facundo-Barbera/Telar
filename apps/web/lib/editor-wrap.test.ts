/**
 * The wrap preference and what it applies to. The invariant worth pinning is
 * that this is PRESENTATION: the two class constants differ only in how text
 * is drawn, and nothing here can reach a file's contents.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { fileKind } from "./file-kinds";
import { isProseFile, isProsePath, NOWRAP_CLASS, readWrapLines, WRAP_CLASS, writeWrapLines } from "./editor-wrap";

const store = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    read: () => map.get("telar:editor-wrap"),
  };
};

describe("which files the toggle is offered for", () => {
  test("prose: markdown, its named variants, and plain text", () => {
    for (const path of ["notes.md", "README.md", "AGENTS.md", "CLAUDE.md", "notes.txt"]) {
      expect(isProsePath(path), path).toBe(true);
    }
  });

  test("code keeps its horizontal scroll — the user asked for an option on prose", () => {
    for (const path of ["main.ts", "app.tsx", "server.py", "style.css", "data.json", "Cargo.toml"]) {
      expect(isProsePath(path), path).toBe(false);
    }
  });

  test("classification comes from the existing file-kind table, not a second list", () => {
    // If `md` ever stops being a `doc`, this test moves with it rather than
    // silently disagreeing with the icon beside the filename.
    expect(isProseFile(fileKind("notes.md"))).toBe(true);
    expect(fileKind("notes.md").glyph).toBe("doc");
    expect(fileKind("notes.txt").glyph).toBe("text");
  });

  test("a binary or table file is never prose", () => {
    for (const path of ["photo.png", "data.csv", "book.pdf", "notebook.ipynb"]) {
      expect(isProsePath(path), path).toBe(false);
    }
  });
});

describe("the stored preference", () => {
  test("absent means off — the option adds a behaviour, it does not change one", () => {
    expect(readWrapLines(store())).toBe(false);
  });

  test("round-trips, and only '1' counts as on", () => {
    const backing = store();
    writeWrapLines(true, backing);
    expect(backing.read()).toBe("1");
    expect(readWrapLines(backing)).toBe(true);
    writeWrapLines(false, backing);
    expect(backing.read()).toBe("0");
    expect(readWrapLines(backing)).toBe(false);
    expect(readWrapLines(store({ "telar:editor-wrap": "yes" }))).toBe(false);
  });

  test("a storage that throws degrades to the default rather than breaking the editor", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readWrapLines(hostile)).toBe(false);
    expect(() => writeWrapLines(true, hostile)).not.toThrow();
  });
});

describe("the two layers are drawn the same way", () => {
  test("wrapping differs only in how text is laid out — never in what it says", () => {
    // Both constants are whitespace/overflow rules. Nothing here inserts a
    // newline, and the saver writes the draft either way.
    expect(NOWRAP_CLASS).toBe("whitespace-pre");
    expect(WRAP_CLASS).toContain("whitespace-pre-wrap");
    // A single unbroken token must not reintroduce the overflow the toggle
    // exists to remove.
    expect(WRAP_CLASS).toContain("break-words");
    for (const rule of [WRAP_CLASS, NOWRAP_CLASS]) {
      expect(rule).not.toContain("\\n");
    }
  });
});
