"use client";

import { useEffect, useState } from "react";

/** The pane a `?section=` value names: aliases resolved, unknown ids dropped. */
export function resolveSection(raw: string | null, allowed: readonly string[], aliases?: Readonly<Record<string, string>>): string | null {
  const named = raw ? (aliases?.[raw] ?? raw) : null;
  return named && allowed.includes(named) ? named : null;
}

/**
 * Opens on the pane the URL names, so a sign-in that left the app returns to
 * the pane it started from. Read in a deferred effect so the server render and
 * the first client render agree.
 */
export function useSectionFromUrl(fallback: string, allowed: readonly string[], aliases?: Readonly<Record<string, string>>): [string, (next: string) => void] {
  const [active, setActive] = useState(fallback);
  useEffect(() => {
    const task = window.setTimeout(() => {
      const named = resolveSection(new URLSearchParams(window.location.search).get("section"), allowed, aliases);
      if (named) setActive(named);
    }, 0);
    return () => window.clearTimeout(task);
    // `allowed` and `aliases` are module-level constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [active, setActive];
}
