/**
 * A COORDINATOR'S REACTIONS WHILE ITS COHORT WORKED, FOLDED.
 *
 * What these pin: the fold's boundaries come from the engine's cohort fields
 * alone; a person's turn, a blocker, a request, and anything carrying a result
 * are never folded (the fold reverted in September hid completed work); every
 * turn comes back exactly once, in order; and opening the fold draws them all.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { NotificationDetail } from "@telar/engine-client";
import type { JournalItem, JournalTurn } from "@/platform/engine";
import { SessionTurn } from "../session-cockpit";
import { CohortFold, cohortFoldSummary, foldCohortTurns, type TranscriptSegment } from "./cohort-fold";

const OPENED = 150;

const detail = (over: Partial<NotificationDetail> & Pick<NotificationDetail, "kind">): NotificationDetail => ({
  sessionId: "session_a",
  summary: "something happened",
  fetch: { sessionId: "session_a", runId: "run_child" },
  body: "something happened",
  ...over,
});

const wake = detail({ kind: "wake", wakeKind: "turn_completed" });
const blocker = detail({ kind: "peer_message", intent: "blocker", sessionId: "session_b" });
const result = detail({ kind: "peer_message", intent: "result" });
const report = detail({ kind: "peer_message", intent: "report" });
const close = detail({
  kind: "wake",
  wakeKind: "turn_completed",
  cohortId: "coh_one",
  cohortOpenedAt: OPENED,
  entries: ["session_a", "session_b", "session_c", "session_d"].map((sessionId) => ({ kind: "wake" as const, sessionId, wakeKind: "turn_completed" as const, summary: sessionId })),
});

const item = (runId: string, id: string, itemDetail: JournalItem["detail"]): JournalItem => ({
  id,
  runId,
  sessionId: "session_host",
  status: "completed",
  startedAt: 1,
  completedAt: 1,
  streamedText: "",
  openedBy: 0,
  detail: itemDetail,
});

const send = (runId: string, input: { sessionId: string; intent?: string }) =>
  item(runId, `${runId}_send`, { type: "mcp_tool_call", call: { name: "mcp__telar__sessions_send", input: { ...input, input: "…" } } });

const turn = (runId: string, acceptedAt: number, over: Partial<JournalTurn> = {}): JournalTurn => ({
  runId,
  prompt: "",
  origin: "session",
  state: "completed",
  resultText: `reply to ${runId}`,
  items: [],
  tasks: [],
  acceptedAt,
  notification: wake,
  ...over,
});

const shape = (segments: readonly TranscriptSegment<JournalTurn>[]) =>
  segments.map((segment) => `${segment.kind}:${segment.turns.map((each) => each.runId).join(",")}`);

const folded = (segments: readonly TranscriptSegment<JournalTurn>[]) =>
  segments.flatMap((segment) => (segment.kind === "fold" ? segment.turns.map((each) => each.runId) : []));

describe("fold boundaries", () => {
  test("only the turns between the cohort's subscription and its close fold, and kept turns split the fold", () => {
    const turns = [
      turn("run_fanout", 100, { origin: "user", notification: undefined }),
      turn("run_merge", 200),
      turn("run_report", 300, { notification: report }),
      turn("run_blocker", 400, { notification: blocker, agentIntent: "blocker" }),
      turn("run_wake", 500),
      turn("run_person", 600, { origin: "user", notification: undefined }),
      turn("run_late", 700),
      turn("run_close", 800, { notification: close }),
      turn("run_after", 900),
    ];
    const segments = foldCohortTurns(turns);
    expect(shape(segments)).toEqual([
      "turns:run_fanout",
      "fold:run_merge,run_report",
      "turns:run_blocker",
      "fold:run_wake",
      "turns:run_person",
      "fold:run_late",
      "turns:run_close,run_after",
    ]);
    // Every turn exactly once, in order.
    expect(segments.flatMap((segment) => segment.turns)).toEqual(turns);
    expect(segments.find((segment) => segment.kind === "fold")).toMatchObject({ cohortId: "coh_one", members: 4 });
  });

  test("nothing folds without a close, or on a close from an engine that did not say when it opened", () => {
    const turns = [turn("run_one", 200), turn("run_two", 300)];
    expect(shape(foldCohortTurns(turns))).toEqual(["turns:run_one,run_two"]);
    const older = { ...close, cohortOpenedAt: undefined };
    expect(folded(foldCohortTurns([...turns, turn("run_close", 400, { notification: older })]))).toEqual([]);
  });

  test("a turn accepted before the cohort opened is not in its window", () => {
    expect(folded(foldCohortTurns([turn("run_before", OPENED), turn("run_in", OPENED + 1), turn("run_close", 400, { notification: close })]))).toEqual(["run_in"]);
  });

  test("a turn with no acceptance time ends the window rather than guessing", () => {
    expect(folded(foldCohortTurns([turn("run_a", 200), turn("run_unknown", 0, { acceptedAt: undefined }), turn("run_b", 300), turn("run_close", 400, { notification: close })]))).toEqual(["run_b"]);
  });
});

describe("what never folds", () => {
  const between = (subject: JournalTurn, options?: Parameters<typeof foldCohortTurns>[1]) =>
    folded(foldCohortTurns([turn("run_before", 200), subject, turn("run_close", 400, { notification: close })], options));

  test("a person's turn, and a person's message steered into a machine turn", () => {
    expect(between(turn("run_x", 300, { origin: "user", notification: undefined }))).toEqual(["run_before"]);
    expect(between(turn("run_x", 300, { items: [item("run_x", "steer", { type: "user_message", text: "stop that" } as JournalItem["detail"])] }))).toEqual(["run_before"]);
  });

  test("a blocker, a parked request, and a task arriving", () => {
    expect(between(turn("run_x", 300, { notification: blocker }))).toEqual(["run_before"]);
    expect(between(turn("run_x", 300, { notification: detail({ kind: "request", wakeKind: "request_opened" }) }))).toEqual(["run_before"]);
    expect(between(turn("run_x", 300, { notification: detail({ kind: "peer_message", intent: "task" }) }))).toEqual(["run_before"]);
    // Merged under a routine wake, it still keeps the turn.
    expect(between(turn("run_x", 300, { notification: { ...wake, entries: [{ kind: "wake", summary: "w" }, { kind: "peer_message", intent: "blocker", summary: "b" }] } }))).toEqual(["run_before"]);
  });

  test("a turn that raised a blocker, or answered one", () => {
    expect(between(turn("run_x", 300, { items: [send("run_x", { sessionId: "session_parent", intent: "blocker" })] }))).toEqual(["run_before"]);
    const turns = [
      turn("run_asked", 200, { notification: blocker }),
      turn("run_answered", 300, { items: [send("run_answered", { sessionId: "session_b", intent: "task" })] }),
      turn("run_again", 350, { items: [send("run_again", { sessionId: "session_b", intent: "task" })] }),
      turn("run_close", 400, { notification: close }),
    ];
    // The answer stays; a later message to the same session is routine again.
    expect(folded(foldCohortTurns(turns))).toEqual(["run_again"]);
  });

  test("a turn with a request, the live turn, and one that did not simply complete", () => {
    expect(between(turn("run_x", 300), { keep: new Set(["run_x"]) })).toEqual(["run_before"]);
    expect(between(turn("run_x", 300), { activeRunId: "run_x" })).toEqual(["run_before"]);
    for (const state of ["failed", "stopped", "running", "ambiguous"] as const) expect(between(turn("run_x", 300, { state }))).toEqual(["run_before"]);
    expect(between(turn("run_x", 300, { held: true }))).toEqual(["run_before"]);
  });
});

describe("a result is never only inside a fold — the reverted failure", () => {
  const between = (subject: JournalTurn) => folded(foldCohortTurns([turn("run_before", 200), subject, turn("run_close", 400, { notification: close })]));

  test("a result arriving as the turn, merged into it, or hosted inside it", () => {
    expect(between(turn("run_x", 300, { notification: result, agentIntent: "result" }))).toEqual(["run_before"]);
    expect(between(turn("run_x", 300, { notification: { ...wake, entries: [{ kind: "wake", summary: "w" }, { kind: "peer_message", intent: "result", summary: "r" }] } }))).toEqual(["run_before"]);
    // A passive result lands inside whatever turn was running (`hostPassiveArrivals`).
    expect(between(turn("run_x", 300, { items: [item("run_x", "arrival", { type: "notification", notification: result })] }))).toEqual(["run_before"]);
  });

  test("a result this session sent", () => {
    expect(between(turn("run_x", 300, { items: [send("run_x", { sessionId: "session_parent", intent: "result" })] }))).toEqual(["run_before"]);
  });

  test("the close itself stays, even inside another cohort's window", () => {
    const inner = { ...close, cohortId: "coh_inner", cohortOpenedAt: 250 };
    const turns = [turn("run_a", 200), turn("run_inner", 300, { notification: inner }), turn("run_b", 350), turn("run_close", 400, { notification: close })];
    expect(shape(foldCohortTurns(turns))).toEqual(["fold:run_a", "turns:run_inner", "fold:run_b", "turns:run_close"]);
  });
});

describe("the summary", () => {
  test("says how many sessions, how many turns, and what they did", () => {
    const work = [
      item("run_a", "c1", { type: "command_execution", command: { command: "gh pr merge 12" }, output: "" } as JournalItem["detail"]),
      item("run_a", "said", { type: "assistant_message", text: "Merged." }),
    ];
    expect(cohortFoldSummary([turn("run_a", 200, { items: work }), turn("run_b", 300)], 4)).toMatch(/^While 4 sessions worked · 2 updates · /);
    expect(cohortFoldSummary([turn("run_a", 200)], 1)).toBe("While 1 session worked · 1 update");
  });
});

describe("expanding", () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("is one line with its count until opened, and then every turn it covers", () => {
    const turns = [turn("run_a", 200, { resultText: "Merged #12." }), turn("run_b", 300, { resultText: "Rebased #13." }), turn("run_c", 350, { resultText: "Holding." })];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <CohortFold turns={turns} members={4}>
          {turns.map((each) => (
            <SessionTurn key={each.runId} turn={each} requests={[]} sending={false} live={false} onDecide={() => {}} onRetry={() => {}} />
          ))}
        </CohortFold>,
      );
    });
    const button = host.querySelector("button[aria-expanded]")!;
    expect(button.textContent).toBe("While 4 sessions worked · 3 updates");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("Merged #12.");

    act(() => (button as HTMLButtonElement).click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    for (const text of ["Merged #12.", "Rebased #13.", "Holding."]) expect(host.textContent).toContain(text);

    act(() => root.unmount());
    host.remove();
  });
});
