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

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export type ClaudeCliStatus =
  /** Resolved, and its version is the one this wrapper was built against. */
  | "ok"
  /** Resolved, same protocol family, different patch. Works in practice; worth
   *  surfacing because it is the first thing to suspect when the control
   *  protocol misbehaves. */
  | "drifted"
  /** Resolved, but a different major/minor. Not a compatibility promise. */
  | "incompatible"
  /** Nothing found on any candidate path. */
  | "missing"
  /** Found, but it would not report a version. */
  | "unknown";

export type ClaudeCliResolution = {
  status: ClaudeCliStatus;
  /** Absent only when status is "missing". */
  path?: string;
  /** The CLI's own reported version, e.g. "2.1.222". */
  version?: string;
  /** What this wrapper was built against, e.g. "2.1.204". */
  expected?: string;
  /** Set for every status except "ok" — user-facing and actionable, saying what
   *  to do rather than only what is wrong. */
  message?: string;
};

const candidatePaths = (): string[] =>
  [
    process.env.CLAUDE_CODE_EXECUTABLE,
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((c): c is string => Boolean(c));

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

/** Keyed on (path, mtime) rather than cached for the process lifetime, so a
 *  Claude Code that upgrades ITSELF while telar runs is noticed on the next turn
 *  instead of being reported at whatever it was at boot. Spawning a subprocess
 *  per turn is the obvious alternative and is a cost every session pays forever. */
const versionCache = new Map<string, string | null>();

function detectVersion(executable: string): string | null {
  let key = executable;
  try {
    key = `${executable}:${statSync(executable).mtimeMs}`;
  } catch {
    // Unreadable stat — fall back to the bare path as the key.
  }
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;

  let version: string | null = null;
  try {
    // `claude --version` prints e.g. "2.1.222 (Claude Code)".
    const out = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    version = null;
  }
  versionCache.set(key, version);
  return version;
}

const INSTALL_HINT =
  "Install Claude Code (https://claude.com/claude-code) and sign in, then restart telar. " +
  "If it is installed somewhere unusual, set CLAUDE_CODE_EXECUTABLE to its full path.";

/** Announced ONCE per process, not per turn. Which CLI a session is actually
 *  talking to was unknowable before this — a 0.3.204 wrapper drove a 2.1.222
 *  binary for weeks and nothing anywhere said so, which is most of why #28 took
 *  days. One line at startup makes every later report attributable. */
let announced = false;

function announce(r: ClaudeCliResolution): void {
  if (announced) return;
  announced = true;
  const where = r.path ?? "not found";
  const what = r.version ? `${r.version}` : "version unknown";
  const against = r.expected ? ` (wrapper expects ${r.expected})` : "";
  console.log(`[telar] Claude CLI: ${r.status} · ${what}${against} · ${where}`);
  if (r.message) console.log(`[telar] Claude CLI: ${r.message}`);
}

/** The whole answer: where the CLI is, what version it is, and whether that is a
 *  version this wrapper expects to be able to talk to. */
export function resolveClaudeCli(): ClaudeCliResolution {
  const resolution = resolveUncached();
  announce(resolution);
  return resolution;
}

function resolveUncached(): ClaudeCliResolution {
  const executable = candidatePaths().find((candidate) => existsSync(candidate));
  const expected = expectedCliVersion();

  if (!executable) {
    return {
      status: "missing",
      expected,
      message: `No Claude Code installation found. telar does not bundle one. ${INSTALL_HINT}`,
    };
  }

  const version = detectVersion(executable);
  if (!version) {
    return {
      status: "unknown",
      path: executable,
      expected,
      message:
        `Found Claude Code at ${executable} but it would not report a version. ` +
        "It may be a broken install, a wrapper script, or not executable by this user.",
    };
  }
  if (!expected) {
    // The wrapper's own version was unreadable, so there is nothing to compare
    // against. Report what was found rather than inventing a verdict.
    return { status: "unknown", path: executable, version };
  }

  const [major, minor] = version.split(".");
  const [xMajor, xMinor] = expected.split(".");
  if (major !== xMajor || minor !== xMinor) {
    return {
      status: "incompatible",
      path: executable,
      version,
      expected,
      message:
        `Claude Code ${version} at ${executable} is not compatible with this build of telar, ` +
        `which speaks the ${xMajor}.${xMinor}.x control protocol (expects ${expected}). ` +
        "Update telar, or install a matching Claude Code.",
    };
  }
  if (version !== expected) {
    return {
      status: "drifted",
      path: executable,
      version,
      expected,
      message:
        `Claude Code ${version} differs from the ${expected} this build was tested against. ` +
        "This usually works — but if tool calls are cancelled without you refusing them, suspect this first.",
    };
  }
  return { status: "ok", path: executable, version, expected };
}

/** Whether a turn may proceed. `drifted` and `unknown` pass DELIBERATELY: a hard
 *  gate on every unrecognised version would lock a user out of their own app the
 *  day Claude Code ships a release we have not blessed, and the common case — a
 *  patch ahead — demonstrably works. Only "no CLI at all" and "wrong protocol
 *  family" are refusals. */
export function claudeCliUsable(resolution: ClaudeCliResolution): boolean {
  return resolution.status !== "missing" && resolution.status !== "incompatible";
}

/** Spread into the SDK's `options`. Empty when nothing was found — the caller is
 *  expected to have already refused the turn via `claudeCliUsable`, and an empty
 *  object at least leaves the SDK's own lookup untouched rather than pointing it
 *  at a path that does not exist. */
export function claudeExecutableOptions(): { pathToClaudeCodeExecutable?: string } {
  const { path: executable } = resolveClaudeCli();
  return executable ? { pathToClaudeCodeExecutable: executable } : {};
}
