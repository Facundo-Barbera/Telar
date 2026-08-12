import { execFile } from "child_process";

export const dynamic = "force-dynamic";

// Native macOS folder picker. The server runs on the user's machine, so it can
// show a real Finder dialog and return an absolute path — something the
// browser sandbox can never provide.
export async function POST() {
  if (process.platform !== "darwin") {
    return Response.json({ error: "native browse is macOS-only" }, { status: 501 });
  }
  const path = await new Promise<string | null>((resolve) => {
    execFile(
      "osascript",
      [
        "-e", 'tell application "System Events" to activate',
        "-e", 'POSIX path of (choose folder with prompt "Select a project root for telar")',
      ],
      { timeout: 300_000 },
      (err, stdout) => resolve(err ? null : stdout.trim().replace(/\/$/, "")),
    );
  });
  // osascript exits non-zero when the user cancels — not an error
  return Response.json(path ? { path } : { cancelled: true });
}
