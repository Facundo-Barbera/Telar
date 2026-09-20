/**
 * CONSECUTIVE ARRIVALS ARE ONE STRIP — issue #577.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * The owner's screenshot: "Session finished a turn", "A session sent a result",
 * "A session assigned work", each one line of text and each drawn as its own
 * turn — a `gap-8` turn gap above and below, a row 4px taller than the activity
 * lane it sits in, and an EMPTY assistant lane under every one that had not
 * been answered yet. Two wakes and a one-line reply took half the viewport. In
 * his words: "I don't like the line breaks from sessions results and that kinda
 * things."
 *
 * ── MEASURED, on the real components with the app's own stylesheet ──────────
 *   before: row 28px (the `4 steps · Ran command ×2` row beside it is 24px),
 *           40px of nothing between two of them, 192px for two wakes + a result
 *           + its one-line reply.
 *   after:  24px, 2px, 104px.
 * Those three numbers are the issue's three requirements: the row's own rhythm,
 * the gap between two of them, and what the run costs on screen.
 *
 * ── WHAT THESE PIN ──────────────────────────────────────────────────────────
 * The grouping rule, the emptiness rule that lets a strip BE tight, and the
 * row's rhythm against the step row it is meant to match. Pixel heights are not
 * available to a server render, so the last is pinned where it is actually
 * decided: one shared `ROW` constant, which neither side can pad alone.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotificationDetail } from "@telar/engine-client";
import { SessionTurn } from "../session-cockpit";
import { ActivityGroup, bareNotificationTurn, groupNotificationTurns, NotificationRow } from "../transcript";
import { ROW } from "../transcript-fold";
import type { JournalItem, JournalTurn } from "@/lib/engine/journal";

const WORKER = "session_worker123456";

const wakeDetail = (runId: string): NotificationDetail => ({
  kind: "wake",
  sessionId: WORKER,
  runId,
  wakeKind: "turn_completed",
  summary: `[wake: completed] Session ${WORKER} — turn ${runId} completed.`,
  fetch: { sessionId: WORKER, runId },
  body: `[wake: completed] Session ${WORKER} — turn ${runId} completed.`,
});

const peerDetail = (runId: string): NotificationDetail => ({
  kind: "peer_message",
  sessionId: WORKER,
  runId,
  intent: "result",
  summary: `[agent message · result] session ${WORKER} sent a result (run ${runId}, 5,793 chars).`,
  fetch: { sessionId: "session_host", runId },
  body: `[agent message · result] session ${WORKER} sent a result (run ${runId}, 5,793 chars).`,
});

const openingItem = (runId: string, notification: NotificationDetail): JournalItem => ({
  id: `notification_${runId}`,
  runId,
  sessionId: "session_host",
  status: "completed",
  startedAt: 1,
  completedAt: 1,
  streamedText: "",
  openedBy: 0,
  title: notification.summary,
  detail: { type: "notification", notification },
});

const command = (id: string, runId: string): JournalItem => ({
  id,
  runId,
  sessionId: "session_host",
  status: "completed",
  startedAt: 2,
  completedAt: 2,
  streamedText: "",
  openedBy: 1,
  detail: { type: "command_execution", command: { command: "bun test" }, output: "" } as JournalItem["detail"],
});

const turn = (over: Partial<JournalTurn> & Pick<JournalTurn, "runId">): JournalTurn => ({
  prompt: "",
  origin: "session",
  state: "completed",
  resultText: "",
  items: [],
  tasks: [],
  ...over,
});

/** A wake the engine queued behind the work in flight: a row, and nothing yet. */
const wakeTurn = (runId: string, over: Partial<JournalTurn> = {}): JournalTurn =>
  turn({ runId, prompt: "[notification: wake · turn_completed]", notification: wakeDetail(`child_${runId}`), items: [openingItem(runId, wakeDetail(`child_${runId}`))], ...over });

const render = (subject: JournalTurn, live = false) =>
  renderToStaticMarkup(<SessionTurn turn={subject} requests={[]} sending={false} live={live} onDecide={() => {}} onRetry={() => {}} />);

const ids = (groups: readonly (readonly JournalTurn[])[]) => groups.map((group) => group.map((member) => member.runId));

describe("two consecutive notifications are one group", () => {
  test("two queued wakes group; the turn that answered ends the run", () => {
    const groups = groupNotificationTurns([
      wakeTurn("run_1"),
      wakeTurn("run_2"),
      // A peer's result this session actually answered. Its ROW joins the strip
      // — it is an arrival like the others — and the run stops after it, so the
      // reply hangs under the block rather than inside it.
      turn({ runId: "run_3", prompt: "Three commits landed.", sender: { sessionId: WORKER }, notification: peerDetail("run_3"), items: [openingItem("run_3", peerDetail("run_3"))], resultText: "Noted." }),
      wakeTurn("run_4"),
    ]);
    expect(ids(groups)).toEqual([["run_1", "run_2", "run_3"], ["run_4"]]);
  });

  test("A GROUP OF ONE IS ONE LINE, and every turn comes back exactly once, in order", () => {
    const typed = turn({ runId: "run_typed", origin: "user", prompt: "look at the failing test", resultText: "Looking." });
    expect(ids(groupNotificationTurns([typed, wakeTurn("run_1"), typed, wakeTurn("run_2")]))).toEqual([["run_typed"], ["run_1"], ["run_typed"], ["run_2"]]);
  });

  test("a turn with something UNDER its row ends the run, because a strip would hide it", () => {
    // Each of these draws a line beneath the notification. A block that
    // swallowed one would be tightening the transcript by deleting from it.
    expect(bareNotificationTurn(wakeTurn("run_1"))).toBe(true);
    expect(bareNotificationTurn(wakeTurn("run_1", { resultText: "Nothing to do." }))).toBe(false);
    expect(bareNotificationTurn(wakeTurn("run_1", { usage: { tokens: { input: 10, output: 2 } } as JournalTurn["usage"] }))).toBe(false);
    expect(bareNotificationTurn(wakeTurn("run_1", { failure: "the provider hung up" }))).toBe(false);
    expect(bareNotificationTurn(wakeTurn("run_1", { state: "stopped" }))).toBe(false);
    expect(bareNotificationTurn({ ...wakeTurn("run_1"), items: [openingItem("run_1", wakeDetail("child_run_1")), command("cmd_1", "run_1")] })).toBe(false);
    // Not an arrival at all: a person's turn is never a strip's member.
    expect(bareNotificationTurn(turn({ runId: "run_typed", origin: "user", prompt: "hi" }))).toBe(false);
  });

  test("the LIVE turn is never a strip's middle — its working indicator hangs under its row", () => {
    expect(ids(groupNotificationTurns([wakeTurn("run_live"), wakeTurn("run_next")], "run_live"))).toEqual([["run_live"], ["run_next"]]);
  });
});

describe("a notification turn's vertical rhythm", () => {
  test("no answer area under a turn that produced no text", () => {
    const html = render(wakeTurn("run_1"));
    expect(html).toContain('aria-label="Notification"');
    // The assistant's lane is what `data-role="assistant"` marks. One of them —
    // the notification row's own — and not a second, empty one beneath it.
    expect(html.match(/data-role="assistant"/g)).toHaveLength(1);
  });

  test("and the lane comes back the moment there is anything to put in it", () => {
    expect(render(wakeTurn("run_1", { resultText: "Noted." })).match(/data-role="assistant"/g)).toHaveLength(2);
    expect(render(wakeTurn("run_1"), true).match(/data-role="assistant"/g)).toHaveLength(2);
    expect(render(wakeTurn("run_1", { state: "failed", failure: "the provider hung up" })).match(/data-role="assistant"/g)).toHaveLength(2);
    expect(render(wakeTurn("run_1", { usage: { tokens: { input: 10, output: 2 } } as JournalTurn["usage"] })).match(/data-role="assistant"/g)).toHaveLength(2);
  });

  test("the row wears the STEP LANE's class, so neither can gain padding alone", () => {
    const notification = renderToStaticMarkup(<NotificationRow detail={wakeDetail("run_a")} />);
    const step = renderToStaticMarkup(<ActivityGroup items={[command("cmd_1", "run_x"), command("cmd_2", "run_x")]} tasks={[]} live={false} />);
    // The notification row IS the lane's row, verbatim.
    expect(notification).toContain(ROW);
    // The step fold re-aligns its chevron (`items-start`, for a tally that
    // wraps) and nothing else, so the tokens that SET THE HEIGHT are shared.
    for (const token of ["px-1.5", "py-1", "text-xs", "rounded-md", "gap-1.5"]) {
      expect(notification).toContain(token);
      expect(step).toContain(token);
    }
    // THE WRAPPER'S `py-0.5` IS THE 4px THE ISSUE IS ABOUT. A row 4px taller
    // than the lane it sits in is the bubble rhythm this was meant to shed.
    expect(notification).not.toContain("py-0.5");
  });
});

describe("the reply keeps the paragraph gap, not the turn gap", () => {
  test("a notification followed by its own prose is one turn, gap-2 apart", () => {
    const html = render(turn({
      runId: "run_3",
      prompt: "Three commits landed.",
      sender: { sessionId: WORKER },
      notification: peerDetail("run_3"),
      items: [openingItem("run_3", peerDetail("run_3"))],
      resultText: "Noted — I will fold that into the release notes.",
    }));
    // The row and the answer are siblings of ONE turn: the gap between them is
    // the turn's own `gap-2`, never the lane's `gap-8`.
    expect(html).toContain("flex flex-col gap-2");
    expect(html).not.toContain("gap-8");
    expect(html.indexOf('aria-label="Notification"')).toBeLessThan(html.indexOf("Noted — I will fold"));
  });
});
