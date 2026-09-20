/**
 * THE INBOX STRIP — issue #541, section A.
 *
 * What must not drift:
 *
 *   - nothing unread draws nothing at all, because a permanent empty box above
 *     the composer costs the conversation room to say nothing;
 *   - the collapsed header says how many, and says when something is waiting on
 *     a person;
 *   - the rows use the DIGEST'S words and the digest's ranking, so the strip and
 *     the block the model was shown cannot name one happening twice;
 *   - the count behind a capped list is reported rather than silently dropped.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInboxRow } from "@telar/engine-client";
import { agentInboxLabel, rankAgentInbox } from "@/lib/agent/inbox";
import { AgentInbox, agentInboxSummary } from "./agent-inbox";

let nextId = 1;
const row = (kind: AgentInboxRow["kind"], over: Partial<AgentInboxRow> = {}): AgentInboxRow => ({
  id: nextId++,
  at: 1_000,
  sessionId: "session_aaaaaaaa",
  runId: "run_one",
  kind,
  summary: "[wake: completed] Session finished a turn",
  read: false,
  ...over,
});

const render = (rows: AgentInboxRow[], unread = rows.length) =>
  renderToStaticMarkup(<AgentInbox rows={rows} unread={unread} onDismiss={() => {}} />);

describe("what the strip says", () => {
  test("nothing unread draws nothing at all", () => {
    expect(render([])).toBe("");
  });

  test("the collapsed header counts, and names what is waiting on a person", () => {
    expect(agentInboxSummary([row("turn_completed")], 1)).toBe("1 update");
    expect(agentInboxSummary([row("turn_completed"), row("turn_failed")], 2)).toBe("2 updates");
    expect(agentInboxSummary([row("request_opened"), row("turn_completed")], 2)).toBe("2 updates · 1 waiting on you");
  });

  // THE TRUE COUNT, NOT THE PAGE'S. A strip holding a screenful of a hundred
  // waiting rows that said "20 updates" would be the one number a person acts on
  // being quietly wrong.
  test("the header reports the total behind a capped page", () => {
    expect(agentInboxSummary([row("turn_completed")], 47)).toBe("47 updates");
  });

  test("the strip is drawn, collapsed, with the header and a way to clear it", () => {
    const markup = render([row("request_opened")]);
    expect(markup).toContain("Inbox");
    expect(markup).toContain("1 update · 1 waiting on you");
    expect(markup).toContain("Mark all read");
    // COLLAPSED: the summaries are behind the press, so the conversation above
    // keeps the screen.
    expect(markup).not.toContain("Waiting on you</span>");
  });
});

describe("the digest's own vocabulary", () => {
  test("each kind is named the way the block the model read names it", () => {
    expect(agentInboxLabel({ kind: "request_opened" })).toEqual({ verb: "Waiting on you", tone: "warning" });
    expect(agentInboxLabel({ kind: "turn_failed" })).toEqual({ verb: "Failed", tone: "warning" });
    expect(agentInboxLabel({ kind: "turn_completed" })).toEqual({ verb: "Finished", tone: "muted" });
    expect(agentInboxLabel({ kind: "turn_stopped" })).toEqual({ verb: "Stopped", tone: "muted" });
  });

  test("a peer's message is named by what the sender said it was", () => {
    expect(agentInboxLabel({ kind: "peer_message", intent: "task" }).verb).toBe("Assigned work");
    expect(agentInboxLabel({ kind: "peer_message", intent: "blocker" })).toEqual({ verb: "Reported a blocker", tone: "warning" });
    expect(agentInboxLabel({ kind: "peer_message", intent: "result" }).verb).toBe("Sent a result");
    expect(agentInboxLabel({ kind: "peer_message" }).verb).toBe("Sent a message");
  });

  test("the ranking is the digest's: waiting on you, then failed, then the rest newest first", () => {
    const stopped = row("turn_stopped");
    const done = row("turn_completed");
    const failed = row("turn_failed");
    const waiting = row("request_opened");
    expect(rankAgentInbox([stopped, done, failed, waiting]).map((each) => each.kind)).toEqual([
      "request_opened",
      "turn_failed",
      "turn_completed",
      "turn_stopped",
    ]);
  });

  test("within a band the newest leads, because arrival order buries what matters", () => {
    const older = row("turn_completed");
    const newer = row("turn_completed");
    expect(rankAgentInbox([older, newer]).map((each) => each.id)).toEqual([newer.id, older.id]);
  });
});
