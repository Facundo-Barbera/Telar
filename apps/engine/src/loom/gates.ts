/**
 * GATES ARE TRI-STATE. There is no boolean in this file, and one must never be
 * introduced: not as a return, not as a parameter, not as a `ok` field on a
 * result. `shouldPublish` is the ONLY function here that answers yes/no, and it
 * can only do so because it has been handed the project's `onUnknown` policy —
 * which is the point. Every other boolean anyone is tempted to add here is a
 * place where `unknown` gets rounded to `pass` or `fail`, and both roundings
 * are wrong in ways that cost real money: `unknown → pass` opens red PRs and
 * burns CI minutes at 3am, `unknown → fail` throws away work that was fine.
 *
 * ── AN UNDECLARED EXIT CODE IS `unknown`, NEVER `fail` ───────────────────────
 * Including exit 0. This is the rule the whole design turns on. A project's
 * `scripts/ci.ts` may exit 2 for "nothing failed, but the pgTAP suite skipped
 * because Docker is down", and its own docs are explicit that this is not
 * permission to proceed. A system that assumes non-zero-means-fail gets that
 * wrong; a system that assumes zero-means-go gets it wrong in the other
 * direction. So the exit table is per project, declared in the Program, and
 * anything it does not mention is a code we have no statement about — which is
 * the literal definition of `unknown`.
 *
 * ── THE WORKER NEVER RUNS THE GATE ───────────────────────────────────────────
 * Running the command is the harness's job, in the worktree, after the session
 * has exited. This file only classifies what came back. Prompting an agent to
 * "always run the gate" is weak — agents skip things under pressure, especially
 * late in a long task — and the worker cannot skip what it was never holding.
 */
import type { GateOutcome, GateUnknownPolicy, LoomGate, LoomGateResult } from "@telar/engine-client";

/**
 * One exit code, through one gate's table.
 *
 * A code the table does not mention is `unknown`. So is a non-integer or a
 * missing one — `exitCode` is `number | null` upstream because a command can be
 * killed before it produces a code at all, and "we never got an answer" is the
 * same epistemic state as "we got an answer nobody has defined".
 */
export function classifyExit(exitCode: number | null | undefined, gate: LoomGate): GateOutcome {
  if (exitCode === null || exitCode === undefined || !Number.isInteger(exitCode)) return "unknown";
  return gate.exits[exitCode] ?? "unknown";
}

/**
 * The whole gate suite, folded into one outcome.
 *
 * PRECEDENCE IS fail > unknown > pass, and the order is not arbitrary. A single
 * `fail` is a fact — something ran and said no — so it decides regardless of
 * what else happened. Absent a fail, a single `unknown` poisons the batch,
 * because "four gates passed and one could not run" is not four-fifths of a
 * pass; it is an unverified result with some evidence attached. Only a suite
 * where every gate reported `pass` is a pass.
 *
 * `blocking` names the result that decided it, so the loom's stuck reason can
 * say WHICH gate rather than "gates failed". An empty suite is `pass`: a
 * project that declared no gates has asked for none, and inventing an `unknown`
 * would hold every PR it ever produces.
 */
export function decideAfterGates(
  results: LoomGateResult[],
  gates: LoomGate[],
): { outcome: GateOutcome; blocking?: LoomGateResult } {
  void gates; // the table has already been applied; kept for signature symmetry
  const failed = results.find((r) => r.outcome === "fail");
  if (failed) return { outcome: "fail", blocking: failed };
  const unknown = results.find((r) => r.outcome === "unknown");
  if (unknown) return { outcome: "unknown", blocking: unknown };
  return { outcome: "pass" };
}

/**
 * The one yes/no in this file, and it needs the policy to produce it.
 *
 * `hold` is the recommended default: the failure mode of holding is a PR you
 * did not get and can ask for in the morning; the failure mode of publishing is
 * red CI in a shared repo, which is noisy, costs Actions minutes and lands in
 * someone else's inbox.
 */
export function shouldPublish(outcome: GateOutcome, onUnknown: GateUnknownPolicy): boolean {
  if (outcome === "pass") return true;
  if (outcome === "fail") return false;
  return onUnknown === "publish";
}

/**
 * The suite's policy: the STRICTEST any of its gates declared.
 *
 * If any single gate says `hold` on unknown, the suite holds. A project that
 * marked one gate as must-be-certain has said something specific, and letting a
 * more relaxed sibling override it would quietly delete that statement. With no
 * gates at all there is nothing to be uncertain about and the default `hold`
 * applies to nothing.
 */
export function suiteUnknownPolicy(gates: LoomGate[]): GateUnknownPolicy {
  return gates.some((g) => g.onUnknown === "hold") || gates.length === 0 ? "hold" : "publish";
}
