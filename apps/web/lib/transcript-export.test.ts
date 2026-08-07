// WHAT LEAVES THE MACHINE, PINNED. This file is the contract for a document a
// user forwards: narration never appears in it, a marker stays a marker rather
// than becoming the assistant's prose, and the filename is ASCII by
// construction because it lands inside a quoted Content-Disposition.

// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { chatToMarkdown, transcriptFilename, type TranscriptChat } from "./transcript-export";

const chat: TranscriptChat = {
  id: "0f3a-9c21",
  title: "Export the transcript",
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Read the store and summarize it." },
        {
          type: "attachments",
          files: [{ id: "a1", name: "notes.txt", mediaType: "text/plain", size: 12 }],
        },
      ],
    },
    {
      role: "assistant",
      parts: [
        { type: "thinking", text: "the user probably wants the Part union" },
        { type: "tool", name: "Read", input: { file_path: "apps/web/lib/store.ts" } },
        { type: "tool", name: "Bash", input: { command: "bun test  lib/store.test.ts" } },
        { type: "text", text: "chats.json is the source of truth." },
        { type: "marker", text: "agent finished · explore lib", attention: true },
      ],
    },
  ],
};

describe("chatToMarkdown", () => {
  test("renders the transcript as a document, in transcript order", () => {
    expect(chatToMarkdown(chat)).toBe(
      [
        "# Export the transcript",
        "",
        "## You",
        "",
        "Read the store and summarize it.",
        "",
        "Attachments: notes.txt",
        "",
        "## Assistant",
        "",
        "- Read `apps/web/lib/store.ts`",
        "- Bash `bun test lib/store.test.ts`",
        "",
        "chats.json is the source of truth.",
        "",
        "> agent finished · explore lib",
        "",
      ].join("\n"),
    );
  });

  test("narration never reaches the file", () => {
    expect(chatToMarkdown(chat)).not.toContain("the user probably wants");
  });

  test("a message left with nothing to show contributes no heading", () => {
    const only = { ...chat, messages: [{ role: "assistant" as const, parts: [{ type: "thinking" as const, text: "…" }] }] };
    expect(chatToMarkdown(only)).toBe("# Export the transcript\n");
  });

  test("a tool call with no salient argument still gets its line", () => {
    const bare = {
      ...chat,
      messages: [{ role: "assistant" as const, parts: [{ type: "tool" as const, name: "TodoWrite" }] }],
    };
    expect(chatToMarkdown(bare)).toContain("- TodoWrite\n");
  });

  test("a multi-line marker stays inside its quote", () => {
    const wrapped = {
      ...chat,
      messages: [
        { role: "assistant" as const, parts: [{ type: "marker" as const, text: "ultra failed · sweep\nno agents ran" }] },
      ],
    };
    expect(chatToMarkdown(wrapped)).toContain("> ultra failed · sweep\n> no agents ran");
  });
});

describe("transcriptFilename", () => {
  test("derives the name from the title, sanitized", () => {
    expect(transcriptFilename(chat)).toBe("export-the-transcript.md");
    expect(transcriptFilename({ id: "x", title: 'Fix "quoting"/paths: v2 ' })).toBe(
      "fix-quoting-paths-v2.md",
    );
  });

  test("a title with nothing ASCII in it falls back to the session id", () => {
    expect(transcriptFilename({ id: "0f3a-9c21", title: "🎉 🎉" })).toBe("0f3a-9c21.md");
  });
});
