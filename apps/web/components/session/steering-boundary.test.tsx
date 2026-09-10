/**
 * STEERING A RUNNING TURN MUST NOT TURN THE ANSWER INTO A TOOL STEP.
 *
 * Reported against packaged Dev c4882d80: typing while the assistant was
 * mid-sentence swept the half-written reply into a collapsed "N steps" fold
 * ABOVE the message, where it went on streaming out of sight. The cause was
 * the response CLOSED by the steer being drawn as one `ActivityGroup` while
 * every other response was cut at its seams — so prose stayed prose only
 * until somebody interrupted.
 *
 * These render the real `SessionTurn`. A collapsed run omits its rows from the
 * DOM entirely, so "the text is in the markup" IS "the reader can see it".
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTurn } from "../session-cockpit";
import type { JournalItem, JournalTurn } from "@/lib/engine/journal";

const base = { runId: "run_1", sessionId: "session_1", startedAt: 1, streamedText: "", openedBy: 0 } as const;

/** Prose the model is still writing: no stored text, a streamed prefix. */
const streaming = (id: string, text: string): JournalItem => ({
  ...base,
  id,
  status: "inProgress",
  streamedText: text,
  detail: { type: "assistant_message", text: "" },
});

const settledProse = (id: string, text: string): JournalItem => ({
  ...base,
  id,
  status: "completed",
  completedAt: 2,
  detail: { type: "assistant_message", text },
});

const steer = (id: string, text: string): JournalItem => ({
  ...base,
  id,
  status: "completed",
  completedAt: 2,
  detail: { type: "user_message", text },
});

const command = (id: string, cmd: string): JournalItem => ({
  ...base,
  id,
  status: "completed",
  completedAt: 2,
  detail: { type: "command_execution", command: { command: cmd }, output: "" } as JournalItem["detail"],
});

const turn = (items: JournalItem[], state: JournalTurn["state"] = "running"): JournalTurn => ({
  runId: "run_1",
  origin: "user",
  prompt: "Explain the pacing change",
  state,
  resultText: "",
  items,
  tasks: [],
});

const render = (items: JournalItem[], live = true, state: JournalTurn["state"] = "running") =>
  renderToStaticMarkup(
    <SessionTurn turn={turn(items, state)} requests={[]} sending={false} live={live} now={3} onDecide={() => {}} onRetry={() => {}} />,
  );

describe("a steer arriving mid-sentence", () => {
  test("the streaming reply stays visible as assistant text, not a collapsed step", () => {
    const html = render([streaming("item_a", "The pacer now tracks the arrival"), steer("item_b", "actually, hold on")]);
    // The half-written answer is on screen…
    expect(html).toContain("The pacer now tracks the arrival");
    // …and the steer that interrupted it is too.
    expect(html).toContain("actually, hold on");
    // Prose is never counted as work: a lone assistant message is a seam, so
    // no fold is drawn over it at all.
    expect(html).not.toContain("1 step");
  });

  test("the message is drawn AFTER the text it interrupted", () => {
    const html = render([streaming("item_a", "Half a sentence"), steer("item_b", "stop there")]);
    expect(html.indexOf("Half a sentence")).toBeLessThan(html.indexOf("stop there"));
  });

  test("real work before the steer still folds — only prose is exempt", () => {
    const html = render([
      command("item_cmd", "bun test"),
      streaming("item_a", "Tests pass, so the next thing is"),
      steer("item_b", "skip that"),
    ]);
    expect(html).toContain("Tests pass, so the next thing is");
    expect(html).toContain("1 step"); // the command, folded on its own
    expect(html).toContain("skip that");
  });

  test("two steers keep every reply visible, each above the message that cut it", () => {
    const html = render([
      streaming("item_a", "First partial answer"),
      steer("item_b", "one more thing"),
      settledProse("item_c", "Second answer"),
      steer("item_d", "and another"),
      streaming("item_e", "Third answer so far"),
    ]);
    for (const text of ["First partial answer", "one more thing", "Second answer", "and another", "Third answer so far"]) {
      expect(html).toContain(text);
    }
    // Order is the order it happened in, boundary after the work it cut.
    const at = (text: string) => html.indexOf(text);
    expect(at("First partial answer")).toBeLessThan(at("one more thing"));
    expect(at("one more thing")).toBeLessThan(at("Second answer"));
    expect(at("Second answer")).toBeLessThan(at("and another"));
    expect(at("and another")).toBeLessThan(at("Third answer so far"));
  });

  test("a reload agrees with what was on screen while it ran", () => {
    // The same items, settled: live and history must not disagree about
    // whether the interrupted reply exists.
    const items = [settledProse("item_a", "Interrupted reply"), steer("item_b", "changed my mind"), settledProse("item_c", "Final reply")];
    const liveHtml = render(items, true);
    const settledHtml = render(items, false, "completed");
    for (const html of [liveHtml, settledHtml]) {
      expect(html).toContain("Interrupted reply");
      expect(html).toContain("changed my mind");
      expect(html).toContain("Final reply");
    }
  });

  test("an unsteered turn is unchanged — one response, prose visible", () => {
    const html = render([command("item_cmd", "bun test"), streaming("item_a", "Here is what I found")]);
    expect(html).toContain("Here is what I found");
  });
});
