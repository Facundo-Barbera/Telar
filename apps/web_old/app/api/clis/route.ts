import { resolveClaudeCliAsync } from "@telar/core/claude-executable";
import { resolveCodexCliAsync } from "@telar/core/codex-executable";
import type { CliResolution } from "@telar/core/cli-resolution";

export const dynamic = "force-dynamic";

// WHICH EXTERNAL CLIs THIS MACHINE HAS, as the app itself sees them.
//
// The resolvers already announce one line per CLI at startup, and in the
// packaged app that line goes nowhere: the Next server is a child process whose
// stdout is not attached to anything a user can read, and update.log belongs to
// electron-updater. So the one fact #37 and #39 exist to make knowable was
// visible only when launching from a terminal. This is the same resolution,
// read back over HTTP, for the settings pane to render.
//
// READ-ONLY, ON PURPOSE. There is no POST here and there must not be one that
// installs or updates anything: updating a CLI is a privileged mutation of the
// user's machine, and the accept moat in this repo is structural — no route an
// agent can reach may perform one. Reporting a version is not mutating it.
//
// It does spawn `<cli> --version` on a cache miss (keyed on path+mtime, in
// packages/core), which is why this is force-dynamic rather than cached: an
// in-place CLI upgrade must show up here on the next load, not at next boot.
// ASYNC, AND BOTH AT ONCE. The version probe must not run synchronously here:
// this handler has a user-clickable "Re-check", and a sync spawn stalls the
// whole Next server — every other request, including live SSE chat streams —
// for as long as a hung binary takes to hit its timeout. Concurrent rather than
// sequential because the two probes are independent and a slow one should not
// add its wait to the other's.
export async function GET() {
  const clis: CliResolution[] = await Promise.all([
    resolveClaudeCliAsync(),
    resolveCodexCliAsync(),
  ]);
  return Response.json({ clis });
}
