import { useEffect, useState } from "react";
import { desktopBrowserBridge } from "@/features/browser";
import type { LivePage } from "../model";

/** The shell's live tab list per browser scope, or nothing outside the shell. Stamped with the keys so a session switch drops stale pages. */
export function useLivePages(scopeKeys: readonly string[]): ReadonlyMap<string, LivePage[]> | undefined {
  const bridge = desktopBrowserBridge();
  // Joined so a fresh array each render does not re-run the effect; neither a session id nor a tab id holds a newline.
  const keys = scopeKeys.join("\n");
  const [result, setResult] = useState<{ keys: string; pages: ReadonlyMap<string, LivePage[]> }>();
  useEffect(() => {
    const wanted = keys ? keys.split("\n") : [];
    if (!bridge || wanted.length === 0) return;
    let cancelled = false;
    const take = (state: { scopeKey: string; tabs: LivePage[] }) => {
      if (cancelled || !wanted.includes(state.scopeKey)) return;
      setResult((current) => {
        const pages = new Map(current?.keys === keys ? current.pages : []);
        pages.set(state.scopeKey, state.tabs);
        return { keys, pages };
      });
    };
    const first = window.setTimeout(() => {
      for (const key of wanted) void bridge.getState(key).then(take, () => undefined);
    }, 0);
    const unsubscribe = bridge.onState(take);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      unsubscribe();
    };
  }, [bridge, keys]);
  return bridge && result?.keys === keys ? result.pages : undefined;
}
