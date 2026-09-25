/**
 * WHAT A PERSON READS WHEN A TERMINAL ENDS. Two fates, and the sentences
 * differ in kind: one reports an observed exit, one a refusal to start.
 *
 * `unknown` IS GONE. It meant "Telar stopped vouching for this process" and
 * existed to hold the one-deployment slot; the terminal now owns its process
 * and the host never produces it. The tab's reaper that used to live here is
 * `closeTerminalTab`, tested in lib/terminal-close.test.ts.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { describeTerminalEnding } from "@/lib/terminal-bridge";

describe("describeTerminalEnding", () => {
  test("an observed exit says so, with its status", () => {
    expect(describeTerminalEnding({ id: "t", fate: "exited", exitCode: 0 })).toBe("Shell exited.");
    expect(describeTerminalEnding({ id: "t", fate: "exited", exitCode: 127 })).toContain("127");
    expect(describeTerminalEnding({ id: "t", fate: "exited", signal: "SIGTERM" })).toContain("SIGTERM");
  });

  test("a nonzero status is REPORTED rather than reinterpreted", () => {
    // A missing binary and an unusable cwd both fork fine and fail inside the
    // child, so each arrives as a nonzero `exited` (126 and 1, measured by W1),
    // never as `failed`. "The command was wrong" is read off the code by a
    // human; this surface does not guess which of the two it was.
    expect(describeTerminalEnding({ id: "t", fate: "exited", exitCode: 126 })).toContain("126");
  });

  test("`failed` says no process ever existed", () => {
    const sentence = describeTerminalEnding({ id: "t", fate: "failed", error: "ENOENT" });
    expect(sentence).toContain("never started");
    expect(sentence).toContain("ENOENT");
  });

  test("a terminal the host closed on purpose says closed, not the signal that did it", () => {
    // The SIGTERM is how a close works, not news about the process.
    const sentence = describeTerminalEnding({ id: "t", fate: "exited", signal: "SIGTERM", closed: "session" });
    expect(sentence).toBe("Shell closed.");
  });
});
