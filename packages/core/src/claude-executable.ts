// WHERE THE CLAUDE CLI ACTUALLY IS, AND WHETHER WE CAN TALK TO IT.
//
// The Agent SDK ships an optional ~227MB platform binary and launches it unless
// told otherwise. Telar does not ship it (apps/desktop/build-web.sh) and depends
// on the user's own Claude Code install instead — 36% of the packaged app was a
// binary the resolver below always declined to use.
//
// THE PRICE OF NOT SHIPPING IT is that the wrapper/CLI pairing stops being ours
// to control. The npm wrapper and the CLI speak a control protocol to each
// other; Claude Code updates itself on its own schedule and telar's wrapper
// updates when we ship. Left unchecked that drift is silent, and its failure
// mode is not a clean error — it is protocol-level misbehaviour surfacing as
// phantom tool cancellations nobody can attribute (#28, where a 0.3.204 wrapper
// was found driving a 2.1.222 CLI).
//
// So this resolves the binary AND says whether it is a version we expect to work
// with, and callers refuse the turn rather than degrading quietly (AD-11).
//
// WHY IT LIVES IN CORE. It used to live only in apps/web, applied at three
// app-layer call sites. But the app layer is not what spawns agents: engine.ts's
// agent() and ultra/runner.ts both call query() from THIS package and could not
// see that resolver. Every interactive session worked and every CHILD agent died
// on the missing binary — invisible in the one surface anybody watches. The
// resolution belongs beside the code that spawns.
//
// WHAT IS LEFT HERE, now that codex-executable.ts exists: only what is TRUE OF
// CLAUDE — the candidate binary name, the derived wrapper/CLI pairing, and the
// verdict that pairing implies. Finding the binary, detecting its version,
// caching that, announcing it and deciding whether a turn may proceed are the
// same problem for both CLIs and live in cli-resolution.ts. Two copies of that
// is how Codex ended up shipping a resolver that never looked in ~/.local/bin.

import { createRequire } from "node:module";
import {
  cliUsable,
  resolveCli,
  resolveCliAsync,
  type CliResolution,
  type CliSpec,
  type CliStatus,
} from "./cli-resolution";

/** Kept as its own name because three app-layer modules and the chat route
 *  already import it; it is the shared shape, narrowed to nothing. */
export type ClaudeCliStatus = CliStatus;
export type ClaudeCliResolution = CliResolution;

/** THE MAPPING IS DERIVED, NOT HARDCODED. Wrapper and CLI are versioned
 *  differently — wrapper 0.3.204 ships CLI 2.1.204 — but the PATCH component is
 *  the same number, and that is the release-train identity. Reading it from the
 *  installed wrapper means this updates itself on a dependency bump instead of
 *  becoming a constant somebody forgets. */
export function expectedCliVersion(): string | undefined {
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_("@anthropic-ai/claude-agent-sdk/package.json") as { version?: string };
    const patch = pkg.version?.split(".")[2];
    return patch ? `2.1.${patch}` : undefined;
  } catch {
    return undefined;
  }
}

const CLAUDE_CLI: CliSpec = {
  id: "claude",
  label: "Claude Code",
  bin: "claude",
  overrideEnv: "CLAUDE_CODE_EXECUTABLE",
  installHint:
    "Install Claude Code (https://claude.com/claude-code) and sign in, then restart telar. " +
    "If it is installed somewhere unusual, set CLAUDE_CODE_EXECUTABLE to its full path.",
  expectedVersion: expectedCliVersion,
  verdict: (version, expected, executable) => {
    const [major, minor] = version.split(".");
    const [xMajor, xMinor] = expected.split(".");
    if (major !== xMajor || minor !== xMinor) {
      return {
        status: "incompatible",
        message:
          `Claude Code ${version} at ${executable} is not compatible with this build of telar, ` +
          `which speaks the ${xMajor}.${xMinor}.x control protocol (expects ${expected}). ` +
          "Update telar, or install a matching Claude Code.",
      };
    }
    if (version !== expected) {
      return {
        status: "drifted",
        message:
          `Claude Code ${version} differs from the ${expected} this build was tested against. ` +
          "This usually works — but if tool calls are cancelled without you refusing them, suspect this first.",
      };
    }
    return { status: "ok" };
  },
};

/** The whole answer: where the CLI is, what version it is, and whether that is a
 *  version this wrapper expects to be able to talk to. */
export function resolveClaudeCli(): ClaudeCliResolution {
  return resolveCli(CLAUDE_CLI);
}

/** The same verdict without blocking the event loop — for HTTP handlers, which
 *  must not stall every other request (including live chat streams) on a
 *  subprocess. Shares the cache and the classification with resolveClaudeCli. */
export function resolveClaudeCliAsync(): Promise<ClaudeCliResolution> {
  return resolveCliAsync(CLAUDE_CLI);
}

/** Whether a turn may proceed. `drifted` and `unknown` pass DELIBERATELY — see
 *  cliUsable, which is the one rule both CLIs are judged by. */
export function claudeCliUsable(resolution: ClaudeCliResolution): boolean {
  return cliUsable(resolution);
}

/** Spread into the SDK's `options`. Empty when nothing was found — the caller is
 *  expected to have already refused the turn via `claudeCliUsable`, and an empty
 *  object at least leaves the SDK's own lookup untouched rather than pointing it
 *  at a path that does not exist. */
export function claudeExecutableOptions(): { pathToClaudeCodeExecutable?: string } {
  const { path: executable } = resolveClaudeCli();
  return executable ? { pathToClaudeCodeExecutable: executable } : {};
}
