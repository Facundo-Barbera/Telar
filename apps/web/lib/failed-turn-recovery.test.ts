// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { actionableRequests, continuationDraft, recoverableFailedTurn, type RecoverableTurn } from "./failed-turn-recovery";

const turn = (runId: string, state: RecoverableTurn["state"], extra: Partial<RecoverableTurn> = {}): RecoverableTurn => ({ runId, state, ...extra });

describe("recoverableFailedTurn", () => {
  test("offers the latest human turn when it failed and the session is idle", () => {
    const failed = turn("run_2", "failed", { failure: "the CLI died" });
    expect(recoverableFailedTurn([turn("run_1", "completed"), failed])).toBe(failed);
  });

  test("offers nothing when the latest turn did not fail", () => {
    expect(recoverableFailedTurn([turn("run_1", "failed"), turn("run_2", "completed")])).toBeUndefined();
    expect(recoverableFailedTurn([turn("run_1", "failed"), turn("run_2", "stopped")])).toBeUndefined();
    expect(recoverableFailedTurn([])).toBeUndefined();
  });

  test("hides while another turn is queued, claimed, running or steering", () => {
    for (const state of ["queued", "claimed", "running", "steering"] as const) {
      expect(recoverableFailedTurn([turn("run_1", "failed"), turn("run_2", state)])).toBeUndefined();
    }
  });

  test("never treats an ambiguous turn as an ordinary failure, but no longer hides behind one", () => {
    expect(recoverableFailedTurn([turn("run_1", "ambiguous")])).toBeUndefined();
    /**
     * An ambiguous turn elsewhere USED to suppress this, and that suppression
     * was the last thing keeping a recovered session from behaving like an
     * ordinary conversation. The two decisions are separate: the ambiguous
     * turn's card offers its own verbs, and this offers a continuation for the
     * failed one. Dispatch is held engine-side either way, so nothing runs
     * before somebody decides.
     */
    const failed = turn("run_2", "failed");
    expect(recoverableFailedTurn([turn("run_1", "ambiguous"), failed])).toBe(failed);
  });

  test("offers a continuation for a turn Telar interrupted by quitting", () => {
    // A clean quit now settles the turn as `failed` with `interrupted` rather
    // than leaving it for the next boot to call ambiguous — so it arrives here,
    // at the ordinary continuation, with no decision to make.
    const interrupted = turn("run_1", "failed", { failure: "Telar shut down while this turn was running." });
    expect(recoverableFailedTurn([interrupted])).toBe(interrupted);
  });

  test("looks past compaction and provider-started turns to the last human one", () => {
    const failed = turn("run_1", "failed");
    expect(recoverableFailedTurn([failed, turn("run_2", "failed", { kind: "compact" })])).toBe(failed);
    expect(recoverableFailedTurn([failed, turn("run_3", "completed", { origin: "provider" })])).toBe(failed);
    // ...but a later human turn that succeeded settles it.
    expect(recoverableFailedTurn([failed, turn("run_4", "completed")])).toBeUndefined();
  });
});

describe("actionableRequests", () => {
  const request = (id: string, runId: string, state: "open" | "resolved" = "open") => ({ id, runId, state });

  test("a question left open on a failed turn is not actionable, so the composer is not trapped in answer mode", () => {
    // The provider was killed while parked on AskUserQuestion; the engine
    // marked the turn failed. A stale snapshot may still carry the request
    // as open — it must not block the continuation the failed turn offers.
    const turns = [turn("run_1", "completed"), turn("run_2", "failed", { failure: "Claude Code process terminated by signal SIGKILL" })];
    const requests = [request("req_q", "run_2")];
    expect(actionableRequests(requests, turns)).toEqual([]);
    // ...and the failed turn's continuation is still offered, into the draft.
    const recoverable = recoverableFailedTurn(turns);
    expect(recoverable?.runId).toBe("run_2");
    const draft = continuationDraft("Keep the existing checkpoint; do not repeat the wait.", recoverable!);
    expect(draft.startsWith("Keep the existing checkpoint; do not repeat the wait.\n\n")).toBe(true);
    expect(draft).toContain("SIGKILL");
  });

  test("requests on a live or ambiguous turn stay actionable; resolved ones never are", () => {
    const turns = [turn("run_1", "running"), turn("run_2", "ambiguous"), turn("run_3", "stopped")];
    const live = request("req_live", "run_1");
    const undecided = request("req_amb", "run_2");
    expect(actionableRequests([live, undecided, request("req_stopped", "run_3"), request("req_done", "run_1", "resolved")], turns)).toEqual([live, undecided]);
    // A request whose turn is not in the (paged) transcript is left alone.
    const unknown = request("req_unknown", "run_9");
    expect(actionableRequests([unknown], turns)).toEqual([unknown]);
  });
});

describe("continuationDraft", () => {
  test("names the failure and asks to continue, never replaying the prompt", () => {
    const draft = continuationDraft("", { failure: "the CLI died" });
    expect(draft).toBe("The previous turn ended early (the CLI died). Continue from the work that already exists above; do not redo it.");
  });

  test("omits the parenthetical when there is no recorded reason", () => {
    expect(continuationDraft("", {})).toBe("The previous turn ended early. Continue from the work that already exists above; do not redo it.");
    expect(continuationDraft("", { failure: "   " })).not.toContain("(");
  });

  test("keeps an existing draft and appends after it", () => {
    const draft = continuationDraft("Also fix the tests  \n", { failure: "boom" });
    expect(draft.startsWith("Also fix the tests\n\n")).toBe(true);
    expect(draft.endsWith("do not redo it.")).toBe(true);
  });

  test("with no provider cursor it says the agent will not remember, and never points at work it cannot see", () => {
    // The lost turn died before the provider announced itself, so the next turn
    // cold-starts: Telar still has the transcript, the agent has nothing.
    const draft = continuationDraft("", { failure: "Telar was restarted" }, false);
    expect(draft).toContain("could not be resumed");
    expect(draft).toContain("you will not remember it");
    expect(draft).not.toContain("Continue from the work that already exists above");
  });
});
