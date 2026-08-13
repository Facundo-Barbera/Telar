import { execFile } from "node:child_process";

/**
 * The native folder picker, for the cockpit running in a PLAIN BROWSER.
 *
 * Ported from the frozen app's `app/api/browse/route.ts`, which is the right idea:
 * this server runs on the user's own machine, so it can ask the platform for a
 * real folder chooser and return the absolute path the browser sandbox will never
 * give up. In the desktop shell nothing comes here — Electron's own
 * `dialog.showOpenDialog` is better in every way, and `lib/choose-directory.ts`
 * prefers it (parented to the window, and cross-platform without this file
 * learning three more platforms).
 *
 * macOS ONLY, AND IT SAYS SO. `zenity`, `kdialog` and a PowerShell folder dialog
 * would each cover another platform and none of them can be tested here; a picker
 * that half-works on Linux is worse than one that says "type the path". The answer
 * is `{ unavailable }` rather than an HTTP error, because a Linux machine with no
 * `osascript` is behaving correctly and should not be reported as a failure.
 *
 * NO AUTH, LIKE EVERY OTHER ROUTE IN THIS ADAPTER — worth stating because this one
 * makes a window APPEAR. On a dev server bound to 0.0.0.0 (which the launcher
 * already warns is a shell on the machine) a stranger could pop a Finder dialog;
 * they still get nothing unless the person at the keyboard chooses a folder for
 * them.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Long enough that somebody can go and find the folder; short enough that a
 *  dialog nobody is looking at does not pin a request forever. */
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
