/**
 * ONE ARRIVAL DRAWS ONE NOTIFICATION ROW — issue #590.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * The owner watched one `sessions_send` paint two rows, one above the other,
 * differing only in their trailing text; and a coordinator's transcript paint
 * FOUR identical "Session finished a turn" lines for two wakes.
 *
 * Both are the same defect. An arrival that opens a turn is stored on the TURN
 * and on the turn's first ITEM on purpose (`notification.ts`), and the cockpit
 * drew both: `turn.notification` as the turn's header, and the
 * `notification_${runId}` item as a row inside the turn. For a peer's message
 * the two at least differed — the header is passed `turn.prompt`, the item row
 * falls back to the engine's summary — and for a WAKE, which has no message on
 * either side, they rendered the identical string.
 *
 * ── WHAT THESE PIN ──────────────────────────────────────────────────────────
 * That the header survives and the item row goes, keyed on the item's id; and
 * that a notification which landed MID-turn, which has no header of its own,
 * still draws. These render the real `SessionTurn`, so the count is the count a
 * reader sees.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotificationDetail } from "@telar/engine-client";
import { SessionTurn } from "../session-cockpit";
import { withoutOpeningNotification } from "../transcript";
import type { JournalItem, JournalTurn } from "@/lib/engine/journal";

const WORKER = "session_worker123456";

const peerDetail = (runId: string): NotificationDetail => ({
  kind: "peer_message",
  sessionId: WORKER,
  runId,
  intent: "task",
  summary: `[agent message · task] session ${WORKER} ASSIGNED this session work (run ${runId}, 2,431 chars).`,
  fetch: { sessionId: "session_host", runId },
  body: `[agent message · task] session ${WORKER} ASSIGNED this session work (run ${runId}, 2,431 chars).`,
});

const wakeDetail = (runId: string): NotificationDetail => ({
  kind: "wake",
  sessionId: WORKER,
  runId,
  wakeKind: "turn_completed",
  summary: `[wake: completed] Session ${WORKER} — turn ${runId} completed.`,
  fetch: { sessionId: WORKER, runId },
  body: `[wake: completed] Session ${WORKER} — turn ${runId} completed.`,
});

/** The row the engine writes at accept, with the id it mints from the run. */
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

/** One that landed mid-turn: the driver's seam wrote it, under an id of its
 *  own, and no turn header announces it. */
const steeredItem = (id: string, runId: string, notification: NotificationDetail): JournalItem => ({
  ...openingItem(runId, notification),
  id,
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

const render = (subject: JournalTurn) =>
  renderToStaticMarkup(<SessionTurn turn={subject} requests={[]} sending={false} live={false} onDecide={() => {}} onRetry={() => {}} />);

const rows = (html: string) => html.match(/aria-label="Notification"/g)?.length ?? 0;

describe("a turn opened by a notification", () => {
  test("a peer's message draws ONE row, and it is the one carrying the message head", () => {
    const detail = peerDetail("run_1");
    const html = render(
      turn({
        runId: "run_1",
        prompt: "Build issue #590 — one arrival should draw one notification row.",
        sender: { sessionId: WORKER },
        agentIntent: "task",
        notification: detail,
        items: [openingItem("run_1", detail), command("cmd_1", "run_1")],
      }),
    );
    expect(rows(html)).toBe(1);
    // THE ONE THAT STAYS IS THE BETTER OF THE TWO: what was actually sent, not
    // the head of the engine's envelope about it.
    expect(html).toContain("Build issue #590");
    expect(html).not.toContain("ASSIGNED this session work");
    expect(html).toContain("A session assigned work");
  });

  test("a WAKE draws ONE row — the case where the two were indistinguishable", () => {
    const detail = wakeDetail("run_child");
    const html = render(
      turn({ runId: "run_1", prompt: "[notification: wake · turn_completed]", notification: detail, items: [openingItem("run_1", detail)] }),
    );
    expect(rows(html)).toBe(1);
    expect(html).toContain("Session finished a turn");
  });

  test("TWO consecutive wakes from one session draw TWO rows, not four", () => {
    // The owner's screenshot: a worker that failed twice, four identical lines
    // in two pairs.
    const html = ["run_h1", "run_h2"]
      .map((runId, index) => {
        const detail = wakeDetail(`run_child${index + 1}`);
        return render(turn({ runId, prompt: "[notification: wake · turn_completed]", notification: detail, items: [openingItem(runId, detail)] }));
      })
      .join("");
    expect(rows(html)).toBe(2);
  });

  test("a notification that landed MID-turn keeps its row — that is what the item row is for", () => {
    const mid = wakeDetail("run_other");
    const html = render(turn({ runId: "run_1", origin: "user", prompt: "look at the failing test", items: [command("cmd_1", "run_1"), steeredItem("item_mid", "run_1", mid)] }));
    expect(rows(html)).toBe(1);
  });

  test("an opening arrival AND a later mid-turn one draw TWO rows, because that is two arrivals", () => {
    const opening = peerDetail("run_1");
    const mid = wakeDetail("run_other");
    const html = render(
      turn({
        runId: "run_1",
        prompt: "Build issue #590 — one arrival should draw one notification row.",
        sender: { sessionId: WORKER },
        agentIntent: "task",
        notification: opening,
        items: [openingItem("run_1", opening), command("cmd_1", "run_1"), steeredItem("item_mid", "run_1", mid)],
      }),
    );
    expect(rows(html)).toBe(2);
  });
});

describe("the dedupe is keyed on the arrival, never on what it says", () => {
  const detail = peerDetail("run_1");

  test("only the item the engine minted from THIS run is dropped", () => {
    const kept = steeredItem("notification_run_other", "run_1", detail);
    const subject = turn({ runId: "run_1", notification: detail, sender: { sessionId: WORKER }, items: [openingItem("run_1", detail), kept] });
    expect(withoutOpeningNotification(subject).map((item) => item.id)).toEqual(["notification_run_other"]);
  });

  test("a SECOND arrival from the same session, word for word, is not eaten", () => {
    // The failure a text heuristic would eventually cause, and the reason the
    // key is an id: two identical notices are still two errands.
    const twin = steeredItem("item_twin", "run_1", { ...detail });
    const subject = turn({ runId: "run_1", notification: detail, sender: { sessionId: WORKER }, items: [openingItem("run_1", detail), twin] });
    expect(withoutOpeningNotification(subject).map((item) => item.id)).toEqual(["item_twin"]);
  });

  test("a turn with no notification of its own is untouched", () => {
    const mid = wakeDetail("run_other");
    const subject = turn({ runId: "run_1", origin: "user", items: [steeredItem("notification_run_1", "run_1", mid), command("cmd_1", "run_1")] });
    // Not even an item that happens to carry the minted id: without a header
    // drawing it, dropping it would lose the arrival entirely.
    expect(withoutOpeningNotification(subject).map((item) => item.id)).toEqual(["notification_run_1", "cmd_1"]);
  });
});
