
export type DirectoryChoice = { path: string } | { cancelled: true } | { unavailable: string };

type DesktopDialogBridge = {
  dialog?: { chooseDirectory?: (options?: DirectoryPickerOptions) => Promise<unknown> };
};

type DirectoryPickerOptions = { title?: string; buttonLabel?: string; defaultPath?: string };

function desktop(): DesktopDialogBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: DesktopDialogBridge }).telarDesktop;
}

export function hasNativeFolderPicker(): boolean {
  return Boolean(desktop()?.dialog?.chooseDirectory);
}

export function readDirectoryChoice(answer: unknown): DirectoryChoice {
  const row = answer as { path?: unknown; cancelled?: unknown; unavailable?: unknown; error?: unknown } | null;
  if (typeof row?.path === "string" && row.path.trim()) return { path: row.path.trim().replace(/\/+$/, "") };
  if (row?.cancelled === true) return { cancelled: true };
  if (typeof row?.unavailable === "string") return { unavailable: row.unavailable };
  if (typeof row?.error === "string") return { unavailable: row.error };
  return { unavailable: "The folder picker did not answer." };
}

export async function chooseDirectory(
  options: DirectoryPickerOptions = {},
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
