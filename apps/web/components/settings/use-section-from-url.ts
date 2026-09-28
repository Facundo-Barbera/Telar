"use client";

import { useEffect, useState } from "react";

/** The pane a `?section=` value names, or null for an unknown id. */
export function resolveSection(raw: string | null, allowed: readonly string[]): string | null {
  return raw && allowed.includes(raw) ? raw : null;
}

/**
 * Opens on the pane the URL names, so a sign-in that left the app returns to
 * the pane it started from. Read in a deferred effect so the server render and
 * the first client render agree.
 */
export function useSectionFromUrl(fallback: string, allowed: readonly string[]): [string, (next: string) => void] {
  const [active, setActive] = useState(fallback);
  useEffect(() => {
    const task = window.setTimeout(() => {
      const named = resolveSection(new URLSearchParams(window.location.search).get("section"), allowed);
      if (named) setActive(named);
    }, 0);
    return () => window.clearTimeout(task);
    // `allowed` is a module-level constant at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [active, setActive];
}
