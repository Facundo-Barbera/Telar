import { execFile } from "node:child_process";

/** The native folder picker for a cockpit in a plain browser; macOS only, and `{ unavailable }` elsewhere. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PICKER_TIMEOUT_MS = 300_000;

export async function POST() {
  if (process.platform !== "darwin") {
    return Response.json({ unavailable: "Telar can only open a folder picker from the desktop app on this platform." });
  }
  const chosen = await new Promise<string | null>((resolve) => {
    execFile(
      "osascript",
      [
        // Without this the dialog opens behind the browser and looks like a hang.
        "-e",
        'tell application "System Events" to activate',
        "-e",
        'POSIX path of (choose folder with prompt "Choose a project folder for Telar")',
      ],
      { timeout: PICKER_TIMEOUT_MS },
      // `osascript` exits non-zero when the user cancels, which is not an error.
      (error, stdout) => resolve(error ? null : stdout.trim().replace(/\/+$/, "")),
    );
  });
  return Response.json(chosen ? { path: chosen } : { cancelled: true });
}
