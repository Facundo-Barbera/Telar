"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { commandDestination, resolveWebCommandKeyAction } from "./command-keys";
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
} from "./commands";
import { sessionHref, type SidebarSession } from "@/features/sessions";

type DesktopCommandKeyBridge = {
  isDesktop?: boolean;
  commandKeys?: { onInvoke?: (listener: (id: string) => void) => (() => void) | undefined };
  notifications?: { onOpen?: (listener: (path: unknown) => void) => (() => void) | undefined };
  app?: { openWindow?: (path: string) => Promise<unknown> };
};

function desktop(): DesktopCommandKeyBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: DesktopCommandKeyBridge }).telarDesktop;
}

export function useKeymap(): Keymap {
  return useSyncExternalStore(subscribeKeymap, keymapSnapshot, serverKeymapSnapshot);
}

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

export function useCommandKeys(
  rows: readonly SidebarSession[],
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
      if (id === "search-settings") focusFieldNamed("Search settings");
    },
    [router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCapturingChord()) return;
      const id = resolveWebCommandKeyAction(latestKeymap.current, event);
      if (!id) return;
      if (claimedCommandIds(latestKeymap.current).includes(id)) return;
      event.preventDefault();
      run(id);
    };
    window.addEventListener("keydown", onKeyDown);
    const offInvoke = desktop()?.commandKeys?.onInvoke?.((id) => run(id as CommandId));
    const offOpen = desktop()?.notifications?.onOpen?.((path) => {
      if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")) router.push(path);
    });

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      offInvoke?.();
      offOpen?.();
    };
  }, [run, router]);

  return run;
}
