"use client";

import { useEffect, useState } from "react";

export function resolveSection(raw: string | null, allowed: readonly string[]): string | null {
  return raw && allowed.includes(raw) ? raw : null;
}

export function useSectionFromUrl(fallback: string, allowed: readonly string[]): [string, (next: string) => void] {
  const [active, setActive] = useState(fallback);
  useEffect(() => {
    const task = window.setTimeout(() => {
      const named = resolveSection(new URLSearchParams(window.location.search).get("section"), allowed);
      if (named) setActive(named);
    }, 0);
    return () => window.clearTimeout(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [active, setActive];
}
