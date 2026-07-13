// M11 finding-1 (docs/m11-discuss-iteration.md §1) — the blocked-loom "Discuss
// with the orchestrator" chat opens with a REAL agent turn (a genuine
// verification proposal), auto-fired AFTER the human clicks Discuss, instead of
// a render-only greeting. These unit-test the PURE seam both the client
// (session-view.tsx) and the server (route.ts) drive through
// (@/lib/escalation-kickoff) — the full component/route paths are too heavy to
// mount here, so we pin the exact contract at the shared boundary:
//   • the one-shot mount-fire guard (client),
//   • the sentinel → server-authored prompt substitution (route.ts turn-1),
//   • the moat: passthrough is byte-identical for every non-kickoff turn.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dep of this Next app,
// so the web tsconfig can't resolve it — suppress the import exactly like the
// sibling lib/*.test.ts files. The runtime is `bun test`.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  ESCALATION_KICKOFF_PROMPT,
  ESCALATION_KICKOFF_SENTINEL,
  isEscalationKickoff,
  resolveEscalationMessage,
  shouldFireEscalationKickoff,
} from "./escalation-kickoff";

describe("shouldFireEscalationKickoff (client one-shot mount guard)", () => {
  const fresh = {
    escalation: true,
    sessionId: null,
    messagesLength: 0,
    alreadyFired: false,
  };

  test("fires exactly for a fresh, un-fired escalation surface", () => {
    expect(shouldFireEscalationKickoff(fresh)).toBe(true);
  });

  test("never re-fires once the ref guard is set (one-shot)", () => {
    expect(shouldFireEscalationKickoff({ ...fresh, alreadyFired: true })).toBe(false);
  });

  test("does not fire once a session id exists (remount-with-session)", () => {
    expect(shouldFireEscalationKickoff({ ...fresh, sessionId: "sess_1" })).toBe(false);
  });

  test("does not fire once the transcript is non-empty (a turn already ran)", () => {
    expect(shouldFireEscalationKickoff({ ...fresh, messagesLength: 1 })).toBe(false);
  });

  test("NEVER fires for a non-escalation session (planner/steerer/plain)", () => {
    // The escalation prop is the only auto-fire trigger — a plain or planner
    // session with an empty transcript must stay silent (no auto-POST).
    expect(shouldFireEscalationKickoff({ ...fresh, escalation: false })).toBe(false);
    expect(shouldFireEscalationKickoff({ ...fresh, escalation: undefined })).toBe(false);
  });
});

describe("isEscalationKickoff (server turn-1 recognition)", () => {
  test("true only for escalation role + fresh session + the exact sentinel", () => {
    expect(isEscalationKickoff("escalation", null, ESCALATION_KICKOFF_SENTINEL)).toBe(true);
    expect(isEscalationKickoff("escalation", undefined, ESCALATION_KICKOFF_SENTINEL)).toBe(true);
  });

  test("false on a resumed session — a real typed reply is turn N, not a kickoff", () => {
    expect(isEscalationKickoff("escalation", "sess_1", ESCALATION_KICKOFF_SENTINEL)).toBe(false);
  });

  test("false for any other wire role carrying the sentinel", () => {
    expect(isEscalationKickoff("planner", null, ESCALATION_KICKOFF_SENTINEL)).toBe(false);
    expect(isEscalationKickoff("steerer", null, ESCALATION_KICKOFF_SENTINEL)).toBe(false);
    expect(isEscalationKickoff(undefined, null, ESCALATION_KICKOFF_SENTINEL)).toBe(false);
  });

  test("false for a genuine human escalation message (not the sentinel)", () => {
    expect(isEscalationKickoff("escalation", null, "I think bun test is the check")).toBe(false);
    expect(isEscalationKickoff("escalation", null, "")).toBe(false);
  });
});

describe("resolveEscalationMessage (what actually drives the model)", () => {
  test("kickoff: the sentinel is swapped for the server-authored proposal prompt", () => {
    const out = resolveEscalationMessage("escalation", null, ESCALATION_KICKOFF_SENTINEL);
    expect(out).toBe(ESCALATION_KICKOFF_PROMPT);
    // The model never sees the opaque sentinel — it is replaced before query().
    expect(out).not.toBe(ESCALATION_KICKOFF_SENTINEL);
  });

  test("the kickoff prompt instructs an agent-FIRST verification proposal", () => {
    // Not the exact wording (that can evolve), but the load-bearing intent: open
    // with a concrete proposal and route it through the human-gated tool.
    const p = ESCALATION_KICKOFF_PROMPT.toLowerCase();
    expect(p).toContain("propos");
    expect(p).toContain("verif");
    expect(p).toContain("answer_blocked");
  });

  test("MOAT: every non-kickoff turn is passed through byte-identical", () => {
    // Real escalation reply on a resumed session — the human's own words reach
    // the model untouched.
    const reply = "let's use bun run build";
    expect(resolveEscalationMessage("escalation", "sess_1", reply)).toBe(reply);
    // Other session kinds are never rewritten, even if they somehow carried the
    // sentinel text (they can't reach this branch anyway).
    expect(resolveEscalationMessage("planner", null, "plan a loom")).toBe("plan a loom");
    expect(resolveEscalationMessage("steerer", null, "steer it")).toBe("steer it");
    expect(resolveEscalationMessage(undefined, null, "plain chat")).toBe("plain chat");
    expect(resolveEscalationMessage("planner", null, ESCALATION_KICKOFF_SENTINEL)).toBe(
      ESCALATION_KICKOFF_SENTINEL,
    );
  });
});

describe("sentinel opacity (no human can accidentally trigger the kickoff)", () => {
  test("the sentinel is a reserved token, not a plausible human sentence", () => {
    expect(ESCALATION_KICKOFF_SENTINEL.startsWith("__")).toBe(true);
    expect(ESCALATION_KICKOFF_SENTINEL).not.toContain(" ");
  });
});
