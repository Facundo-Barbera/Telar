"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { commandKeyDestination, resolveWebCommandKeyAction, type CommandKeyId } from "@/lib/command-keys";
import { sessionHref, type SidebarSession } from "@/lib/session-list";

/** The slice of the desktop bridge this needs. Declared locally, as
 *  `lib/choose-directory.ts` declares its own: a global `Window` augmentation
 *  would imply the shell is always there, and in a browser tab it is not. */
type DesktopCommandKeyBridge = {
  isDesktop?: boolean;
  commandKeys?: { onInvoke?: (listener: (id: string) => void) => (() => void) | undefined };
};

function desktop(): DesktopCommandKeyBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: DesktopCommandKeyBridge }).telarDesktop;
}

/**
 * Wires the command keys into the running cockpit. Ported from the frozen app's
 * `lib/use-command-keys.ts`.
 *
 * MOUNTED ONCE, FROM THE SIDEBAR — the one component alive on every route that
 * already draws the rows ⌘1..⌘9 count. It is handed those rows, TOP TO BOTTOM
 * AS DRAWN (`railRowsForCommandKeys`), and fetches nothing of its own, so the
 * keys cannot disagree with what the rail shows: the same scope, the same page,
 * the same arranged groups, the same folds.
 *
 * THE LISTENERS ARE REGISTERED ONCE and read the latest rows through a ref. The
 * rail re-derives its rows on every poll, and re-binding a window listener and
 * the menu bridge per tick was churn for no change in behaviour.
 *
 * TWO SOURCES FEED ONE DISPATCH, because only one of them can see the DOM:
 *   - a `keydown` listener on window, which applies the focus rule directly
 *     (`resolveWebCommandKeyAction` reads `event.target`). This is what fires in
 *     a plain browser tab, and in the Electron renderer for anything the OS did
 *     not reserve first.
 *   - the app menu's native accelerators, which fire in the MAIN process — no
 *     DOM there at all — and arrive as a bare action id over the preload bridge.
 *     No focus check on that path, deliberately: every menu accelerator is a
 *     chord, chords are exempt, and the rule is enforced in exactly one place so
 *     a second copy cannot drift from it.
 *
 * KNOWN GAP, stated rather than assumed: in a plain browser tab ⌘N/⌘T/⌘1..9 are
 * commonly reserved by the browser for real window and tab management, and
 * Chrome and Safari on macOS do not deliver those keydowns to the page at all.
 * The listener attaches anyway — it is harmless where the browser wins, ⌘, is
 * never reserved, and the desktop shell (where this app actually runs) routes
 * every one of them through the menu.
 */
export function useCommandKeys(rows: readonly SidebarSession[]) {
  const router = useRouter();
  const recentHrefs = useRef<string[]>([]);
  useEffect(() => {
    recentHrefs.current = rows.map((session) => sessionHref(session));
  });

  useEffect(() => {
    const run = (id: CommandKeyId) => {
      const destination = commandKeyDestination(id, recentHrefs.current);
      if (destination.kind === "noop") return;
      if (destination.kind === "open-tab" && !desktop()?.isDesktop) {
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
    const offInvoke = desktop()?.commandKeys?.onInvoke?.((id) => run(id as CommandKeyId));

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      offInvoke?.();
    };
  }, [router]);
}
