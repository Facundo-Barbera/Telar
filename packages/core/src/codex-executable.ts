// WHERE THE CODEX CLI ACTUALLY IS.
//
// Telar has never bundled Codex, but until now it also never really looked for
// it: the resolver in apps/web/lib/codex-app-server.ts checked CODEX_BIN, then
// /opt/homebrew/bin/codex, then gave up and spawned a bare "codex" for the OS to
// find on PATH. It never checked ~/.local/bin/codex — which is where the
// official standalone installer puts it — so on a machine installed that way
// resolution fell through to PATH. That works from a terminal and is FRAGILE
// FOR A FINDER-LAUNCHED APP, which inherits a minimal environment: the exact
// failure claude-executable.ts exists to prevent, reproduced because the
// resolution lived next to the spawn instead of somewhere both providers share.
//
// NO VERSION GATE, AND THAT IS THE POINT. Claude's statuses come from a real,
// derivable pairing: the npm wrapper telar depends on ships a matching CLI, so
// "the version we expect" is a fact read off package.json. Telar speaks to Codex
// directly over `codex app-server`'s JSON-RPC with no wrapper package in
// between, so there is no version to derive and no supported range anybody has
// declared. Inventing one would be a guess presented as a verdict — and this
// adapter already handles protocol movement the honest way, by recognising both
// spellings of a renamed method (see DYNAMIC_TOOL_METHODS). So Codex reports
// only what is knowable: found and versioned ("ok"), found but silent
// ("unknown"), or absent ("missing"). Only "missing" refuses a turn.

import {
  cliUsable,
  requireCli,
  resolveCli,
  resolveCliAsync,
  type CliResolution,
  type CliSpec,
  type CliStatus,
} from "./cli-resolution";

// NO PRODUCTION CALLER YET, AND THAT IS DELIBERATE — recorded so the next
// reader does not delete them as dead, or assume a gate exists that does not.
//
// `CodexCliStatus` mirrors `ClaudeCliStatus` because the two modules are meant
// to be the same shape read twice; a surface reporting both should never have to
// learn that one of them names its status type and the other does not.
//
// `codexCliUsable` (below) has no production caller because Codex's gate is the
// throw inside `codexExecutablePath()` at the two spawn sites, NOT a pre-flight
// check in the chat route the way Claude's is. It exists for the route-level
// parity that #39 deferred. Until that lands it is exercised only by tests —
// which is worth knowing before trusting it to be enforcing anything.
export type CodexCliStatus = CliStatus;
export type CodexCliResolution = CliResolution;

const CODEX_CLI: CliSpec = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  overrideEnv: "CODEX_BIN",
  installHint:
    "Install the Codex CLI (https://github.com/openai/codex) and sign in, then restart telar. " +
    "If it is installed somewhere unusual, set CODEX_BIN to its full path.",
  // No expectedVersion and no verdict on purpose — see the header.
};

/** Where Codex is, and what version it reports. */
export function resolveCodexCli(): CodexCliResolution {
  return resolveCli(CODEX_CLI);
}

/** The same verdict without blocking the event loop — for HTTP handlers, which
 *  must not stall every other request (including live chat streams) on a
 *  subprocess. Shares the cache and the classification with resolveCodexCli. */
export function resolveCodexCliAsync(): Promise<CodexCliResolution> {
  return resolveCliAsync(CODEX_CLI);
}

/** Whether a Codex turn may proceed. Same rule as Claude's (cliUsable): only a
 *  CLI that is not there at all refuses. A Codex that will not print its version
 *  still answers JSON-RPC perfectly well, and refusing it would lock a user out
 *  of a working install over a cosmetic probe. */
export function codexCliUsable(resolution: CodexCliResolution): boolean {
  return cliUsable(resolution);
}

/** The binary a Codex turn spawns — or a thrown, actionable refusal when there
 *  is none (AD-11). Every entry point that spawns `codex app-server` goes
 *  through this, so the gate cannot be forgotten at one of them. */
export function codexExecutablePath(): string {
  return requireCli(CODEX_CLI);
}
