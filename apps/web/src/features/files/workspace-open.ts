"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import {
  preferredOpenerSnapshot,
  serverPreferredOpenerSnapshot,
  subscribePreferredOpener,
  workspaceOpenerEntries,
  workspaceOpenerPrimary,
  workspaceOpenerPrimaryLabel,
} from "./workspace-opener-preference";

type WorkspaceOpener = { id: string; label: string; path: string; icon?: string; iconDataUrl?: string };

export type WorkspaceOpenersAnswer = { openers: WorkspaceOpener[]; revealIconDataUrl?: string };

type WorkspaceOpenAnswer = { ok: boolean; error?: string };

export type WorkspaceOpenBridge = {
  openers?: () => Promise<WorkspaceOpenersAnswer>;
  open: (path: string, openerId?: string) => Promise<WorkspaceOpenAnswer>;
  reveal: (path: string) => Promise<WorkspaceOpenAnswer>;
  revealFile?: (path: string) => Promise<WorkspaceOpenAnswer>;
  openFile?: (path: string, openerId?: string) => Promise<WorkspaceOpenAnswer>;
};

export function workspaceOpener(): WorkspaceOpenBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { workspace?: WorkspaceOpenBridge } }).telarDesktop?.workspace;
}

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

export function workspaceFilePath(root: string | undefined, relative: string): string | undefined {
  if (!root || !relative) return undefined;
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

type WorkspaceEntryKind = "file" | "directory";

export type WorkspaceFileMenu = {
  reveal?: (relativePath: string, kind: WorkspaceEntryKind) => void;
  open?: (relativePath: string, kind: WorkspaceEntryKind) => void;
  openLabel: string;
  openIcon?: string;
  openIconDataUrl?: string;
};

export function useWorkspaceFileMenu(input: { workspacePath?: string | undefined; hostId?: string | undefined }): WorkspaceFileMenu {
  const { workspacePath, hostId } = input;
  const [answer, setAnswer] = useState<WorkspaceOpenersAnswer>();
  const bridge = workspaceOpener();
  const files = bridge?.revealFile && bridge.openFile ? bridge : undefined;
  const here = !hostId || hostId === LOCAL_HOST_ID;
  const able = Boolean(files) && here && Boolean(workspacePath);

  const preferred = useSyncExternalStore(
    subscribePreferredOpener,
    useCallback(() => preferredOpenerSnapshot(hostId), [hostId]),
    serverPreferredOpenerSnapshot,
  );

  useEffect(() => {
    if (!able || !bridge?.openers) return undefined;
    let live = true;
    void bridge
      .openers()
      .then((found) => live && setAnswer(found))
      .catch(() => live && setAnswer({ openers: [] }));
    return () => {
      live = false;
    };
  }, [able, bridge]);

  const entries = workspaceOpenerEntries({ openers: answer?.openers ?? [], preferred, revealIconDataUrl: answer?.revealIconDataUrl });
  const primary = workspaceOpenerPrimary(entries);
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
    ...(primary?.iconDataUrl ? { openIconDataUrl: primary.iconDataUrl } : {}),
  };
}
