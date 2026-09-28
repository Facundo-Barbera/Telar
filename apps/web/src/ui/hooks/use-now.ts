"use client";

import { useEffect, useState } from "react";

/** `Date.now()`, re-read every `ms`. Mount it in the component that shows the time, so only that re-renders. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}
