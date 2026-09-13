/**
 * #354 — "ds_scratch ds_scratch".
 *
 * A row is a verb and its salient argument. An MCP or plugin tool call had no
 * argument the lane knew how to read, so both halves fell back to the tool's
 * name — twice on one line, where the first line of the cell's code belonged.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptItem } from "./transcript";
import type { JournalItem } from "@/lib/engine/journal";

const base = { runId: "run_1", sessionId: "session_1", startedAt: 1, streamedText: "", openedBy: 0 } as const;

const call = (name: string, input?: unknown, status: JournalItem["status"] = "completed"): JournalItem => ({
  ...base,
  id: "item_a",
  status,
  completedAt: 2,
  // The engine stores the display name as the row's title; that is the half
  // that was correct all along.
  title: name,
  detail: { type: "mcp_tool_call", call: { name, ...(input === undefined ? {} : { input }) } },
});

const render = (item: JournalItem) => renderToStaticMarkup(<TranscriptItem item={item} />);
/** Tags stripped, so "name name" is caught however the two spans are styled. */
const text = (item: JournalItem) => render(item).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("a tool row's argument", () => {
  test("the name is said once, and the code says the rest", () => {
    const html = text(call("ds_scratch", { code: "df = pd.read_csv(source)\ndf.describe()" }));
    expect(html).toContain("ds_scratch df = pd.read_csv(source)");
    // The second line stays behind the row's disclosure.
    expect(html).not.toContain("df.describe()");
    expect(html).not.toContain("ds_scratch ds_scratch");
  });

  test("a compile names the file it was handed", () => {
    expect(text(call("latex_compile", { path: "paper/main.tex" }))).toContain("latex_compile paper/main.tex");
  });

  test("a call with no readable input is the tool's name, once", () => {
    const html = text(call("ds_kernel"));
    expect(html).toContain("ds_kernel");
    expect(html).not.toContain("ds_kernel ds_kernel");
  });

  test("a running call shimmers the same one line", () => {
    const html = text(call("ds_scratch", { code: "plot(df)" }, "inProgress"));
    expect(html).toContain("ds_scratch · plot(df)");
  });
});
