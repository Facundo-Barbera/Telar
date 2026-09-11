/**
 * Opening a session's workspace in the machine's own tools.
 *
 * A local structural type and an accessor, like `desktop-updates.ts`: a global
 * `Window` augmentation would imply the bridge is always there, and in a
 * browser tab it never is.
 *
 * A remote session's workspace is on the remote machine, so it is refused by
 * name rather than attempted — two machines with the same checkout layout
 * would otherwise open the WRONG folder.
 */
import { LOCAL_HOST_ID } from "@/lib/hosts/book";

/** One installed app that can open a folder, as the shell discovered it.
 *  `icon` names a brand mark the renderer carries (components/session/opener-icon.tsx);
 *  absent on an app we have no mark for, which draws the neutral glyph. */
export type WorkspaceOpener = { id: string; label: string; path: string; icon?: string };

export type WorkspaceOpenBridge = {
  /** Absent on a shell too old to enumerate; the caller falls back to the
   *  system default rather than showing an empty menu. */
  openers?: () => Promise<{ openers: WorkspaceOpener[] }>;
  open: (path: string, openerId?: string) => Promise<{ ok: boolean; error?: string }>;
  reveal: (path: string) => Promise<{ ok: boolean; error?: string }>;
};

export function workspaceOpener(): WorkspaceOpenBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { workspace?: WorkspaceOpenBridge } }).telarDesktop?.workspace;
}

/** Why this session's workspace cannot be opened from here, or undefined when
 *  it can. Every branch is a sentence a reader can act on. */
export function workspaceOpenBlocker(input: {
  path: string | undefined;
  hostId: string | undefined;
  hostLabel?: string | undefined;
  hasBridge: boolean;
}): string | undefined {
  if (!input.hasBridge) return "Opening a folder needs the Telar desktop app — a browser tab cannot reach the file system.";
  if (input.hostId && input.hostId !== LOCAL_HOST_ID) {
    return `This session's files are on ${input.hostLabel ?? "another machine"}, so they cannot be opened from here.`;
  }
  if (!input.path) return "This session has no workspace folder yet.";
  return undefined;
}
