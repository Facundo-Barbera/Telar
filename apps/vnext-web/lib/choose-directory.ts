/**
 * ASK THE OPERATING SYSTEM WHERE THE REPOSITORY IS.
 *
 * Registering a project needs an absolute path, and an absolute path is the one
 * thing a web page can never obtain: a file input hands back a `File` with a
 * sandboxed name, and `webkitdirectory` gives relative paths under a directory it
 * will not name. So the picker has to be opened by something outside the page —
 * and this cockpit runs in two places, which is why there are two routes to it:
 *
 *   - IN THE DESKTOP SHELL, Electron's own `dialog.showOpenDialog`, parented to
 *     the window so it arrives as a sheet attached to the app. Cross-platform for
 *     free, because Electron does that work.
 *   - IN A PLAIN BROWSER, the Next adapter's `POST /api/browse`, which runs on
 *     this machine and can therefore ask the platform itself. macOS only, because
 *     that is the platform whose folder chooser this repository can test.
 *
 * CANCELLING IS AN ANSWER. Three outcomes, not two: a path, a deliberate cancel,
 * and "there is no picker here" — which needs its own because the caller has to
 * say so rather than showing an error for a machine that is behaving correctly.
 */

export type DirectoryChoice = { path: string } | { cancelled: true } | { unavailable: string };

/** The slice of the desktop bridge this module needs. Declared here rather than
 *  globally: it is the first thing in this cockpit to reach for the shell, and a
 *  global `Window` augmentation would imply the bridge is always there. */
type DesktopDialogBridge = {
  dialog?: { chooseDirectory?: (options?: { title?: string; buttonLabel?: string }) => Promise<unknown> };
};

function desktop(): DesktopDialogBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: DesktopDialogBridge }).telarDesktop;
}

/** Anything shaped like an answer, from either route. Both are outside this
 *  module's control — one is IPC, the other is JSON — so neither is trusted. */
export function readDirectoryChoice(answer: unknown): DirectoryChoice {
  const row = answer as { path?: unknown; cancelled?: unknown; unavailable?: unknown; error?: unknown } | null;
  if (typeof row?.path === "string" && row.path.trim()) return { path: row.path.trim().replace(/\/+$/, "") };
  if (row?.cancelled === true) return { cancelled: true };
  if (typeof row?.unavailable === "string") return { unavailable: row.unavailable };
  if (typeof row?.error === "string") return { unavailable: row.error };
  return { unavailable: "The folder picker did not answer." };
}

/**
 * `bridge` and `fetcher` are injected so the two routes can be tested without a
 * window and without a server — the same arrangement the save coordinator makes
 * for its timers. Neither has a default worth writing at the call site.
 */
export async function chooseDirectory(
  options: { title?: string } = {},
  seams: { bridge?: DesktopDialogBridge | undefined; fetcher?: typeof fetch } = {},
): Promise<DirectoryChoice> {
  const bridge = "bridge" in seams ? seams.bridge : desktop();
  if (bridge?.dialog?.chooseDirectory) {
    try {
      return readDirectoryChoice(await bridge.dialog.chooseDirectory(options));
    } catch (cause) {
      return { unavailable: cause instanceof Error ? cause.message : "The desktop shell could not open a folder picker." };
    }
  }
  const fetcher = seams.fetcher ?? fetch;
  try {
    const response = await fetcher("/api/browse", { method: "POST" });
    return readDirectoryChoice(await response.json());
  } catch {
    return { unavailable: "The folder picker is not available here." };
  }
}
