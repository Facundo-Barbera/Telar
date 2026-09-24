"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { commandDestination, resolveWebCommandKeyAction } from "@/lib/command-keys";
import {
  bindCommands,
  claimedCommandIds,
  isCapturingChord,
  keymapSnapshot,
  runCommand,
  serverKeymapSnapshot,
  subscribeKeymap,
  syncKeymapWithShell,
  type CommandHandlers,
  type CommandId,
  type Keymap,
} from "@/lib/commands";
import { sessionHref, type SidebarSession } from "@/lib/session-list";

/** The slice of the desktop bridge this needs. Declared locally, as
 *  `lib/choose-directory.ts` declares its own: a global `Window` augmentation
 *  would imply the shell is always there, and in a browser tab it is not. */
type DesktopCommandKeyBridge = {
  isDesktop?: boolean;
  commandKeys?: { onInvoke?: (listener: (id: string) => void) => (() => void) | undefined };
  app?: { openWindow?: (path: string) => Promise<unknown> };
};

function desktop(): DesktopCommandKeyBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: DesktopCommandKeyBridge }).telarDesktop;
}

/**
 * The live keymap, read outside React.
 *
 * `useSyncExternalStore` rather than state and an effect: the map is edited from
 * the settings pane and read by a window listener, and a hook that learned about
 * a rebind one render late would leave the old chord live for a frame — long
 * enough to press.
 */
export function useKeymap(): Keymap {
  return useSyncExternalStore(subscribeKeymap, keymapSnapshot, serverKeymapSnapshot);
}

/**
 * SAY WHAT A COMMAND DOES HERE, for as long as this component is mounted.
 *
 * The handlers are read through a ref, so a component may close over live state
 * without re-registering on every render — and the registration's identity is
 * what unbinds on unmount, so a stale closure can never outlive it.
 *
 * `deps` is the caller's own re-registration key and is almost always empty: the
 * ref makes re-binding unnecessary for state changes. It exists for the one case
 * that is not a state change — a component that conditionally owns a command
 * (the panel only owns "fill the window" while it is open).
 */
export function useCommandHandlers(handlers: CommandHandlers, deps: readonly unknown[] = []) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const ids = Object.keys(latest.current) as CommandId[];
    const stable: CommandHandlers = {};
    for (const id of ids) stable[id] = () => latest.current[id]?.();
    return bindCommands(stable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * FOCUS A FIELD BY THE NAME A SCREEN READER KNOWS IT BY, once whatever holds it
 * has arrived.
 *
 * TWO COMMANDS END IN A CURSOR SOMEWHERE ELSE'S FIELD. `search-settings`
 * navigates to the pane and then reaches for the field `settings-search-nav.tsx`
 * owns — the same field that focuses itself on a bare "/" — and `go-to-file`
 * opens the Editor and reaches for the filter above its tree. Neither component
 * needs to learn about a command for that, and the accessible name is a contract
 * they already keep.
 *
 * A FEW FRAMES OF RETRY, because the navigation or the tab opening is
 * asynchronous. It gives up rather than spinning: the reader is on the right
 * surface either way, which is most of what they asked for.
 */
function focusFieldNamed(label: string, attempt = 0) {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (field) {
    field.focus();
    field.select();
    return;
  }
  if (attempt >= 20) return;
  window.requestAnimationFrame(() => focusFieldNamed(label, attempt + 1));
}

/**
 * Wires the command keys into the running cockpit.
 *
 * MOUNTED ONCE, FROM THE SIDEBAR — the one component alive on every route that
 * already draws the rows the jump commands count. It is handed those rows, TOP
 * TO BOTTOM AS DRAWN (`railRowsForCommandKeys`), and fetches nothing of its own,
 * so the keys cannot disagree with what the rail shows: the same scope, the same
 * page, the same arranged groups, the same folds.
 *
 * THE LISTENERS ARE REGISTERED ONCE and read the latest rows and the latest
 * keymap through refs. The rail re-derives its rows on every poll, and
 * re-binding a window listener and the menu bridge per tick was churn for no
 * change in behaviour.
 *
 * TWO SOURCES FEED ONE DISPATCH, because only one of them can see the DOM:
 *   - a `keydown` listener on window, which applies the focus rule directly
 *     (`resolveWebCommandKeyAction` reads `event.target`). This is what fires in
 *     a plain browser tab, and in the Electron renderer for every command the
 *     application menu does not carry — which since #367 is most of them.
 *   - the app menu's native accelerators, which fire in the MAIN process — no
 *     DOM there at all — and arrive as a bare action id over the preload bridge.
 *     No focus check on that path, deliberately: the rule is enforced in exactly
 *     one place so a second copy cannot drift from it.
 *
 * THREE PLACES A COMMAND CAN BE ANSWERED, in this order: the caller's own
 * `overrides`, then whichever component has bound itself (`bindCommands`), then
 * the built-in destination for the pure-navigation commands. A command nobody
 * answers does nothing, which is right — ⌘⌥F on the projects list should not
 * beep.
 *
 * KNOWN GAP, stated rather than assumed: in a plain browser tab ⌘N/⌘T/⌘1..9 are
 * commonly reserved by the browser for real window and tab management, and
 * Chrome and Safari on macOS do not deliver those keydowns to the page at all.
 * The listener attaches anyway — it is harmless where the browser wins, and the
 * desktop shell (where this app actually runs) routes them through the menu.
 *
 * IT HANDS THE DISPATCHER BACK, which is what makes a BUTTON a command (#402).
 * The rail's three verbs and every row of the command palette press the same
 * `run` a chord does, so "Add project" cannot come to mean one thing from the
 * keyboard and another from the pill — there is one answer and three ways to
 * ask for it.
 */
export function useCommandKeys(
  rows: readonly SidebarSession[],
  /**
   * A BINDING THE CALLER SERVES ITSELF, and the reason the destination table is
   * not simply edited: ⌘N opens the rail's project palette, and a palette is a
   * piece of the rail's own state — not an href this module could name.
   *
   * Read through a ref, like `rows`: the sidebar re-renders on every poll and
   * re-binding the window listener and the menu bridge per tick was churn for no
   * change in behaviour.
   */
  overrides?: CommandHandlers,
): (id: CommandId) => void {
  const router = useRouter();
  const keymap = useKeymap();
  const recentHrefs = useRef<(string | undefined)[]>([]);
  const latestOverrides = useRef(overrides);
  const latestKeymap = useRef(keymap);
  useEffect(() => {
    recentHrefs.current = rows.map((session) => sessionHref(session));
    latestOverrides.current = overrides;
    latestKeymap.current = keymap;
  });

  // The shell remembers the chords too, so its menu is right before this
  // renderer has painted. One reconciliation per mount — see `syncKeymapWithShell`.
  useEffect(() => {
    void syncKeymapWithShell();
  }, []);

  const run = useCallback(
    (id: CommandId) => {
      const override = latestOverrides.current?.[id];
      if (override) {
        override();
        return;
      }
      if (runCommand(id)) return;
      /**
       * GO TO FILE IS TWO THINGS THIS APP ALREADY HAS. Nothing owns it by name,
       * and nothing should: it is "open the Editor" — which the cockpit owns and
       * answers as `open-editor` — followed by the cursor landing in that
       * surface's own file filter. Spelling it as the pair rather than binding a
       * third handler means a session with no panel simply does nothing, and the
       * day the cockpit claims this id by name, its own binding wins above.
       */
      if (id === "go-to-file") {
        if (runCommand("open-editor")) focusFieldNamed("Search files");
        return;
      }
      const destination = commandDestination(id, recentHrefs.current);
      if (destination.kind === "noop") return;
      if (destination.kind === "open-window") {
        const shell = desktop();
        if (shell?.isDesktop && shell.app?.openWindow) {
          void shell.app.openWindow(destination.href);
          return;
        }
        window.open(destination.href, "_blank", "noopener");
        return;
      }
      if (destination.kind === "open-tab" && !desktop()?.isDesktop) {
        window.open(destination.href, "_blank", "noopener");
        return;
      }
      router.push(destination.href);
      // The settings pane owns its own search field; this is the same "/" the
      // pane already answers to, asked from wherever you happened to be.
      if (id === "search-settings") focusFieldNamed("Search settings");
    },
    [router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A settings row is recording: the next press is a VALUE, not a command.
      // See `setChordCapture` for why the shell is told the same thing.
      if (isCapturingChord()) return;
      const id = resolveWebCommandKeyAction(latestKeymap.current, event);
      if (!id) return;
      /**
       * A SURFACE ON SCREEN OWNS THIS CHORD (#656) — the press is its own.
       *
       * NO `preventDefault` ON THIS PATH, deliberately: the whole point is that
       * the palette's own keydown handler gets to answer, and this listener sits
       * at the END of the bubble chain. Cancelling here would take the key from
       * the surface we just stood down for. The surface calls `preventDefault`
       * itself, as `project-palette.tsx` already did.
       *
       * IT MATTERS IN A BROWSER TAB AND ON THE DESKTOP BOTH. On the desktop the
       * shell has already stripped the accelerator, so this is the second half
       * of one decision; in a plain tab there is no menu and this is the only
       * half — and without it the palette's handler and this one would BOTH fire
       * on one press, opening a project and then jumping the rail.
       */
      if (claimedCommandIds(latestKeymap.current).includes(id)) return;
      event.preventDefault();
      run(id);
    };
    window.addEventListener("keydown", onKeyDown);
    const offInvoke = desktop()?.commandKeys?.onInvoke?.((id) => run(id as CommandId));

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      offInvoke?.();
    };
  }, [run]);

  return run;
}
