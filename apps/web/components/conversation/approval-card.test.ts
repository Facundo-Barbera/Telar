// THE CONSENT SURFACE MUST NOT LIE ABOUT ITS OWN STATE.
//
// `ApprovalCard` shipped with the header rendered unconditionally, so a card the
// user had already answered read "TOOL CALL — AWAITING YOUR APPROVAL" directly
// above a badge reading `Allowed`. No wrong action was reachable — the buttons
// leave the DOM the moment a card resolves — but a false label on the one
// surface whose whole job is asking a human for consent is worth a guard.
//
// HONEST GAP: there is no DOM harness in this repository (no *.test.tsx, no
// testing-library, no jsdom — story 3.1's hard rule 9) and this story is not
// allowed to add one. So nothing here proves the `<p>` disappears. What it
// proves is the DECISION that governs it, which is why that decision was pulled
// out of the JSX into a pure function: the shape of a claim decides whether it
// can be checked at all.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  ADVANCE_APPROVAL_LABELS,
  PENDING_APPROVAL_HEADER,
  TOOL_APPROVAL_LABELS,
  approvalHeader,
} from "./approval-card";

describe("approvalHeader — the header labels a MOMENT, not a card", () => {
  test("a PENDING card carries the header, defaulted or caller-supplied", () => {
    expect(approvalHeader("pending")).toBe(PENDING_APPROVAL_HEADER);
    expect(approvalHeader("pending", "node advance — awaiting your approval")).toBe(
      "node advance — awaiting your approval",
    );
  });

  test("a RESOLVED card carries NO header, in either direction", () => {
    // The regression: this returned "tool call — awaiting your approval" for a
    // card whose badge already read `Allowed`.
    expect(approvalHeader("allowed")).toBeNull();
    expect(approvalHeader("denied")).toBeNull();
  });

  test("a caller-supplied header does not survive resolution either", () => {
    // The gate-card vocabulary is written in the same awaiting-you voice, so
    // honouring an explicit header on a resolved card would re-open the hole
    // through the gallery's own approval lane.
    expect(approvalHeader("allowed", "node advance — awaiting your approval")).toBeNull();
    expect(approvalHeader("denied", "node advance — awaiting your approval")).toBeNull();
  });

  test("a sub-agent's card names the agent that is asking", () => {
    // The route gates every tool a sub-agent calls through the same permission
    // path the main turn uses, so parallel agent work produces several cards at
    // once. Until this, they were identical — nothing said who was asking, and
    // a queue of anonymous prompts is a queue nobody can answer.
    const line = approvalHeader("pending", undefined, "agent-7f3c");
    expect(line).toContain("agent-7f3c");
    expect(line).toContain("awaiting your approval");
  });

  test("no agent id keeps the original wording — absent is not 'main'", () => {
    // The common case is a single-agent session, where attributing every card
    // to "main" would be noise on all of them. Absent must therefore read as
    // the plain header, not as an unnamed asker.
    expect(approvalHeader("pending", undefined, undefined)).toBe(PENDING_APPROVAL_HEADER);
  });

  test("an explicit header still wins over the agent attribution", () => {
    // A caller that names the moment (a loom gate, a weave) is naming something
    // MORE specific than who is asking. The asker must not overwrite it.
    expect(approvalHeader("pending", "node advance — awaiting your approval", "agent-7f3c")).toBe(
      "node advance — awaiting your approval",
    );
  });

  test("a resolved card has no header even when an agent asked", () => {
    // The resolved-card rule is the one this file exists to protect; adding a
    // third argument must not create a path around it.
    expect(approvalHeader("allowed", undefined, "agent-7f3c")).toBeNull();
    expect(approvalHeader("denied", undefined, "agent-7f3c")).toBeNull();
  });

  test("both shipped vocabularies really are written in the awaiting-you voice", () => {
    // Re-derived from the exported constants rather than restated, so the rule
    // above cannot quietly stop applying to the copy it was written for
    // (story 2.1's `allow: []` survived a commit by being a restated literal).
    expect(PENDING_APPROVAL_HEADER).toContain("awaiting your approval");
    expect(TOOL_APPROVAL_LABELS.allow).toBe("Allow once");
    expect(TOOL_APPROVAL_LABELS.deny).toBe("Deny");
    // The gate vocabulary has no "always" affordance — "always approve this
    // node advance" is meaningless — and its absence is what suppresses the
    // rule row, so it is asserted rather than assumed.
    expect(ADVANCE_APPROVAL_LABELS.always).toBeUndefined();
  });
});
