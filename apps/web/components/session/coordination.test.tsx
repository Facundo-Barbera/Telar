// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityGroup } from "../transcript";
import { SessionTurn } from "../session-cockpit";
import { AgentMessageBubble } from "./conversation-message";
import type { JournalTurn } from "@/lib/engine/journal";

const machine: JournalTurn = { runId: "run_peer", origin: "session", sender: { sessionId: "session_worker" }, prompt: "Internal checkpoint", state: "completed", resultText: "Internal acknowledgement", items: [], tasks: [] };
const render = (turn: JournalTurn) => renderToStaticMarkup(<SessionTurn turn={turn} requests={[]} sending={false} live={false} now={1} onDecide={() => {}} onRetry={() => {}} />);

test("a passive report keeps its payload out of the default chat view", () => {
  const html = render({ ...machine, agentDelivery: "passive", resultText: "" });
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Session activity");
  expect(html).not.toContain("Internal checkpoint");
  expect(html).not.toContain("Internal acknowledgement");
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
