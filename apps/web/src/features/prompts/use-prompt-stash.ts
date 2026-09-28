"use client";

import { useCallback, useEffect, useState } from "react";
import {
  commitStash,
  dropEntry,
  pushEntry,
  readStash,
  takeEntry,
  type StashEntry,
  type StashedImage,
} from "./prompt-stash";

const CHANGED = "telar:prompt-stash";

export type StashHandle = {
  entries: StashEntry[];
  stash: (entry: StashEntry) => boolean;
  take: (id: string, room: number) => { prompt: string; images: StashedImage[]; left: number } | undefined;
  put: (images: StashedImage[], id: string, at: number) => void;
  drop: (id: string) => void;
};

export function usePromptStash(): StashHandle {
  const [entries, setEntries] = useState<StashEntry[]>([]);

  useEffect(() => {
    const task = window.setTimeout(() => setEntries(readStash()), 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<StashEntry[]>).detail;
      if (next) setEntries(next);
    };
    const onStorage = () => setEntries(readStash());
    window.addEventListener(CHANGED, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const apply = useCallback((mutate: (current: StashEntry[]) => StashEntry[]) => {
    const result = commitStash(mutate);
    setEntries(result.entries);
    window.dispatchEvent(new CustomEvent<StashEntry[]>(CHANGED, { detail: result.entries }));
    return result;
  }, []);

  const stash = useCallback((entry: StashEntry) => apply((current) => pushEntry(current, entry)).ok, [apply]);

  const take = useCallback(
    (id: string, room: number) => {
      let taken: { prompt: string; images: StashedImage[]; left: number } | undefined;
      apply((current) => {
        const result = takeEntry(current, id, room);
        if (!result) return current;
        taken = { prompt: result.prompt, images: result.images, left: result.left };
        return result.next;
      });
      return taken;
    },
    [apply],
  );

  const put = useCallback(
    (images: StashedImage[], id: string, at: number) => {
      if (images.length === 0) return;
      apply((current) => pushEntry(current, { id, at, prompt: "", images }));
    },
    [apply],
  );

  const drop = useCallback((id: string) => void apply((current) => dropEntry(current, id)), [apply]);

  return { entries, stash, take, put, drop };
}
