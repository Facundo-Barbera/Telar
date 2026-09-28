"use client";

import { useState, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { workspacePath } from "@telar/engine-client";
import { asEngineError } from "@/platform/engine";
import { projectSettingsHref } from "@/features/projects";
import { desktopApp } from "@/platform/desktop/desktop-app";
import { LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { canvasHref } from "../../session-list";
import { sessionLink } from "../../session-link";
import type { SessionMasthead } from "../components/masthead";
import type { useSessionSync } from "./use-session-sync";
import type { useSettling } from "./use-settling";

type Menu = NonNullable<ComponentProps<typeof SessionMasthead>["menu"]>;

const copyText = (text: string) => void navigator.clipboard.writeText(text).catch(() => window.alert("The browser refused to copy that."));

/** The masthead title's menu, the same verbs as the rail's row menu, for the session on screen. */
export function useTitleMenu({ hostId, projectId, projectName, sessionId, sync, settling }: {
  hostId: string;
  projectId: string | undefined;
  projectName: string | undefined;
  sessionId: string | undefined;
  sync: ReturnType<typeof useSessionSync>;
  settling: ReturnType<typeof useSettling>;
}): Menu | undefined {
  const { session, setError } = sync;
  const router = useRouter();
  const [menuTerminals, setMenuTerminals] = useState<{ sessionId: string; open: number }>();
  if (!session || !sessionId) return undefined;
  const shell = desktopApp();
  const { menuApi } = settling;
  const countTerminals = () => {
    const asked = sessionId;
    // Nothing said until the host answers: a stale count is worse than none.
    setMenuTerminals(undefined);
    void menuApi
      .sessionTerminals(asked)
      .then((answer) => setMenuTerminals({ sessionId: asked, open: answer.open }))
      .catch(() => setMenuTerminals(undefined));
  };
  const openTerminals = menuTerminals && menuTerminals.sessionId === sessionId ? menuTerminals.open : 0;
  const path = workspacePath(session.workspace);
  return {
    onOpen: countTerminals,
    session: {
      id: session.id,
      title: session.title,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(projectName ? { projectName } : {}),
      ...(hostId === LOCAL_HOST_ID ? {} : { hostId }),
      ...(path ? { workspacePath: path } : {}),
      // Only a worktree session has a branch of its own.
      ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
      ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
      settled: settling.settled,
      ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
      ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
      ...(openTerminals > 0 ? { terminals: openTerminals } : {}),
      archived: session.state === "archived",
      updatedAt: session.updatedAt,
    },
    activity: {
      working: session.activity === "working" || session.activity === "queued",
      waitingOnYou: session.activity === "blocked",
    },
    now: settling.now,
    // This menu is only ever about the session on screen, so `Open` is the one verb it cannot perform.
    capabilities: { remote: hostId !== LOCAL_HOST_ID, current: true },
    actions: {
      open: (href) => router.push(href),
      copyLink: (href) => copyText(sessionLink(href)),
      ...(shell?.openWindow ? { openWindow: (href: string) => void shell.openWindow!(href) } : {}),
      newSession: ({ projectId: target, hostId: host, baseRef }) => router.push(canvasHref(target, host, baseRef ? { baseRef } : undefined)),
      pin: (pinned) => void settling.patchFromMenu({ settledOverride: pinned ? "active" : null }, "Could not change the session's pin."),
      settle: (next) => void (next ? settling.patchFromMenu({ settledOverride: "settled" }, "Could not settle the session.") : settling.unsettle()),
      closeTerminals: () =>
        void menuApi
          .closeSessionTerminals(sessionId)
          .then(() => setMenuTerminals({ sessionId, open: 0 }))
          .catch((cause: unknown) => setError(asEngineError(cause, "Could not close the session's terminals."))),
      snooze: (until) => void settling.snooze(until),
      regenerateTitle: () =>
        void menuApi.regenerateSessionTitle(sessionId).catch((cause: unknown) => setError(asEngineError(cause, "Could not regenerate the title."))),
      copy: copyText,
      projectSettings: ({ projectId: target }) => router.push(projectSettingsHref(target)),
      remove: () => {
        const name = session.title || "Untitled session";
        // The same two presses as the rail's: the second states what cannot be undone.
        if (!window.confirm(`Delete "${name}"?`)) return;
        if (!window.confirm(`This removes the transcript and the worktree for "${name}". It cannot be undone.`)) return;
        void menuApi
          .deleteSession(sessionId)
          .then(() => {
            const home = session.projectId ?? projectId;
            router.push(home === undefined ? "/" : canvasHref(home, hostId));
          })
          .catch((cause: unknown) => setError(asEngineError(cause, "Could not delete the session.")));
      },
    },
  };
}
