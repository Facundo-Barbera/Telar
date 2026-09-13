/**
 * #354 — A COLLAPSED RUN'S SUMMARY IS THE ONLY THING SAID ABOUT IT.
 *
 * At panel width "27 steps · Said ×3 · ds_inspect · ds_kernel · ds_scratch ×5 ·
 * Ran command ×4 · …" ended in an ellipsis, and what the ellipsis ate was the
 * tail — the tool names and the commands, the part a reader scans a fold for.
 * The generic head survived because it was first.
 *
 * The clipping was CSS, not text: the whole tally has always been in the
 * markup. So these assert both halves of the fix — that the sentence is
 * complete, and that the element is allowed two lines to say it in.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityGroup, tallyParts } from "./transcript";
import type { JournalItem } from "@/lib/engine/journal";

const base = { runId: "run_1", sessionId: "session_1", startedAt: 1, streamedText: "", openedBy: 0 } as const;

const said = (id: string): JournalItem => ({ ...base, id, status: "completed", completedAt: 2, detail: { type: "assistant_message", text: "…" } });
const ran = (id: string, command: string): JournalItem => ({ ...base, id, status: "completed", completedAt: 2, detail: { type: "command_execution", command: { command } } });
const tool = (id: string, name: string): JournalItem => ({ ...base, id, status: "completed", completedAt: 2, title: name, detail: { type: "mcp_tool_call", call: { name } } });
const edited = (id: string, path: string): JournalItem => ({ ...base, id, status: "completed", completedAt: 2, detail: { type: "file_change", change: { path, kind: "edit" } } });

/** The turn from the report: prose, three data-science tools, commands, an
 *  edit at the end — long enough that one line cannot hold it. */
const busyRun: JournalItem[] = [
  said("a1"),
  said("a2"),
  said("a3"),
  tool("b1", "ds_inspect"),
  tool("b2", "ds_kernel"),
  ...Array.from({ length: 5 }, (_, index) => tool(`c${index}`, "ds_scratch")),
  ...Array.from({ length: 4 }, (_, index) => ran(`d${index}`, "bun test")),
  edited("e1", "notebook.py"),
];

const html = renderToStaticMarkup(<ActivityGroup items={busyRun} tasks={[]} live={false} />);

describe("the summary of a folded run", () => {
  test("says the whole tally, tail included", () => {
    expect(html).toContain("15 steps");
    expect(html).toContain("Said ×3 · ds_inspect · ds_kernel · ds_scratch ×5 · Ran command ×4 · Edited file");
  });

  test("is given two lines rather than one truncated one", () => {
    expect(html).toContain("line-clamp-2");
    expect(html).not.toContain("min-w-0 truncate text-muted-foreground/80");
  });

  test("counts in first-appearance order, so the shape of the turn survives", () => {
    // What the agent reached for first stays first: the tally is a summary of
    // a sequence, and re-sorting it would describe a turn that never happened.
    expect(tallyParts(busyRun)).toEqual(["Said ×3", "ds_inspect", "ds_kernel", "ds_scratch ×5", "Ran command ×4", "Edited file"]);
  });
});
