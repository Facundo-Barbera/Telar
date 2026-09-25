/**
 * A THOUGHT WHOSE TEXT WAS WITHHELD.
 *
 * Claude Code in Telar mode sends no thinking text — only a running token
 * estimate. The row used to render nothing for empty text, so a six-minute
 * thought was a blank transcript under a "no output" clock.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityGroup, TranscriptItem } from "./transcript";
import type { JournalItem } from "@/lib/engine/journal";

const base = { id: "item_r", runId: "run_1", sessionId: "session_1", startedAt: 1, streamedText: "", openedBy: 0 } as const;

const thought = (status: JournalItem["status"], estimatedTokens?: number, text = ""): JournalItem => ({
  ...base,
  status,
  ...(status === "inProgress" ? {} : { completedAt: 2 }),
  detail: { type: "reasoning", text, ...(estimatedTokens === undefined ? {} : { estimatedTokens }) },
});

const text = (item: JournalItem) =>
  renderToStaticMarkup(<TranscriptItem item={item} />).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("a reasoning row with no text", () => {
  test("running with a count says how far it has got", () => {
    expect(text(thought("inProgress", 12_345))).toContain("Thinking · ~12.3k tokens");
  });

  test("running with no count yet still says it is thinking", () => {
    expect(text(thought("inProgress"))).toContain("Thinking…");
  });

  test("settled with a count says how long it was, and offers nothing to open", () => {
    const html = renderToStaticMarkup(<TranscriptItem item={thought("completed", 44_000)} />);
    expect(text(thought("completed", 44_000))).toContain("Thought · 44.0k tokens");
    expect(html).not.toContain("aria-expanded");
  });

  test("settled with neither text nor count still paints nothing", () => {
    expect(renderToStaticMarkup(<TranscriptItem item={thought("completed")} />)).toBe("");
  });

  test("a thought with text keeps its disclosure", () => {
    expect(renderToStaticMarkup(<TranscriptItem item={thought("completed", 900, "hmm")} />)).toContain("aria-expanded");
  });

  test("the run's row filter keeps it, live and settled", () => {
    const group = (item: JournalItem, live: boolean) =>
      renderToStaticMarkup(<ActivityGroup items={[item]} live={live} tasks={[]} />).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(group(thought("inProgress", 1_200), true)).toContain("Thinking · ~1.2k tokens");
    expect(group(thought("completed", 44_000), false)).toContain("Thought · 44.0k tokens");
  });
});
