import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * Viewport class, read as an EXTERNAL STORE rather than mirrored into state.
 *
 * The vendored version subscribed in an effect and then called `setIsMobile`
 * synchronously in the same effect to seed the initial value — a cascading
 * render on every mount, and an eslint error under the react-hooks rules this
 * app runs. `useSyncExternalStore` is what the pattern is for: React reads the
 * value during render and re-reads it when the subscription fires, so there is
 * no seed step to get wrong.
 *
 * The server snapshot is `false` — desktop — because SSR has no viewport and a
 * mismatch here would swap the sidebar between a rail and a sheet on hydration.
 */
function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
