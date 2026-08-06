// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  CANCELLED_TOOL_NOTE,
  CLI_INTERRUPTED_TOOL_TEXT,
  isCancelledToolResult,
} from "./tool-cancellation";
import { autoDenialMessage } from "./permission-denial";

describe("isCancelledToolResult", () => {
  test("matches the CLI's interrupted-tool text verbatim", () => {
    expect(isCancelledToolResult(CLI_INTERRUPTED_TOOL_TEXT)).toBe(true);
  });

  test("matches when the CLI wraps or appends to it", () => {
    // Observed in the wild with surrounding content; the signature clause is
    // what is stable, not the whole string.
    expect(isCancelledToolResult(`${CLI_INTERRUPTED_TOOL_TEXT}\n\nsome trailer`)).toBe(true);
    expect(isCancelledToolResult(`prefix: ${CLI_INTERRUPTED_TOOL_TEXT}`)).toBe(true);
  });

  test("is false for absent or empty output", () => {
    expect(isCancelledToolResult(undefined)).toBe(false);
    expect(isCancelledToolResult("")).toBe(false);
  });

  test("is false for ordinary tool output and ordinary errors", () => {
    expect(isCancelledToolResult("hello world")).toBe(false);
    expect(isCancelledToolResult("ENOENT: no such file or directory")).toBe(false);
    // Close in topic, not the signature.
    expect(isCancelledToolResult("The user cancelled the request")).toBe(false);
  });

  // THE LOAD-BEARING GUARANTEE. This detector must never reclassify a real
  // refusal as a cancellation — that would tell a model "nobody refused this,
  // retry" about a call a human or a rule deliberately blocked, which is the
  // accept moat pointing the wrong way. telar's own denial texts are produced by
  // permission-denial.ts, so assert against every branch of it rather than
  // against a hand-written sample that could drift.
  describe("never mistakes one of telar's own denials for a cancellation", () => {
    const SDK_TEXT = CLI_INTERRUPTED_TOOL_TEXT;
    const REASONS = [
      "rule",
      "classifier",
      "workingDir",
      "safetyCheck",
      "sandboxOverride",
      "mode",
      "asyncAgent",
      "hook",
      "subcommandResults",
      "permissionPromptTool",
      "other",
      "somethingTheSdkAddsLater",
    ];

    for (const reason of REASONS) {
      test(`reason=${reason}`, () => {
        const message = autoDenialMessage(reason, "because", SDK_TEXT);
        expect(isCancelledToolResult(message)).toBe(false);
      });
    }

    test("the one exception is documented: no discriminator passes the SDK text through", () => {
      // autoDenialMessage returns the SDK's own text unchanged when it has no
      // discriminator to reason from — deliberately, since it does not know
      // enough to contradict it. In that case the text IS the CLI's interrupted
      // sentence, and calling it a cancellation is CORRECT, not a false
      // positive: nothing else produced it.
      const passthrough = autoDenialMessage(undefined, undefined, SDK_TEXT);
      expect(passthrough).toBe(SDK_TEXT);
      expect(isCancelledToolResult(passthrough)).toBe(true);
    });
  });
});

describe("CANCELLED_TOOL_NOTE", () => {
  test("says it did not run, that nobody refused, and does not tell the reader to stop", () => {
    expect(CANCELLED_TOOL_NOTE).toContain("Cancelled");
    expect(CANCELLED_TOOL_NOTE.toLowerCase()).toContain("nobody refused");
    // The whole point: the CLI's version orders the reader to stop and wait for
    // a human. Ours must not, or it reproduces the bug it exists to fix.
    expect(CANCELLED_TOOL_NOTE).not.toContain("STOP");
    expect(CANCELLED_TOOL_NOTE).not.toContain("wait for the user");
  });
});
