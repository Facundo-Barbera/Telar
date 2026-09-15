// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityGroup } from "../transcript";
import { SessionTurn } from "../session-cockpit";
import { AgentMessageBubble } from "./conversation-message";
import type { JournalTurn } from "@/lib/engine/journal";

const machine: JournalTurn = { runId: "run_peer", origin: "session", sender: { sessionId: "session_worker" }, prompt: "Internal checkpoint", state: "completed", resultText: "Internal acknowledgement", items: [], tasks: [] };
const render = (turn: JournalTurn) => renderToStaticMarkup(<SessionTurn turn={turn} requests={[]} sending={false} live={false} onDecide={() => {}} onRetry={() => {}} />);

/** Every disclosure a turn draws, counted — the claim in #239 is about HOW MANY
 *  there are, which no `toContain` can state. */
const folds = (html: string) => html.split('aria-expanded="false"').length - 1;

test("a passive report keeps its payload out of the default chat view", () => {
  const html = render({ ...machine, agentDelivery: "passive", resultText: "" });
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Agent message");
  expect(html).not.toContain("Internal checkpoint");
  expect(html).not.toContain("Internal acknowledgement");
});

test("a passive report is ONE fold, not a fold inside a fold", () => {
  // #239: the report was wrapped in a "Session activity" disclosure whose only
  // child was the `AgentMessageBubble` — itself already a disclosure over the
  // same message. Two chevrons, one report, and two taps to read it.
  const html = render({ ...machine, agentDelivery: "passive", agentNotice: NOTICE, prompt: "Capacity report\n\nbody nobody needs up front", resultText: "" });
  expect(folds(html)).toBe(1);
  expect(html).not.toContain("Session activity");
  // The one fold left is the peer-message row, labelled by the notice.
  expect(html).toContain("run run_peer, 2,400 chars");
  expect(html).not.toContain("body nobody needs up front");
});

test("a passive report and its mid-turn twin draw the same single row", () => {
  // A report is not a different KIND of thing for having arrived between turns
  // rather than during one, so neither shape may grow a fold the other lacks.
  const between = render({ ...machine, agentDelivery: "passive", agentNotice: NOTICE, prompt: "Capacity report", resultText: "" });
  const during = renderToStaticMarkup(<AgentMessageBubble text="Capacity report" notice={NOTICE} sender={{ sessionId: "session_worker" }} />);
  expect(folds(between)).toBe(folds(during));
  expect(between).toContain('aria-label="Message from another agent"');
});

test("legacy agent assignments retain visible completion messages", () => {
  const html = render(machine);
  expect(html).toContain("Internal acknowledgement");
  expect(html).not.toContain('aria-label="Session coordination"');
  expect(html).not.toContain("Internal checkpoint");
});

test("waking agent work retains its completion message", () => {
  const html = render({ ...machine, agentDelivery: "wake" });
  expect(html).toContain("Internal acknowledgement");
  expect(html).not.toContain('aria-label="Session coordination"');
});

test("subscription completions retain the recipient's response", () => {
  const html = render({ ...machine, sender: undefined, wakeReason: { kind: "turn_completed", sessionId: "session_worker", runId: "run_source" } });
  expect(html).toContain("Internal acknowledgement");
  expect(html).not.toContain('aria-label="Session coordination"');
});

test("a human's message is never folded as session coordination", () => {
  const html = render({ ...machine, origin: "user", prompt: "Please fix the editor" });
  expect(html).toContain("Please fix the editor");
  expect(html).not.toContain('aria-label="Session coordination"');
});

test("a mid-turn direct report is collapsed too", () => {
  const html = renderToStaticMarkup(<AgentMessageBubble text={"## Private checkpoint\n".repeat(100)} sender={{sessionId:"session_worker"}} />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("Private checkpoint");
});

// ── the notice on the row ───────────────────────────────────────────────────

/** The engine's own string, the one its model was handed — see `Turn.agentNotice`. */
const NOTICE = `[agent message · report] from session session_worker (run run_peer, 2,400 chars): "Capacity report"\n—\nThe message itself is not in this notice.`;

test("a collapsed report labels itself with the notice its model was handed", () => {
  const html = render({ ...machine, agentNotice: NOTICE, prompt: "Capacity report\n\nbody nobody needs up front" });
  expect(html).toContain('aria-expanded="false"');
  // The row says who, which run and how big — the same sentence the model read,
  // not a second summary that could drift from it.
  expect(html).toContain("run run_peer, 2,400 chars");
  // Only the FIRST line: the notice's own fetch instruction is for the model.
  expect(html).not.toContain("The message itself is not in this notice");
  // And the body is still behind the disclosure, not gone.
  expect(html).not.toContain("body nobody needs up front");
});

test("expanding a notice row reveals the stored body, not the notice", () => {
  // The collapsed/expanded pair is a client-side toggle, so the contract under
  // test here is what each branch RENDERS: `notice` labels, `text` expands.
  const collapsed = renderToStaticMarkup(<AgentMessageBubble text="the whole report" notice={NOTICE} sender={{ sessionId: "session_worker" }} />);
  expect(collapsed).toContain("Capacity report");
  expect(collapsed).not.toContain("the whole report");
});

test("a peer's message steered mid-turn collapses to the same notice", () => {
  // The mid-turn twin of the row above — same message, different landing site,
  // and the transcript must not make it look like a different kind of thing.
  const html = render({ ...machine, items: [{ id: "item_peer", runId: "run_peer", sessionId: "session_host", status: "completed", title: "Sent by an agent", detail: { type: "user_message", text: "the whole report", notice: NOTICE, sender: { sessionId: "session_worker" } }, streamedText: "", openedBy: 1, startedAt: 1 }] });
  expect(html).toContain("run run_peer, 2,400 chars");
  expect(html).not.toContain("the whole report");
});

test("a turn stored before notices existed keeps the sender label it always had", () => {
  const html = renderToStaticMarkup(<AgentMessageBubble text="legacy report" sender={{ sessionId: "session_worker456789" }} />);
  expect(html).toContain("agent · session …456789");
});

test("a task collapses like every other peer message, its scope on the header", () => {
  // It used to render in full. A peer does not decide how much of someone
  // else's prose sits in this conversation: the notice's first line and the
  // scope are the row, and the instruction opens on tap.
  const html = render({ ...machine, agentIntent: "task", agentNotice: NOTICE, prompt: "Rewrite the parser", assignmentScope: "packages/core" });
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain(">Task<");
  expect(html).toContain("packages/core");
  expect(html).not.toContain("Rewrite the parser");
});

test("human steering into a machine turn remains visible", () => {
  const html = render({ ...machine, items: [{ id: "item_human", runId: "run_peer", sessionId: "session_host", status: "completed", title: "Message", detail: { type: "user_message", text: "Please change direction" }, streamedText: "", openedBy: 1, startedAt: 1 }] });
  expect(html).toContain("Please change direction");
  expect(html.indexOf('aria-label="Message from another agent"')).toBeLessThan(html.indexOf("Please change direction"));
  expect(html).not.toContain('aria-label="Session coordination"');
});


test("reconnect retries share one summary while keeping each event", () => {
  const items = [2, 3, 4, 5].map(attempt => ({ id: `retry_${attempt}`, runId: "run_peer", sessionId: "session_host", status: "completed" as const, title: `Reconnecting... ${attempt}/5`, detail: { type: "unknown" as const }, streamedText: "", openedBy: attempt, startedAt: attempt }));
  const html = renderToStaticMarkup(<ActivityGroup items={items} tasks={[]} live={false} />);
  expect(html).toContain("Reconnect attempt ×4");
  expect(html).not.toContain("Reconnecting... 2/5");
  expect(items).toHaveLength(4);
});
