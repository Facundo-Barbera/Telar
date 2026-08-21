import { useCallback, useSyncExternalStore } from "react";

/**
 * "Is the window narrower than `breakpoint`?", read as an EXTERNAL STORE.
 *
 * Same shape and same reasoning as `use-mobile.ts`, generalised over the
 * threshold: subscribing in an effect and seeding the value with a `setState`
 * in the same effect is a cascading render and an eslint error under the
 * react-hooks rules this app runs. `useSyncExternalStore` reads during render
 * and re-reads when the media query fires, so there is no seed step.
 *
 * The server snapshot is `false` — wide — because SSR has no viewport, and the
 * only thing this decides is whether an auxiliary panel starts open.
 */
export function useNarrowWindow(breakpoint: number): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
