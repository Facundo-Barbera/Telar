/**
 * #569 — THE AGENT'S TOOL CALLS FOLD INTO STEPS, like every other transcript's.
 *
 * WHAT THIS WOULD HAVE CAUGHT is what the owner's screenshot showed: a turn with
 * twelve calls drawn as twelve flat lines, one per row, filling the screen with
 * the machinery of an answer instead of the answer. The activity lane has had two
 * rules for this since #206 and the Agent's conversation read neither, because
 * the fold lived in a file that could only be handed a session's `JournalItem`.
 *
 * THE CLAIMS ARE THE TWO RULES AND THE ONE EXCLUSION:
 *
 *   2. a LIVE run shows its newest step behind `+N earlier steps` — the step the
 *      Agent is on is the one thing somebody watching it work is watching for;
 *   3. a SETTLED run folds behind `N steps · <tally>`;
 *   and NOTHING THAT IS NOT WORK FOLDS. Prose, the person's own message, a wake
 *   and a failed turn are seams: a fold that swallowed one would hide the
 *   sentence the work was an answer to.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentTranscript, agentTallyParts, segmentAgentItems } from "./agent-transcript";
import type { AgentItem } from "@/lib/agent/thread";

let next = 0;
const tool = (name: string, over: Partial<Extract<AgentItem, { kind: "tool" }>> = {}): AgentItem => ({
  kind: "tool",
  id: (next += 1),
  at: next,
  runId: "run_1",
  name,
  input: {},
  output: "rows",
  status: "completed",
  ...over,
});
const said = (text: string): AgentItem => ({ kind: "assistant", id: (next += 1), at: next, runId: "run_1", text });
const asked = (text: string): AgentItem => ({ kind: "user", id: (next += 1), at: next, runId: "run_1", text });

/** The turn from the report: one sentence, then a dozen reads. */
const busy: AgentItem[] = [
  asked("what is happening?"),
  said("Let me look."),
  ...Array.from({ length: 12 }, () => tool("sessions_read")),
  tool("notes_list"),
  tool("sessions_find"),
];

describe("a settled run of tool calls", () => {
  const markup = renderToStaticMarkup(<AgentTranscript items={busy} />);

  test("is one line saying how many steps and what they were", () => {
    expect(markup).toContain("14 steps");
    expect(markup).toContain("sessions_read ×12 · notes_list · sessions_find");
  });

  test("and the calls themselves are behind it, not on the screen", () => {
    // Fourteen mono rows is what the fold exists to remove. The tally names the
    // tool once; the rows that name it twelve times are collapsed.
    expect(markup.match(/sessions_read/g)).toHaveLength(1);
  });

  test("counts in first-appearance order, so the shape of the turn survives", () => {
    expect(agentTallyParts(busy.filter((item) => item.kind === "tool") as never)).toEqual([
      "sessions_read ×12",
      "notes_list",
      "sessions_find",
    ]);
  });
});

describe("a live run of tool calls", () => {
  const markup = renderToStaticMarkup(<AgentTranscript items={busy} running />);

  test("keeps the step the Agent is on, and hides the rest behind a count", () => {
    expect(markup).toContain("+13 earlier steps");
    // The newest call is the visible one — an agent thirteen reads into a sweep
    // must not be a screen that says only "14 steps".
    expect(markup).toContain("sessions_find");
    expect(markup).not.toContain("14 steps");
  });

  test("a run of one hides nothing: there is no window to draw", () => {
    const one = renderToStaticMarkup(<AgentTranscript items={[said("Looking."), tool("sessions_list")]} running />);
    expect(one).toContain("sessions_list");
    expect(one).not.toContain("earlier step");
  });
});

describe("a failure inside the fold survives it", () => {
  test("the collapsed line says how many went wrong, not merely that something did", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscript items={[tool("sessions_read"), tool("sessions_send", { status: "failed" }), tool("notes_list")]} />,
    );
    expect(markup).toContain("3 steps");
    expect(markup).toContain("1 failed");
  });
});

describe("what never folds", () => {
  test("prose, the person's message and a failed turn are rows of their own", () => {
    const items: AgentItem[] = [
      asked("do the thing"),
      said("Doing it."),
      tool("sessions_read"),
      said("Done."),
      { kind: "failure", id: 900, at: 900, runId: "run_1", status: "failed", message: "the model refused" },
    ];
    const markup = renderToStaticMarkup(<AgentTranscript items={items} />);
    for (const visible of ["do the thing", "Doing it.", "Done.", "the model refused"]) {
      expect(markup).toContain(visible);
    }
  });

  test("the segmenter says the same thing: only tool calls join a run", () => {
    const items: AgentItem[] = [asked("go"), tool("a"), tool("b"), said("hm"), tool("c")];
    expect(segmentAgentItems(items).map((segment) => (segment.kind === "run" ? segment.items.length : segment.item.kind))).toEqual([
      "user",
      2,
      "assistant",
      1,
    ]);
  });

  test("a sentence between two runs closes the first — so only the LAST is a live window", () => {
    // Otherwise a turn that narrated half way through would keep a rolling
    // window over work it had already moved past, and the fold would never
    // settle while the turn ran.
    const items: AgentItem[] = [tool("a"), tool("b"), said("half way"), tool("c"), tool("d")];
    const markup = renderToStaticMarkup(<AgentTranscript items={items} running />);
    expect(markup).toContain("2 steps");
    expect(markup).toContain("+1 earlier step");
  });
});
