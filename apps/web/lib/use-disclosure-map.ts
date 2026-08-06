"use client";

import { useCallback, useState } from "react";

// A per-consumer disclosure map — the same `isOpen`/`setOpen` SHAPE the
// Conversation shell's own `ItemViewState` hands a registered item kind (see
// `components/conversation/registry.ts`'s `TranscriptViewport`, which keeps
// this exact state inline for its own item tree). A surface that renders one
// of those components OUTSIDE the shell has nowhere else to get it: issue #13
// moved the Ultra pane (`UltraTabView`) out of the transcript and into the
// right-panel Activity dock specifically so it stops displacing the main
// chat, and that pane still needs somewhere to remember "which agent's
// transcript is expanded" without reaching for ambient state (AD-12). This is
// that somewhere, extracted so the second caller does not re-implement the
// shell's own three lines from scratch.
export function useDisclosureMap() {
  const [state, setState] = useState<Record<string, boolean>>({});
  const isOpen = useCallback(
    (key: string, fallback = false) => state[key] ?? fallback,
    [state],
  );
  const setOpen = useCallback(
    (key: string, next: boolean) => setState((prev) => ({ ...prev, [key]: next })),
    [],
  );
  return { isOpen, setOpen };
}
