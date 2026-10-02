"use client";

import { useEffect, useState } from "react";

type OverlayListener = (hidden: boolean) => void;

let openCount = 0;
const listeners = new Set<OverlayListener>();

function publish(): void {
  const hidden = openCount > 0;
  for (const listener of listeners) listener(hidden);
}

export function onNativeViewOverlay(listener: OverlayListener): () => void {
  listeners.add(listener);
  listener(openCount > 0);
  return () => {
    listeners.delete(listener);
  };
}

export function claimNativeView(): () => void {
  openCount += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount -= 1;
    publish();
  };
}

export function useNativeViewOverlay(open: boolean): void {
  useEffect(() => (open ? claimNativeView() : undefined), [open]);
}

type OverlayRoot<Details> = {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, details: Details) => void) | undefined;
};

/** For an overlay's root, controlled or not: pass the result as its `onOpenChange`. */
export function useOverlayRootClaim<Details>({ open, defaultOpen, onOpenChange }: OverlayRoot<Details>) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen ?? false);
  useNativeViewOverlay(open ?? ownOpen);
  return (next: boolean, details: Details) => {
    setOwnOpen(next);
    onOpenChange?.(next, details);
  };
}

export function nativeViewOverlayHidden(): boolean {
  return openCount > 0;
}

export type FrozenFrame = {
  data: string;
  mimeType: string;
  rect: { x: number; y: number; width: number; height: number };
};

export type OverlayShell = {
  freeze: () => Promise<FrozenFrame | null>;
  show: () => Promise<void>;
  paint: (frame: FrozenFrame | null) => void;
};

export function createOverlayFreezer(shell: OverlayShell): (hidden: boolean) => Promise<void> {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  return (hidden: boolean) => {
    const mine = (generation += 1);
    queue = queue
      .then(async () => {
        if (generation !== mine) return;
        if (!hidden) {
          await shell.show();
          shell.paint(null);
          return;
        }
        let frame: FrozenFrame | null = null;
        try {
          frame = await shell.freeze();
        } catch {
          frame = null;
        }
        if (generation !== mine) return;
        shell.paint(frame);
      })
      .catch(() => undefined);
    return queue;
  };
}
