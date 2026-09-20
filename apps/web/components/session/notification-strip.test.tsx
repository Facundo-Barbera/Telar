/**
 * A NOTIFICATION TURN'S VERTICAL RHYTHM — issue #577.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * The owner's screenshot: "Session finished a turn", "A session sent a result",
 * "A session assigned work", each one line of text and each drawn as a message
 * block — a row 4px taller than the activity lane it sits in, and an EMPTY
 * assistant lane under every one that had not been answered yet. In his words:
 * "I don't like the line breaks from sessions results and that kinda things."
 *
 * ── MEASURED, on the real components with the app's own stylesheet ──────────
 * A notification row was 28px tall where the `4 steps · Ran command ×2` row
 * beside it is 24px, and a turn with no answer still paid 8px for the empty
 * lane and the gap above it — 12px of chrome on a 24px line.
 *
 * ── WHAT THESE PIN ──────────────────────────────────────────────────────────
 * That the row IS the lane's row rather than merely resembling it, and that the
 * answer area is drawn only when there is an answer. Pixel heights are not
 * available to a server render, so the first is pinned where it is actually
 * decided: one shared `ROW` constant, which neither side can pad alone.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotificationDetail } from "@telar/engine-client";
import { SessionTurn } from "../session-cockpit";
import { ActivityGroup, NotificationRow } from "../transcript";
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
