"use client";

/**
 * The stash, as a composer sees it.
 *
 * TWO COMPOSERS CAN BE ON SCREEN AT ONCE — and this app has no store to share
 * between them. The pattern it does have is
 * `inbox-policy.ts`'s: write, then announce on a `CustomEvent` carrying the new
 * value, so a listener never has to re-read what the writer already holds. That
 * matters more here than there, because re-reading means parsing megabytes of
 * data URLs to update a number in a badge.
 *
 * THE `storage` EVENT IS THE OTHER HALF, and it is three lines. It fires only
 * for OTHER tabs, so the two together cover both cases with no overlap: without
 * it, popping an entry in one window leaves the other listing a row that is gone.
 */

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
  /** FALSE MEANS STORAGE REFUSED, and the caller must not clear the composer. */
  stash: (entry: StashEntry) => boolean;
  take: (id: string, room: number) => { prompt: string; images: StashedImage[]; left: number } | undefined;
  /** Give images back — the composer handed them to a host that did not take
   *  them. Lands as its own entry rather than reopening the popped one, which
   *  is gone by then. */
  put: (images: StashedImage[], id: string, at: number) => void;
  drop: (id: string) => void;
};

export function usePromptStash(): StashHandle {
  const [entries, setEntries] = useState<StashEntry[]>([]);

  useEffect(() => {
    // Deferred a tick like every other client-only read in this app: setting
    // state from an effect BODY is the cascade the lint rule forbids.
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

  /** One path in and out, so every mutation announces and none can forget to. */
  const apply = useCallback((mutate: (current: StashEntry[]) => StashEntry[]) => {
    const result = commitStash(mutate);
    setEntries(result.entries);
    window.dispatchEvent(new CustomEvent<StashEntry[]>(CHANGED, { detail: result.entries }));
    return result;
  }, []);

  const stash = useCallback((entry: StashEntry) => apply((current) => pushEntry(current, entry)).ok, [apply]);

  /**
   * READ THE POP OUT OF STORAGE, not out of `entries`.
   *
   * The row the user clicked may have been taken by the other window between
   * the paint and the click, and storage is the only place that knows. An
   * undefined return is that race, and the caller does nothing — which is also
   * the guard against a click and an Enter landing on the same row.
   */
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
