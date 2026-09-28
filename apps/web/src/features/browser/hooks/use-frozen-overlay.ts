"use client";

import { useEffect, useState, type RefObject } from "react";
import { createOverlayFreezer, onNativeViewOverlay, type FrozenFrame } from "@/lib/native-view-overlay";

type OverlayBridge = {
  setVisible(scopeKey: string, visible: boolean): Promise<void>;
  freezeView?(scopeKey: string): Promise<FrozenFrame | null>;
};

type FrozenOverlayFrame = { src: string; left: number; top: number; width: number; height: number };

export function useFrozenOverlay(bridge: OverlayBridge, scopeKey: string, hostRef: RefObject<HTMLElement | null>, overlayRef: RefObject<boolean>) {
  const [frozenFrame, setFrozenFrame] = useState<FrozenOverlayFrame>();
  useEffect(() => {
    let mounted = true;
    const swap = createOverlayFreezer({
      freeze: async () => {
        if (!bridge.freezeView) {
          await bridge.setVisible(scopeKey, false);
          return null;
        }
        return bridge.freezeView(scopeKey);
      },
      show: async () => {
        if (mounted) await bridge.setVisible(scopeKey, true);
      },
      paint: (frame) => {
        if (!mounted) return;
        const host = hostRef.current;
        if (!frame || !host) {
          setFrozenFrame(undefined);
          return;
        }
        const rect = host.getBoundingClientRect();
        setFrozenFrame({
          src: `data:${frame.mimeType};base64,${frame.data}`,
          left: frame.rect.x - rect.left,
          top: frame.rect.y - rect.top,
          width: frame.rect.width,
          height: frame.rect.height,
        });
      },
    });
    const unsubscribe = onNativeViewOverlay((hidden) => {
      if (overlayRef.current === hidden) return;
      overlayRef.current = hidden;
      void swap(hidden);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [bridge, scopeKey, hostRef, overlayRef]);
  return frozenFrame;
}
