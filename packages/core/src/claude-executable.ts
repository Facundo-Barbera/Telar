// WHERE THE CLAUDE CLI ACTUALLY IS — one definition, for everything that spawns
// a child.
//
// The Agent SDK normally launches its optional, platform-specific bundled
// binary. Bun can install the JS package WITHOUT that optional payload while
// Claude Code itself is installed and signed in on the machine, and the SDK
// then fails the turn with "Native CLI binary for <platform> not found".
//
// WHY THIS LIVES IN CORE AND NOT IN apps/web. It used to live only in
// `apps/web/lib/claude-executable.ts`, applied at three app-layer call sites
// (the chat route, titles, the model registry). But the app layer is not what
// spawns agents: `engine.ts`'s agent() and `ultra/runner.ts` both call the SDK's
// query() from THIS package, and neither could see that resolver. The result was
// a machine where every interactive session worked perfectly and every CHILD
// agent — every Ultra agent, every loom thread — died instantly on the missing
// binary. The failure was invisible in the one surface anybody watches.
//
// So the resolution belongs beside the code that spawns, and the app layer
// re-exports THIS rather than holding a second copy. A second copy is how the
// two drift, and drift here is a whole class of agent that silently cannot run.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Spread into the SDK's `options`. EMPTY when no ordinary installation is
 *  found, deliberately: the SDK's own bundled-binary lookup is the correct
 *  behaviour when it has one, and an empty object leaves it untouched. */
export function claudeExecutableOptions(): { pathToClaudeCodeExecutable?: string } {
  const candidates = [
    process.env.CLAUDE_CODE_EXECUTABLE,
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];

  const executable = candidates.find(
    (candidate): candidate is string => Boolean(candidate && existsSync(candidate)),
  );
  return executable ? { pathToClaudeCodeExecutable: executable } : {};
}
