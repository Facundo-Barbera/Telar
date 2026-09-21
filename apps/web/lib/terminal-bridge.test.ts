/**
 * THE RULE UNDER TEST IS A RULE ABOUT THE MODEL, not about wording: `unknown`
 * is not a rounding of `exited`, and a sentence that lets a reader treat a
 * shell Telar lost track of as finished is the defect the fate model exists to
 * prevent (docs/terminal-host.md §3).
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { describeTerminalEnding, endTerminalForTab, TERMINAL_ID_PARAM, type TerminalBridge } from "@/lib/terminal-bridge";
import { addShell, emptyWorkspace, nextShellId, setShellTerminal, workspaceParams, TERMINAL_WORKSPACE_PARAM } from "@/lib/terminal-workspace";

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

  /**
   * THE LOAD-BEARING CASE. Asserting a substring is present would be weak —
   * both an `exited` and an `unknown` sentence contain the word "shell" — so
   * this asserts what `unknown` must NOT be able to say, which is the thing a
   * reader would act on.
   */
  test("`unknown` never reads as finished", () => {
    const sentence = describeTerminalEnding({
      id: "t",
      fate: "unknown",
      pid: 5150,
      reason: "Telar could not signal this terminal's process group (pid 5150): EPERM",
    });
    expect(sentence).toContain("lost track");
    expect(sentence).toContain("5150");
    for (const forbidden of ["exited", "finished", "ended on", "Shell ended."]) {
      expect(sentence).not.toContain(forbidden);
    }
  });

  test("`unknown` with no reason still refuses to claim the process is gone", () => {
    const sentence = describeTerminalEnding({ id: "t", fate: "unknown" });
    expect(sentence).toContain("may still be running");
    expect(sentence).not.toContain("exited");
  });
});

describe("endTerminalForTab", () => {
  function fake() {
    const killed: Array<{ id: string; signal?: string }> = [];
    const bridge = {
      kill: async (id: string, signal?: string) => {
        killed.push({ id, ...(signal === undefined ? {} : { signal }) });
        return { ok: true };
      },
    } as unknown as TerminalBridge;
    return { bridge, killed };
  }

  /** A tab carrying a strip of `n` shells, each attached to its own PTY. */
  function withShells(...terminals: string[]): Record<string, string> {
    let state = emptyWorkspace();
    for (const terminal of terminals) {
      const id = nextShellId(state);
      state = setShellTerminal(addShell(state, id), id, terminal);
    }
    return workspaceParams(state);
  }

  test("a closing terminal tab ends its shell", () => {
    const { bridge, killed } = fake();
    expect(endTerminalForTab(withShells("term_1"), bridge)).toEqual(["term_1"]);
    expect(killed).toEqual([{ id: "term_1", signal: "SIGTERM" }]);
  });

  /**
   * THE WHOLE POINT OF THE STRIP, from the reaper's side. Three shells live in
   * one outer tab now, and a reaper that killed only the first would leave two
   * running in the host with nothing on screen attached to them — which is the
   * `unknown` fate W1 reports and nobody can act on.
   */
  test("closing an outer tab with three shells kills three PTYs", () => {
    const { bridge, killed } = fake();
    expect(endTerminalForTab(withShells("term_1", "term_2", "term_3"), bridge)).toEqual(["term_1", "term_2", "term_3"]);
    expect(killed).toEqual([
      { id: "term_1", signal: "SIGTERM" },
      { id: "term_2", signal: "SIGTERM" },
      { id: "term_3", signal: "SIGTERM" },
    ]);
  });

  test("a shell still waiting on its spawn is skipped, not killed by empty id", () => {
    const { bridge, killed } = fake();
    // Two chips, one of which never got a PTY back.
    const params = workspaceParams(addShell(setShellTerminal(addShell(emptyWorkspace()), "shell", "term_1")));
    expect(endTerminalForTab(params, bridge)).toEqual(["term_1"]);
    expect(killed.length).toBe(1);
  });

  test("a tab written before the strip existed still has its one shell ended", () => {
    // The upgrade path: a Terminal opened by the previous build carries a bare
    // PTY id, and it must not survive its tab being closed.
    const { bridge, killed } = fake();
    expect(endTerminalForTab({ [TERMINAL_ID_PARAM]: "term_old" }, bridge)).toEqual(["term_old"]);
    expect(killed).toEqual([{ id: "term_old", signal: "SIGTERM" }]);
  });

  test("a tab that never attached to one kills nothing", () => {
    // The panel calls this for any terminal tab; one closed before its PTY
    // answered has no id, and a kill with an empty id would be a bug wearing a
    // no-op's clothes.
    const { bridge, killed } = fake();
    expect(endTerminalForTab({}, bridge)).toEqual([]);
    expect(endTerminalForTab({ [TERMINAL_ID_PARAM]: "" }, bridge)).toEqual([]);
    expect(endTerminalForTab({ [TERMINAL_WORKSPACE_PARAM]: "not json" }, bridge)).toEqual([]);
    expect(killed).toEqual([]);
  });

  test("outside the desktop shell it is a no-op rather than a throw", () => {
    expect(endTerminalForTab(withShells("term_1"), undefined)).toEqual([]);
  });

  test("a kill that rejects does not take the tab close down with it", async () => {
    // The renderer learns of an exit asynchronously, so closing a tab whose
    // shell has just died is the normal case, not an error.
    const angry = { kill: async () => Promise.reject(new Error("gone")) } as unknown as TerminalBridge;
    expect(endTerminalForTab(withShells("term_1", "term_2"), angry)).toEqual(["term_1", "term_2"]);
    await Promise.resolve();
  });
});
