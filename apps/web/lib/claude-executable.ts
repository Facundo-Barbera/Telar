import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The Agent SDK normally launches its optional, platform-specific bundled
// binary. Bun can install the JS package without that optional payload, while
// Claude Code itself is still installed and signed in on the machine. Resolve
// that ordinary installation explicitly so a healthy local CLI remains usable.
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
