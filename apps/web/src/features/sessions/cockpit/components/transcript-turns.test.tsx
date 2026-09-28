import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentMessageIntent } from "@telar/engine-client";
import type { JournalItem, JournalTurn } from "@/platform/engine";
import { SessionTurn } from "./session-turn";
import { TranscriptTurns } from "./transcript-turns";

const WORKERS = ["session_worker_aaaaaa", "session_worker_bbbbbb", "session_worker_cccccc"];

const turn = (over: Partial<JournalTurn> & Pick<JournalTurn, "runId">): JournalTurn => ({
  prompt: "",
  origin: "user",
  state: "completed",
  resultText: "",
  items: [],
  tasks: [],
  ...over,
});

const sendItem = (runId: string, to: string): JournalItem => ({
  id: `${runId}_${to}`,
  runId,
  sessionId: "session_host",
  status: "completed",
  startedAt: 1,
  completedAt: 1,
  streamedText: "",
  openedBy: 0,
  detail: { type: "mcp_tool_call", call: { name: "mcp__telar__sessions_send", input: { sessionId: to, intent: "task", input: "…" } } } as JournalItem["detail"],
});

const dispatch = turn({ runId: "run_dispatch", prompt: "fan these out", resultText: "Dispatched three.", items: WORKERS.map((to) => sendItem("run_dispatch", to)) });

function arrival(runId: string, from: string, intent: AgentMessageIntent, text: string): JournalTurn {
  const notification = {
    kind: "peer_message" as const,
    sessionId: from,
    runId,
    intent,
    summary: `[agent message · ${intent}] session ${from} sent a ${intent} (run ${runId}).`,
    fetch: { sessionId: "session_host", runId },
    body: `[agent message · ${intent}] session ${from} sent a ${intent} (run ${runId}).`,
  };
  return turn({
    runId,
    origin: "session",
    sender: { sessionId: from },
    agentIntent: intent,
    prompt: text,
    notification,
    items: [{ id: `notification_${runId}`, runId, sessionId: "session_host", status: "completed", startedAt: 2, completedAt: 2, streamedText: "", openedBy: 0, title: notification.summary, detail: { type: "notification", notification } }],
  });
}

const render = (turns: JournalTurn[]) =>
  renderToStaticMarkup(
    <TranscriptTurns
      turns={turns}
      keep={new Set()}
      directory={new Map([[WORKERS[0]!, { title: "Fix the rail", projectId: "project_1" }]])}
      renderTurn={(each, absorbed) => (absorbed ? null : <SessionTurn turn={each} requests={[]} sending={false} live={false} onDecide={() => {}} />)}
    />,
  );

const lines = (html: string) => [...html.matchAll(/<li[^>]*aria-label="Session ([^"]+)"/g)].map((match) => match[1]);

describe("sessions tasked from one turn", () => {
  test("three results render as one block of three lines, not three rows", () => {
    const html = render([
      dispatch,
      arrival("run_r1", WORKERS[0]!, "result", "PR #1 is green.\nDetails follow."),
      arrival("run_r2", WORKERS[1]!, "result", "PR #2 is green."),
      arrival("run_r3", WORKERS[2]!, "result", "PR #3 is green."),
    ]);
    expect(html.match(/aria-label="Dispatched sessions"/g)).toHaveLength(1);
    expect(lines(html)).toEqual(["Fix the rail", "session …bbbbbb", "session …cccccc"]);
    expect(html).toContain("3 sessions · 3 done");
    expect(html).toContain("PR #1 is green.");
    expect(html).not.toContain("Details follow.");
    expect(html).not.toContain("A session sent a result");
    expect(html).toContain('href="/projects/project_1/sessions/session_worker_aaaaaa"');
  });

  test("a late result updates its line instead of adding a row", () => {
    const early = [dispatch, arrival("run_r1", WORKERS[0]!, "result", "PR #1 is green."), arrival("run_r2", WORKERS[1]!, "result", "PR #2 is green.")];
    expect(render(early)).toContain("3 sessions · 2 done · 1 working");
    const late = render([...early, turn({ runId: "run_typed", prompt: "any news?", resultText: "Waiting on one." }), arrival("run_r3", WORKERS[2]!, "result", "PR #3 is green.")]);
    expect(late.match(/aria-label="Dispatched sessions"/g)).toHaveLength(1);
    expect(late).toContain("3 sessions · 3 done");
    expect(late).toContain("PR #3 is green.");
    expect(late.indexOf("PR #3 is green.")).toBeLessThan(late.indexOf("any news?"));
    expect(late).not.toContain('aria-label="Notification"');
  });

  test("a blocker keeps its warning row, and its line says blocker", () => {
    const html = render([
      dispatch,
      arrival("run_r1", WORKERS[0]!, "result", "PR #1 is green."),
      arrival("run_b2", WORKERS[1]!, "blocker", "Which branch should I target?"),
    ]);
    expect(html).toContain("A session reported a blocker");
    expect(html.match(/aria-label="Notification"/g)).toHaveLength(1);
    expect(html).toContain("3 sessions · 1 done · 1 working · 1 blocked");
    expect(html).toMatch(/>blocker<\/span><span[^>]*>Which branch should I target\?/);
  });

  test("a single session tasked alone keeps today's row", () => {
    const solo = turn({ runId: "run_solo", items: [sendItem("run_solo", WORKERS[0]!)] });
    const html = render([solo, arrival("run_r1", WORKERS[0]!, "result", "Done.")]);
    expect(html).not.toContain("Dispatched sessions");
    expect(html).toContain("A session sent a result");
  });
});
