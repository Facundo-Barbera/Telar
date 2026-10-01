import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentMessageIntent, NotificationDetail, NotificationEntry } from "@telar/engine-client";
import { hostPassiveArrivals, type JournalItem, type JournalTurn } from "@/platform/engine";
import { planDispatches } from "../dispatch";
import { SessionTurn } from "./session-turn";
import { TranscriptTurns } from "./transcript-turns";

const HOST = "session_host";
const WORKERS = ["session_worker_aaaaaa", "session_worker_bbbbbb", "session_worker_cccccc"];
const TITLES: Record<string, string> = {
  session_worker_aaaaaa: "Fix the rail",
  session_worker_bbbbbb: "Tidy the panel",
  session_worker_cccccc: "Speed up boot",
  session_solo_dddddd: "Answer a question",
  session_solo_eeeeee: "Check the docs",
};

const turn = (over: Partial<JournalTurn> & Pick<JournalTurn, "runId">): JournalTurn => ({
  prompt: "",
  origin: "user",
  state: "completed",
  resultText: "",
  items: [],
  tasks: [],
  ...over,
});

const toolItem = (runId: string, id: string, name: string, input: Record<string, unknown>, output?: string): JournalItem => ({
  id: `${runId}_${id}`,
  runId,
  sessionId: HOST,
  status: "completed",
  startedAt: 1,
  completedAt: 1,
  streamedText: "",
  openedBy: 0,
  detail: { type: "mcp_tool_call", call: { name: `mcp__telar__${name}`, input, ...(output ? { output } : {}) } } as JournalItem["detail"],
});

const sendItem = (runId: string, to: string) => toolItem(runId, to, "sessions_send", { sessionId: to, intent: "task", input: "…" });

const createItem = (runId: string, id: string) =>
  toolItem(runId, id, "sessions_create", { projectId: "project_1", title: TITLES[id], envMode: "worktree", task: "…" }, JSON.stringify({ id, project: "telar", title: TITLES[id], state: "active" }));

const subscribeItem = (runId: string, ids: string[]) => toolItem(runId, "subscribe", "sessions_subscribe", { sessionIds: ids });

const notificationItem = (runId: string, notification: NotificationDetail): JournalItem => ({
  id: `notification_${runId}`, runId, sessionId: HOST, status: "completed", startedAt: 2, completedAt: 2, streamedText: "", openedBy: 0, title: notification.summary, detail: { type: "notification", notification },
});

function arrival(runId: string, from: string, intent: AgentMessageIntent, text: string): JournalTurn {
  const notification: NotificationDetail = {
    kind: "peer_message",
    sessionId: from,
    runId,
    intent,
    summary: `[agent message · ${intent}] session ${from} sent this session a ${intent} (run ${runId}, ${text.length} chars).`,
    fetch: { sessionId: HOST, runId },
    body: `[agent message · ${intent}] session ${from} sent this session a ${intent} (run ${runId}, ${text.length} chars).\nIn full:\n<<<\n${text}\n>>>`,
    ...(intent === "result" ? { spent: "claude-opus-5-5 at high effort, 120k tokens (100k cache read, 10k cache write, 8k in, 2k out)" } : {}),
  };
  const at = 20 + Number(runId.replace(/\D/g, "") || 0);
  return turn({ runId, origin: "session", sender: { sessionId: from }, agentIntent: intent, agentDelivery: "passive", prompt: text, notification, acceptedAt: at, items: [{ ...notificationItem(runId, notification), startedAt: at, completedAt: at }] });
}

type Member = { sessionId: string; outcome?: "result" | "failed"; text?: string };

function cohortClose(runId: string, members: Member[], reason: "all" | "expired", reaction = "All three are in; merging."): JournalTurn {
  const entries: NotificationEntry[] = members.map((member) => ({
    kind: member.outcome === "result" ? "peer_message" : "wake",
    sessionId: member.sessionId,
    runId: `run_msg_${member.sessionId}`,
    ...(member.outcome === "result" ? { intent: "result" as const } : member.outcome === "failed" ? { wakeKind: "turn_failed" as const } : {}),
    summary: `${member.sessionId} "${TITLES[member.sessionId]}" — ${member.outcome ?? "STILL PENDING (no result sent)"}${member.text ? `: ${member.text}` : ""}`,
    title: TITLES[member.sessionId]!,
  }));
  const finished = members.filter((member) => member.outcome).length;
  const header = reason === "all" ? `[cohort done · all ${members.length} sessions finished]` : `[cohort expired · ${finished} of ${members.length} sessions finished in 240 min]`;
  const lead = members.findLast((member) => member.outcome) ?? members[0]!;
  const notification: NotificationDetail = {
    kind: "wake",
    sessionId: lead.sessionId,
    wakeKind: "turn_completed",
    summary: header,
    fetch: { sessionId: HOST, runId: `run_msg_${lead.sessionId}` },
    body: header,
    entries,
    cohortId: `coh_${runId}`,
    cohortOpenedAt: 10,
    deliveries: 1,
  };
  return turn({
    runId,
    origin: "session",
    prompt: `[notification: wake · turn_completed · session ${lead.sessionId}]`,
    notification,
    acceptedAt: 50,
    resultText: reaction,
    items: [
      notificationItem(runId, notification),
      { id: `${runId}_answer`, runId, sessionId: HOST, status: "completed", startedAt: 3, completedAt: 3, streamedText: reaction, openedBy: 0, detail: { type: "assistant_message", text: reaction } } as JournalItem,
    ],
  });
}

const fanOut = turn({
  runId: "run_dispatch",
  prompt: "fan these out",
  resultText: "Dispatched three; subscribed.",
  items: [...WORKERS.map((id) => createItem("run_dispatch", id)), subscribeItem("run_dispatch", WORKERS)],
});

const render = (turns: JournalTurn[], titles: Record<string, string> = TITLES) => {
  const plan = planDispatches(turns);
  const directory = new Map(Object.entries(titles).map(([id, title]) => [id, { title, projectId: "project_1" }]));
  return renderToStaticMarkup(
    <TranscriptTurns
      turns={turns}
      plan={plan}
      keep={new Set()}
      directory={directory}
      renderTurn={(each, view) => (view.absorbed ? null : <SessionTurn turn={each} requests={[]} sending={false} live={false} onDecide={() => {}} covered={view.covered} {...(view.peerTitle ? { peerTitle: view.peerTitle } : {})} />)}
    />,
  );
};

const cards = (html: string) => html.match(/aria-label="Dispatched sessions"/g)?.length ?? 0;
const lines = (html: string) => [...html.matchAll(/<li[^>]*aria-label="Session ([^"]+)"/g)].map((match) => match[1]);
const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("one card per dispatch, from the engine's own sequence", () => {
  const results = [
    arrival("run_r1", WORKERS[0]!, "result", "PR #1 is green.\nDetails follow."),
    arrival("run_r2", WORKERS[1]!, "result", "PR #2 is green."),
    arrival("run_solo", "session_solo_dddddd", "result", "The answer is 42."),
    arrival("run_r3", WORKERS[2]!, "result", "PR #3 is green."),
  ];
  const close = cohortClose("run_close", WORKERS.map((sessionId, index) => ({ sessionId, outcome: "result", text: `PR #${index + 1} is green.` })), "all");

  test("created, subscribed, staggered results and the cohort wake render as ONE card", () => {
    const html = render([fanOut, ...results, close]);
    expect(cards(html)).toBe(1);
    expect(lines(html)).toEqual(["Fix the rail", "Tidy the panel", "Speed up boot"]);
    expect(html).toContain("3 sessions · 3 finished");
    expect(html).toContain("claude-opus-5-5 at high effort, 120k tokens");
    expect(html).toContain('href="/projects/project_1/sessions/session_worker_aaaaaa"');
    expect(html).not.toContain("Session finished a turn");
    expect(html.match(/A session sent a result/g)).toHaveLength(1);
    expect(html).toContain("All three are in; merging.");
  });

  test("the card updates in place while members are still working", () => {
    expect(render([fanOut, results[0]!])).toContain("3 sessions · 1 finished · 2 working");
    const html = render([fanOut, ...results.slice(0, 2)]);
    expect(cards(html)).toBe(1);
    expect(html).toContain("3 sessions · 2 finished · 1 working");
  });

  test("a result from outside the cohort is one compact row naming its session's title, never its id", () => {
    const html = render([fanOut, ...results, close]);
    expect(html).toMatch(/A session sent a result.*The answer is 42\..*Answer a question/);
    expect(visibleText(html)).not.toMatch(/session_|session …/);
  });

  test("a cohort that expires with a member pending says so on the same card", () => {
    const expired = cohortClose("run_expired", [{ sessionId: WORKERS[0]!, outcome: "result", text: "PR #1 is green." }, { sessionId: WORKERS[1]! }, { sessionId: WORKERS[2]!, outcome: "failed" }], "expired", "Two did not finish.");
    const html = render([fanOut, results[0]!, expired]);
    expect(cards(html)).toBe(1);
    expect(html).toContain("3 sessions · 1 finished · 1 working · 1 failed · stopped waiting");
    expect(html).not.toContain('aria-label="Notification"');
  });

  test("a cohort wake whose dispatch is no longer loaded still draws one card from its own members", () => {
    const html = render([close]);
    expect(cards(html)).toBe(1);
    expect(lines(html)).toEqual(["Fix the rail", "Tidy the panel", "Speed up boot"]);
    expect(html).toContain("3 sessions · 3 finished");
  });

  test("every arrival lands on the same card whichever order the planner meets them", () => {
    const plan = planDispatches([fanOut, ...results, close]);
    expect(new Set(plan.blocks.values()).size).toBe(1);
    expect([...plan.absorbed].sort()).toEqual(["run_r1", "run_r2", "run_r3"]);
    expect([...plan.covered]).toEqual(["run_close"]);
  });
});

describe("as the cockpit draws it, with held results hosted in the cohort wake's turn", () => {
  const results = [
    arrival("run_r1", WORKERS[0]!, "result", "PR #1 is green."),
    arrival("run_r2", WORKERS[1]!, "result", "PR #2 is green."),
    arrival("run_s3", "session_solo_dddddd", "result", "The answer is 42."),
    arrival("run_s4", "session_solo_eeeeee", "result", "Docs are fine."),
    arrival("run_r5", WORKERS[2]!, "result", "PR #3 is green."),
  ];
  const close = cohortClose("run_close", WORKERS.map((sessionId) => ({ sessionId, outcome: "result" })), "all");

  test("one card, the members' rows gone, the outside results one row of titles", () => {
    const hosted = hostPassiveArrivals([fanOut, ...results, close]);
    expect(hosted.map((each) => each.runId)).toEqual(["run_dispatch", "run_close"]);
    const html = render(hosted);
    expect(cards(html)).toBe(1);
    expect(html).toContain("3 sessions · 3 finished");
    expect(html).toContain("PR #2 is green.");
    expect(html.match(/aria-label="Notification"/g)).toHaveLength(1);
    expect(html).toContain("and 1 more");
    expect(html).toContain("Answer a question, Check the docs");
    expect(html).not.toContain("Session finished a turn");
    expect(visibleText(html)).not.toMatch(/session_|session …/);
  });
});

describe("arrivals outside any cohort", () => {
  test("consecutive ones fold into one line of titles", () => {
    const html = render([arrival("run_s1", "session_solo_dddddd", "result", "One."), arrival("run_s2", "session_solo_eeeeee", "result", "Two.")]);
    expect(html).toContain("2 updates · Answer a question, Check the docs");
    expect(html).not.toContain("A session sent a result");
  });

  test("an unknown session reads as untitled, not as its id", () => {
    const html = render([arrival("run_s1", "session_stranger_ffffff", "result", "Hello.")], {});
    expect(html).toContain("Untitled session");
    expect(visibleText(html)).not.toContain("ffffff");
  });
});

describe("sessions tasked from one turn with sessions_send", () => {
  const dispatch = turn({ runId: "run_dispatch", prompt: "fan these out", resultText: "Dispatched three.", items: WORKERS.map((to) => sendItem("run_dispatch", to)) });

  test("three results render as one block of three lines, not three rows", () => {
    const html = render([
      dispatch,
      arrival("run_r1", WORKERS[0]!, "result", "PR #1 is green.\nDetails follow."),
      arrival("run_r2", WORKERS[1]!, "result", "PR #2 is green."),
      arrival("run_r3", WORKERS[2]!, "result", "PR #3 is green."),
    ]);
    expect(cards(html)).toBe(1);
    expect(html).toContain("3 sessions · 3 finished");
    expect(html).toContain("PR #1 is green.");
    expect(html).not.toContain("Details follow.");
    expect(html).not.toContain("A session sent a result");
  });

  test("a late result updates its line instead of adding a row", () => {
    const early = [dispatch, arrival("run_r1", WORKERS[0]!, "result", "PR #1 is green."), arrival("run_r2", WORKERS[1]!, "result", "PR #2 is green.")];
    const late = render([...early, turn({ runId: "run_typed", prompt: "any news?", resultText: "Waiting on one." }), arrival("run_r3", WORKERS[2]!, "result", "PR #3 is green.")]);
    expect(cards(late)).toBe(1);
    expect(late).toContain("3 sessions · 3 finished");
    expect(late.indexOf("PR #3 is green.")).toBeLessThan(late.indexOf("any news?"));
    expect(late).not.toContain('aria-label="Notification"');
  });

  test("a blocker keeps its warning row, and its line says waiting on you", () => {
    const html = render([dispatch, arrival("run_r1", WORKERS[0]!, "result", "PR #1 is green."), arrival("run_b2", WORKERS[1]!, "blocker", "Which branch should I target?")]);
    expect(html).toContain("A session reported a blocker");
    expect(html.match(/aria-label="Notification"/g)).toHaveLength(1);
    expect(html).toContain("3 sessions · 1 finished · 1 working · 1 waiting on you");
  });

  test("a single session tasked alone keeps its own row", () => {
    const html = render([turn({ runId: "run_solo", items: [sendItem("run_solo", WORKERS[0]!)] }), arrival("run_r1", WORKERS[0]!, "result", "Done.")]);
    expect(cards(html)).toBe(0);
    expect(html).toContain("A session sent a result");
    expect(html).toContain("Fix the rail");
  });
});
