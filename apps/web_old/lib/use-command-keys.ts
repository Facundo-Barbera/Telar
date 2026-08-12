"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  commandKeyDestination,
  resolveWebCommandKeyAction,
  type CommandKeyId,
} from "@/lib/command-keys";
import { recentSessionsForCommandKeys, sessionHref, type SidebarSession } from "@/lib/session-list";

/**
 * Wires issue #16's command keys into the running app. Mounted once, from
 * AppSidebar — the one component already alive on every route that already
 * holds the session list cmd+1..9 needs (its `chats` state) and the current
 * route's session id (`activeSessionId`, from the same `usePathname()` the
 * sidebar itself derives its own active row from) — so this needs no fetch
 * of its own and can never disagree with what the sidebar shows, including
 * which session is pinned into view past the Recent band's usual cutoff.
 *
 * Two independent sources feed the same dispatch path, because only ONE of
 * them can see the DOM:
 *   - a `keydown` listener on window applies the focus rule directly
 *     (resolveWebCommandKeyAction reads event.target) — this is what fires
 *     the shortcut in a plain browser tab, and in the Electron renderer for
 *     any key the OS didn't already reserve.
 *   - the Electron menu's native accelerators fire in the MAIN process,
 *     which has no DOM at all, and arrive here as a bare action id over the
 *     telarDesktop.commandKeys bridge (preload.js's existing telar:*
 *     contextBridge pattern). No focus check on this path, deliberately
 *     (issue #46): every menu accelerator is a CommandOrControl chord, and
 *     chords are exempt from the focus rule — which is enforced in exactly
 *     one place, resolveWebCommandKeyAction, so this handler must not grow
 *     a second copy that can drift.
 *
 * KNOWN GAP (stated, not silently assumed): in a plain desktop browser tab
 * (not the Electron shell), Cmd+N/Cmd+T/Cmd+1..9 are commonly reserved by
 * the browser itself for real window/tab management, and Chrome/Safari on
 * macOS do not deliver that keydown to the page at all — no in-page JS can
 * intercept them. This listener still attaches unconditionally because
 * a) it is harmless where the browser wins anyway, b) Cmd+, is NOT
 * browser-reserved and always works, and c) behaviour varies by browser —
 * this was not launched to verify (hard rule), so it is reported rather than
 * asserted.
 */
export function useCommandKeys(chats: readonly SidebarSession[], activeSessionId?: string) {
  const router = useRouter();

  useEffect(() => {
    const recentHrefs = recentSessionsForCommandKeys(chats, activeSessionId).map((session) => sessionHref(session));

    const run = (id: CommandKeyId) => {
      const destination = commandKeyDestination(id, recentHrefs);
      if (destination.kind === "noop") return;
      if (destination.kind === "open-tab" && !window.telarDesktop?.isDesktop) {
        window.open(destination.href, "_blank", "noopener");
        return;
      }
      router.push(destination.href);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const id = resolveWebCommandKeyAction(event);
      if (!id) return;
      event.preventDefault();
      run(id);
    };
    window.addEventListener("keydown", onKeyDown);

    const offInvoke = window.telarDesktop?.commandKeys?.onInvoke((id) => {
      run(id as CommandKeyId);
    });

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      offInvoke?.();
    };
  }, [chats, activeSessionId, router]);
}
