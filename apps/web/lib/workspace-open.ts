"use client";

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
 *
 * AND ONE FILE, for the file tree's right-click menu. Same bridge, same
 * refusals, one extra thing the shell will accept (`apps/desktop/main.js`).
 * The difference from the folder verbs is where the ABSOLUTE path comes from:
 * a folder has one, and a file in the tree is a path RELATIVE to a checkout,
 * so the root has to be joined on before anything crosses the bridge —
 * `workspaceFilePath` below, in one place, because the shell refuses a
 * relative path and "which side joins it" is exactly the kind of thing two
 * call sites answer differently.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import {
  preferredOpenerSnapshot,
  serverPreferredOpenerSnapshot,
  subscribePreferredOpener,
  workspaceOpenerEntries,
  workspaceOpenerPrimary,
  workspaceOpenerPrimaryLabel,
} from "@/lib/workspace-opener-preference";

/** One installed app that can open a folder, as the shell discovered it.
 *  `icon` names a brand mark the renderer carries (components/session/opener-icon.tsx);
 *  absent on an app we have no mark for, which draws the neutral glyph. */
export type WorkspaceOpener = { id: string; label: string; path: string; icon?: string };

export type WorkspaceOpenAnswer = { ok: boolean; error?: string };

export type WorkspaceOpenBridge = {
  /** Absent on a shell too old to enumerate; the caller falls back to the
   *  system default rather than showing an empty menu. */
  openers?: () => Promise<{ openers: WorkspaceOpener[] }>;
  open: (path: string, openerId?: string) => Promise<WorkspaceOpenAnswer>;
  reveal: (path: string) => Promise<WorkspaceOpenAnswer>;
  /** The same two verbs for ONE FILE. Optional for the same reason `openers`
   *  is: a shell packaged before this exists, and a menu that would call it
   *  hides the item rather than promising something nothing answers. */
  revealFile?: (path: string) => Promise<WorkspaceOpenAnswer>;
  openFile?: (path: string, openerId?: string) => Promise<WorkspaceOpenAnswer>;
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

/**
 * A checkout-relative path, made absolute against the checkout it is relative
 * to — or nothing, when either half is missing.
 *
 * NOTHING RATHER THAN A GUESS. The shell refuses a relative path (it would
 * resolve against the shell's own cwd, which is somebody's home directory),
 * and a tree whose listing has not landed yet has no root to join. Both cases
 * mean "we cannot name this file on disk", which is what makes the menu items
 * that need one disappear instead of failing when pressed.
 */
export function workspaceFilePath(root: string | undefined, relative: string): string | undefined {
  if (!root || !relative) return undefined;
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

/**
 * WHAT A MENU CAN DO WITH ONE FILE ON THIS MACHINE.
 *
 * The two items this answers for — "Reveal in Finder" and "Open in <app>" —
 * are HIDDEN when it says no, never disabled. A greyed row in a browser tab is
 * a promise the web can never keep, restated on every right-click; the desktop
 * app is where those verbs live and the browser simply does not carry them.
 *
 * `open` and `reveal` take the CHECKOUT-RELATIVE path the surface already
 * holds and join the root themselves, so no caller has to remember which kind
 * of path the bridge wants.
 *
 * THE LABEL IS THE FOLDER BUTTON'S OWN. `workspaceOpenerPrimary` is what
 * decides which app the header's split button offers, so the menu offers the
 * same one and wears the same mark — one preference, read twice, never a
 * second idea of "your editor".
 *
 * AND USING IT TEACHES THAT PREFERENCE NOTHING, deliberately. The split button
 * writes on every open because every open there was a CHOICE — you picked a
 * row. This item offers no choice at all; it names the app you already prefer.
 * Writing from a gesture that said nothing would be the button drawing a
 * conclusion nobody stated (see `remembersOpener`, which draws the same line
 * one step over for a reveal).
 */
/** Which of the shell's two guards the target has to pass. A directory row in
 *  the tree is still a directory to the shell, and sending it as a file would
 *  be refused by the stat that exists to catch exactly that mix-up. */
export type WorkspaceEntryKind = "file" | "directory";

export type WorkspaceFileMenu = {
  /** Absent when this machine cannot act on the file — see the note above. */
  reveal?: (relativePath: string, kind: WorkspaceEntryKind) => void;
  open?: (relativePath: string, kind: WorkspaceEntryKind) => void;
  /** "Open in Zed". The item's own words, so it never says "Open in undefined". */
  openLabel: string;
  /** The brand mark id for `OpenerIcon`; absent draws the neutral glyph. */
  openIcon?: string;
};

export function useWorkspaceFileMenu(input: { workspacePath?: string | undefined; hostId?: string | undefined }): WorkspaceFileMenu {
  const { workspacePath, hostId } = input;
  const [openers, setOpeners] = useState<WorkspaceOpener[]>();
  const bridge = workspaceOpener();
  /** A shell that can act on a file at all. Both verbs or neither: a menu with
   *  one of the pair is a menu that half-works. */
  const files = bridge?.revealFile && bridge.openFile ? bridge : undefined;
  /** The same refusal the folder button uses, minus the "no folder" arm: a
   *  remote session's files are on the remote machine, and revealing a
   *  same-named path here would show somebody the WRONG file. */
  const here = !hostId || hostId === LOCAL_HOST_ID;
  const able = Boolean(files) && here && Boolean(workspacePath);

  const preferred = useSyncExternalStore(
    subscribePreferredOpener,
    useCallback(() => preferredOpenerSnapshot(hostId), [hostId]),
    serverPreferredOpenerSnapshot,
  );

  /** ASKED ONCE, and only where the answer is used: the item has to NAME the
   *  app, and the preference stores only an id. Same read the split button
   *  makes, and the same re-validation — an editor uninstalled since the last
   *  open drops out and the item falls back to the system default. */
  useEffect(() => {
    if (!able || !bridge?.openers) return undefined;
    let live = true;
    void bridge
      .openers()
      .then((answer) => live && setOpeners(answer.openers))
      .catch(() => live && setOpeners([]));
    return () => {
      live = false;
    };
  }, [able, bridge]);

  const entries = workspaceOpenerEntries({ openers: openers ?? [], preferred });
  const primary = workspaceOpenerPrimary(entries);
  /**
   * WHAT PRESSING IT COSTS WHEN IT FAILS, named rather than faked: nothing.
   * The shell answers `{ ok, error }` and this drops it, because neither the
   * tree nor the file header has a place to say a sentence and inventing one
   * (a toast, a banner over the tree) would be new surface a right-click menu
   * has no business adding. Both failures the guards leave possible are ones
   * the next refresh explains anyway — the file was moved, or the app was
   * uninstalled between the menu opening and the row being pressed.
   */
  return {
    ...(able
      ? {
          reveal: (relativePath: string, kind: WorkspaceEntryKind) => {
            const target = workspaceFilePath(workspacePath, relativePath);
            if (target) void (kind === "file" ? files!.revealFile!(target) : files!.reveal(target));
          },
          open: (relativePath: string, kind: WorkspaceEntryKind) => {
            const target = workspaceFilePath(workspacePath, relativePath);
            if (target) void (kind === "file" ? files!.openFile!(target, primary?.openerId) : files!.open(target, primary?.openerId));
          },
        }
      : {}),
    openLabel: primary ? workspaceOpenerPrimaryLabel(entries) : "Open in the default app",
    ...(primary?.icon ? { openIcon: primary.icon } : {}),
  };
}
