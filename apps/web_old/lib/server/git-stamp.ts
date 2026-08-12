import { execFile } from "node:child_process";

// The per-turn worktree stamp (message-lifecycle F4's in-scope half: telling
// the truth, not restoring anything). One cheap rev-parse + porcelain status
// at turn end; any failure — not a repo, git missing, timeout — degrades to
// absent, and an absent stamp is a fact ("unknown"), never an error.
const STAMP_TIMEOUT_MS = 1_000;

const run = (cwd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: STAMP_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });

export async function gitStamp(
  cwd: string | undefined,
): Promise<{ head: string; dirty: boolean } | undefined> {
  if (!cwd) return undefined;
  const head = (await run(cwd, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return undefined;
  const status = await run(cwd, ["status", "--porcelain"]);
  if (status === null) return undefined;
  return { head, dirty: status.trim().length > 0 };
}
