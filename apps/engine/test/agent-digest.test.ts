/**
 * THE TURN-START DIGEST — issue #541, section A.
 *
 * What must not drift:
 *
 *   - the ranking: waiting on you, then failed, then completed, then counts;
 *   - the cohort merge, which folds sibling COMPLETIONS into one line and
 *     deliberately leaves failures one line each;
 *   - the cap, and the closing line that names how to retrieve what did not fit;
 *   - nothing unread renders nothing at all, because a turn that opened with
 *     "nothing happened" would be paying for the feature on every message;
 *   - a human-started turn opens with it and a resumed one does not;
 *   - the rows it accounted for are marked read when the turn ends — and are NOT
 *     marked read when the turn never reached a model.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { WakeKind } from "@telar/engine-client";
import { wakeNotification } from "../src/notification";
import { renderDigest, DIGEST_MAX_CHARS } from "../src/agent/digest";
import type { AgentInboxRow } from "../src/agent/inbox";
import { AgentRuntime } from "../src/agent/runtime";

/* ------------------------------------------------------------------ *
 * The renderer, as a pure function.
 * ------------------------------------------------------------------ */

let nextId = 1;
const row = (kind: AgentInboxRow["kind"], sessionId: string, summary: string): AgentInboxRow => ({
  id: nextId++,
  at: 1_000 + nextId,
  sessionId,
  runId: `run_${nextId}`,
  kind,
  summary,
  read: false,
});

test("nothing unread renders nothing at all", () => {
  expect(renderDigest([])).toBeUndefined();
});

test("the ranking puts what is waiting on you first, then failures, then completions", () => {
  const digest = renderDigest([
    row("turn_completed", "session_aaaaaaaa", "[wake: completed] Session finished"),
    row("turn_failed", "session_bbbbbbbb", "[wake: failed] Session — turn FAILED (provider_error)"),
    row("request_opened", "session_cccccccc", "[wake: waiting] Session — is WAITING on a request"),
  ])!;
  const lines = digest.text.split("\n").filter((line) => line.startsWith("- "));
  expect(lines[0]).toContain("WAITING ON YOU");
  expect(lines[0]).toContain("…cccccc");
  expect(lines[1]).toContain("FAILED");
  expect(lines[2]).toContain("finished");
  // THE BLOCK IS FRAMED, because it is engine prose in a turn a person began.
  expect(digest.text.split("\n")[0]).toContain("written by the engine, not by anyone");
  expect(digest.text.endsWith("[end of digest]")).toBe(true);
  expect(digest.overflow).toBe(0);
});

test("the kind's own bracket is stripped, so a line reads as one sentence", () => {
  const digest = renderDigest([row("turn_failed", "session_aaaaaaaa", "[wake: failed] Session session_a — turn run_2 FAILED (provider_error)")])!;
  expect(digest.text).toContain("FAILED · session …aaaaaa — Session session_a — turn run_2 FAILED (provider_error)");
  expect(digest.text).not.toContain("[wake: failed]");
});

test("sibling completions merge into one line naming every session", () => {
  const digest = renderDigest([
    row("turn_completed", "session_aaaaaaaa", "[wake: completed] one"),
    row("turn_completed", "session_bbbbbbbb", "[wake: completed] two"),
    row("turn_completed", "session_cccccccc", "[wake: completed] three"),
  ])!;
  const completed = digest.text.split("\n").filter((line) => line.startsWith("- finished"));
  expect(completed).toHaveLength(1);
  expect(completed[0]).toBe("- finished · 3 sessions — …aaaaaa, …bbbbbb, …cccccc");
});

test("one completion keeps its own sentence, because there is nothing to merge it with", () => {
  const digest = renderDigest([row("turn_completed", "session_aaaaaaaa", "[wake: completed] Session finished run_9")])!;
  expect(digest.text).toContain("- finished · session …aaaaaa — Session finished run_9");
});

test("one session that completed twice is one sibling, not two", () => {
  const digest = renderDigest([
    row("turn_completed", "session_aaaaaaaa", "[wake: completed] one"),
    row("turn_completed", "session_aaaaaaaa", "[wake: completed] two"),
  ])!;
  expect(digest.text).toContain("- finished · session …aaaaaa — 2 turns completed");
});

test("failures are NOT merged — each keeps the reason it failed", () => {
  const digest = renderDigest([
    row("turn_failed", "session_aaaaaaaa", "[wake: failed] ran out of context"),
    row("turn_failed", "session_bbbbbbbb", "[wake: failed] the provider refused"),
  ])!;
  const failed = digest.text.split("\n").filter((line) => line.startsWith("- FAILED"));
  expect(failed).toHaveLength(2);
  expect(failed[0]).toContain("ran out of context");
  expect(failed[1]).toContain("the provider refused");
});

test("everything else is counted rather than listed", () => {
  const digest = renderDigest([
    row("turn_stopped", "session_aaaaaaaa", "[wake: stopped] one"),
    row("turn_stopped", "session_bbbbbbbb", "[wake: stopped] two"),
    row("peer_message", "session_cccccccc", "a session sent a message"),
  ])!;
  expect(digest.text).toContain("- 2 turns were stopped");
  expect(digest.text).toContain("- 1 message from other sessions");
  expect(digest.text).not.toContain("…aaaaaa");
});

test("the block is capped, and what did not fit is one line naming the call that finds it", () => {
  const rows = Array.from({ length: 200 }, (_, index) => row("turn_failed", `session_${String(index).padStart(8, "0")}`, `[wake: failed] ${"x".repeat(120)}`));
  const digest = renderDigest(rows)!;
  expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  expect(digest.overflow).toBe(200);
  expect(digest.text).toContain("and 200 more — sessions_find to see them.");
  // EVERY ROW IS STILL ACCOUNTED FOR. The digest reported them — as a count for
  // the ones it could not spell out — so the turn marks all of them read rather
  // than growing a tail that re-renders at the top of every turn for ever.
  expect(digest.rowIds).toHaveLength(200);
});

test("a band that fits is emitted whole, and only the bands past the cap are counted", () => {
  const rows = [
    row("request_opened", "session_aaaaaaaa", "[wake: waiting] answer me"),
    ...Array.from({ length: 60 }, (_, index) => row("turn_failed", `session_f${String(index).padStart(7, "0")}`, `[wake: failed] ${"y".repeat(100)}`)),
  ];
  const digest = renderDigest(rows)!;
  expect(digest.text).toContain("WAITING ON YOU");
  // The failures crossed the ceiling, so the whole band is counted rather than
  // half-listed: a digest that stopped mid-band would leave a reader unable to
  // tell a short list from a truncated one.
  expect(digest.overflow).toBe(60);
  expect(digest.text.split("\n").filter((line) => line.startsWith("- FAILED"))).toHaveLength(0);
});

/* ------------------------------------------------------------------ *
 * And in a turn.
 * ------------------------------------------------------------------ */

class ScriptedChatModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  constructor(private readonly script: string[] = []) {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const text = this.script[this.seen.length - 1] ?? "noted";
    return { generations: [{ text, message: new AIMessage({ content: text }) }] };
  }
}

function runtime() {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-digest-"));
  const model = new ScriptedChatModel();
  const agent = new AgentRuntime({ engineRoot, tools: () => [], model: () => model });
  agent.patch({ enabled: true });
  return { agent, model, engineRoot };
}

async function until(check: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const wakeOf = (sessionId: string, runId: string, kind: WakeKind, body: string) =>
  wakeNotification({ wakeKind: kind, targetSessionId: sessionId, runId, body });

/** The system prompt of the last lap — where the digest rides. */
const systemOf = (model: ScriptedChatModel): string => {
  const first = model.seen.at(-1)?.[0];
  return first instanceof SystemMessage ? String(first.content) : "";
};

test("a human-started turn opens with the digest, and its rows are read when the turn ends", async () => {
  const { agent, model } = runtime();
  agent.wake({ notification: wakeOf("session_peer", "run_9", "turn_completed", "[wake: completed] Session session_peer — turn run_9 completed.") });
  expect(agent.state().inboxUnread).toBe(1);

  agent.submit({ text: "what happened?" });
  await until(() => agent.state().running === false && agent.state().runId === undefined, "the turn");

  // THE DIGEST IS IN THE SYSTEM MESSAGE, not in the person's. It is engine prose
  // and #550 is exactly about engine prose not riding the channel a person
  // types on — and the system message is rebuilt per turn, so turn forty does
  // not re-read turn three's news.
  expect(systemOf(model)).toContain("what happened since your last turn");
  expect(systemOf(model)).toContain("…n_peer");
  const human = model.seen.at(-1)!.at(-1)!;
  expect(String(human.content)).toBe("what happened?");

  expect(agent.state().inboxUnread).toBe(0);
  expect(agent.inbox().rows[0]!.read).toBe(true);
  agent.close();
});

test("the transcript keeps the person's words alone — the digest is not in the row", async () => {
  const { agent } = runtime();
  agent.wake({ notification: wakeOf("session_peer", "run_9", "turn_failed", "[wake: failed] it fell over") });
  agent.submit({ text: "status?" });
  await until(() => agent.state().running === false, "the turn");
  const user = agent.thread({ limit: 50 }).rows.find((each) => each.kind === "user_message")!;
  expect(user.detail.text).toBe("status?");
  agent.close();
});

test("a second turn with nothing new does not repeat the digest", async () => {
  const { agent, model } = runtime();
  agent.wake({ notification: wakeOf("session_peer", "run_9", "turn_completed", "[wake: completed] done") });
  agent.submit({ text: "first" });
  await until(() => agent.state().running === false, "the first turn");
  agent.submit({ text: "second" });
  await until(() => agent.state().running === false && agent.state().queued === 0, "the second turn");
  expect(systemOf(model)).not.toContain("what happened since your last turn");
  agent.close();
});

test("a turn stopped before it reached the model leaves the news unread", async () => {
  const { agent } = runtime();
  agent.wake({ notification: wakeOf("session_peer", "run_9", "turn_completed", "[wake: completed] done") });
  const { runId } = agent.submit({ text: "go" });
  // Stopped in the same tick the turn was queued in: the pump has not built a
  // prompt yet, so nothing has been shown to anyone.
  agent.cancel(runId);
  await until(() => agent.state().running === false && agent.state().queued === 0, "the stop");
  expect(agent.state().inboxUnread).toBe(1);
  agent.close();
});
