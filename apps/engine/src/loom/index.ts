/**
 * Loom — the perpetual orchestrator (`docs/plans/loom-build.md`).
 *
 * This barrel carries the PURE half: markdown in, decisions out, no filesystem,
 * no network, no child processes. The store owns the subtree under
 * `<engineRoot>/looms/`, the runtime owns worktrees, sessions and the gate
 * commands, and neither of them is re-exported here — the boundary is what lets
 * every rule in these files be tested against a string.
 *
 * Dependency order, which is also reading order:
 *   program        the artifact: markdown ⇄ `LoomProgram`, and the presets
 *   gates          tri-state classification; the only yes/no needs a policy
 *   machine        the loom lifecycle, as a table that throws on illegal moves
 *   ladder         escalate to the orchestrator before ever waking the human
 *   sentinel       "did anything change?" for the cost of one command
 *   triage         the cache that makes reading a backlog affordable
 *   ledger-format  one JSON object per line, and a reader that skips a torn one
 *   decide         the agent proposes, this refuses — loudly, never silently
 */
export * from "./program";
export * from "./gates";
export * from "./machine";
export * from "./ladder";
export * from "./sentinel";
export * from "./triage";
export * from "./ledger-format";
export * from "./decide";
