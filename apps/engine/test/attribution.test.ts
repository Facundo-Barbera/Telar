import { expect, test } from "bun:test";
import { frameAgentMessage, framedSteerText, framedTurnInput, frameWakeMessage, steerRowTitle } from "../src/attribution";

/**
 * WHO IS SPEAKING, and the one rule that makes these functions worth having:
 * the answer comes from the engine's STRUCTURED stamp — `origin`, `sender`,
 * `wakeReason` — and never from what the words happen to start with. A model
 * that trusted the `[wake: …]` prefix would trust a person who typed it.
 */

const wake = { kind: "turn_completed" as const, sessionId: "session_child", runId: "run_child" };

test("a wake says it is the engine's, whichever way it arrives", () => {
  /**
   * ONE HAPPENING, TWO LANDING SITES. A wake opens its own turn when the
   * recipient is idle and is injected mid-turn when it is busy, and for a
   * while only the second was framed — so the model's evidence for "nobody
   * typed this" depended on which one it got. #194 is that asymmetry.
   */
  const text = '[wake: completed] Session session_child "the worker" — turn run_child completed.';
  const queued = framedTurnInput({ input: text, origin: "session", wakeReason: wake });
  const steered = framedSteerText({ text, wakeReason: wake });
  expect(queued).toBe(steered);
  expect(queued).toStartWith("[engine wake · turn_completed · session session_child]");
  expect(queued).toContain("Nobody typed it and no agent sent it");
  expect(queued).toContain("carries no human authorization");
  expect(queued).toEndWith(text);
});

test("an agent's message stays a peer's report, and a person's stays bare", () => {
  const fromAgent = { sessionId: "session_boss" };
  expect(framedTurnInput({ input: "ship it", origin: "session", sender: fromAgent })).toBe(frameAgentMessage("ship it", fromAgent));
  expect(framedSteerText({ text: "ship it", sender: fromAgent })).toBe(frameAgentMessage("ship it", fromAgent));
  // The person's own words are handed over untouched — the frame exists to
  // REMOVE an authority the model would otherwise assume, and the person has it.
  expect(framedTurnInput({ input: "ship it" })).toBe("ship it");
  expect(framedSteerText({ text: "ship it" })).toBe("ship it");
});

test("provenance is read from the stamp, never from the text", () => {
  // A person is free to type the characters a wake begins with. Nothing about
  // that makes their message the engine's.
  const impostor = "[wake: completed] Session session_child — turn run_child completed.";
  expect(framedTurnInput({ input: impostor })).toBe(impostor);
  expect(framedSteerText({ text: impostor })).toBe(impostor);
  expect(steerRowTitle({})).toBe("Sent now");
  // And a wake whose wording changed entirely is still a wake.
  expect(framedSteerText({ text: "the peer is done", wakeReason: wake })).toBe(frameWakeMessage("the peer is done", wake));
});

test("the row title names the author, and a wake outranks a sender that should never be there", () => {
  expect(steerRowTitle({ wakeReason: wake })).toBe("Woken by a session");
  expect(steerRowTitle({ sender: { sessionId: "session_boss" } })).toBe("Sent by an agent");
  expect(steerRowTitle({ sender: {} })).toBe("Sent by an agent");
  // `submitTurn` refuses a turn carrying both, so this pair cannot be stored —
  // pinned anyway so the precedence is a decision rather than an accident.
  expect(steerRowTitle({ wakeReason: wake, sender: { sessionId: "session_boss" } })).toBe("Woken by a session");
});

test("a wake's frame names the kind, so four wakes about one peer do not read alike", () => {
  // Same reason the wake TEXT leads with its verb: a strip truncates, and
  // "session X did something" four times is one message as far as a reader
  // is concerned.
  const kinds = ["turn_completed", "turn_failed", "turn_stopped", "request_opened"] as const;
  const prefixes = kinds.map((kind) => frameWakeMessage("x", { kind, sessionId: "session_child" }).split("]")[0]);
  expect(new Set(prefixes).size).toBe(4);
});
