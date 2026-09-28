import { describe, expect, test } from "bun:test";
import { limitTitleMessage, titleContext, type TitleMessage } from "./title-context";

describe("limitTitleMessage", () => {
  test("keeps a short message whole", () => {
    expect(limitTitleMessage("fix the rail", 100)).toBe("fix the rail");
  });

  test("keeps the head and the tail of a long one, within budget", () => {
    const text = `START ${"x".repeat(5_000)} END`;
    const limited = limitTitleMessage(text, 200);
    expect(limited.length).toBeLessThanOrEqual(200);
    expect(limited.startsWith("START")).toBe(true);
    expect(limited.endsWith("END")).toBe(true);
    expect(limited).toContain("[Content truncated]");
  });
});

describe("titleContext", () => {
  test("a short conversation is carried whole, in order, without reasoning or system items", () => {
    const messages: TitleMessage[] = [
      { role: "system", text: "orientation" },
      { role: "user", text: "Why does the rail flicker?" },
      { role: "reasoning", text: "thinking about sorting" },
      { role: "assistant", text: "The list re-sorts twice on settle." },
      { role: "user", text: "Make the settle animation smooth." },
    ];
    expect(titleContext(messages)).toBe(
      "USER:\nWhy does the rail flicker?\n\nASSISTANT:\nThe list re-sorts twice on settle.\n\nUSER:\nMake the settle animation smooth.",
    );
  });

  test("a long conversation stays under 8k and keeps the first and latest user messages", () => {
    const messages: TitleMessage[] = [
      { role: "user", text: `FIRST ${"a".repeat(3_000)}` },
      ...Array.from({ length: 12 }, (_, index): TitleMessage[] => [
        { role: "assistant", text: `answer ${index} ${"b".repeat(3_000)}` },
        { role: "user", text: `follow-up ${index} ${"c".repeat(500)}` },
      ]).flat(),
      { role: "assistant", text: `LAST ANSWER ${"d".repeat(4_000)}` },
      { role: "user", text: "LATEST ask" },
    ];
    const context = titleContext(messages);
    expect(context.length).toBeLessThanOrEqual(8_000);
    expect(context.startsWith("[Earlier content truncated]")).toBe(true);
    expect(context).toContain("USER:\nFIRST");
    expect(context).toContain("USER:\nLATEST ask");
    expect(context.indexOf("FIRST")).toBeLessThan(context.indexOf("LATEST ask"));
    expect(context).toContain("ASSISTANT:\nLAST ANSWER");
  });

  test("assistant output never evicts the user's messages", () => {
    const messages: TitleMessage[] = [
      { role: "user", text: "first ask" },
      ...Array.from({ length: 6 }, (): TitleMessage => ({ role: "assistant", text: "z".repeat(5_000) })),
      { role: "user", text: "second ask" },
    ];
    const context = titleContext(messages);
    expect(context).toContain("first ask");
    expect(context).toContain("second ask");
  });

  test("nothing to title is an empty context", () => {
    expect(titleContext([{ role: "reasoning", text: "hm" }, { role: "user", text: "   " }])).toBe("");
  });
});
