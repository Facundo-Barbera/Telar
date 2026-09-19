"use client";

/**
 * THE SHELF, AS A COMPOSER SEES IT — one handle over two stores.
 *
 * `prompt-shelf.ts` decides what the list IS; this decides where a gesture goes.
 * The composer holds this and never either store directly, which is the
 * containment the merge was put in one place for: if the ⌘S queue ever moves
 * into the engine, `stash` and the `"stash"` arms below change and the surface
 * does not.
 *
 * ── THE ENGINE HALF RE-READS; IT IS NEVER PUSHED A PAYLOAD ──────────────────
 * The same discipline `project-notes.ts` keeps, and here it matters more: two
 * windows and a WORKER can all write this shelf, so a listener that trusted
 * whatever a writer happened to hold would draw a list that was true in one
 * process. Three things say "go and look" — a focus, the same-window event, and
 * the journal's `prompt.drafted`, which is what makes an agent's handoff appear
 * while you are watching the turn that wrote it rather than at the next focus.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PreparedPrompt } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { mergeShelf, type ShelfRow } from "./prompt-shelf";
import { usePromptStash } from "./use-prompt-stash";
import type { StashEntry, StashedImage } from "./prompt-stash";

const api = createEngineApi();

/** Same-window propagation. Carries no payload on purpose — every listener
 *  re-reads the engine's own answer. */
export const PROMPT_SHELF_CHANGED_EVENT = "telar:prompt-shelf";

export function announcePromptShelfChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROMPT_SHELF_CHANGED_EVENT));
}

export type ShelfHandle = {
  /** Agent-written drafts, in their own band and first. */
  agents: ShelfRow[];
  /** Your own — the ⌘S queue, plus anything you put on the engine's shelf. */
  yours: ShelfRow[];
  /** Both, in the order the menu draws them. */
  rows: ShelfRow[];
  /** FALSE MEANS THE WRITE WAS REFUSED, and the caller must not clear the box. */
  stash: (entry: StashEntry) => boolean;
  /** Take a row for the composer. `undefined` means it was gone — the other
   *  window, or the agent that wrote it, got there between paint and click. */
  take: (row: ShelfRow, room: number) => { prompt: string; images: StashedImage[]; left: number } | undefined;
  /** Give images back to the ⌘S queue when the host would not hold them. */
  put: (images: StashedImage[], id: string, at: number) => void;
  drop: (row: ShelfRow) => void;
};

export function usePromptShelf(projectId: string | undefined, sessionId: string | undefined): ShelfHandle {
  const stash = usePromptStash();
  const [prompts, setPrompts] = useState<PreparedPrompt[]>([]);

  const reload = useCallback(() => {
    if (!projectId) {
      setPrompts([]);
      return;
    }
    void api
      .projectPrompts(projectId)
      // WHAT COMES BACK IS CHECKED, not trusted from the type. This is the
      // network boundary: an engine one version behind, a proxy that answered
      // `{}`, or a stub in a test all produce an answer the signature says
      // cannot exist — and a `.filter` on it throws inside a render, which
      // takes the whole composer down with it. An unreadable answer is an
      // EMPTY shelf, which is the same thing the catch below decides.
      .then((result) => setPrompts(Array.isArray(result?.prompts) ? result.prompts : []))
      // A shelf that cannot be read is an EMPTY shelf here, never an error on
      // screen: the composer's job is to take what you typed, and a failed
      // background fetch must not be the thing that interrupts it.
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    // Deferred a tick like every other client-only read in this app: setting
    // state from an effect BODY is the cascade the lint rule forbids.
    const task = window.setTimeout(reload, 0);
    window.addEventListener(PROMPT_SHELF_CHANGED_EVENT, reload);
    window.addEventListener("focus", reload);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(PROMPT_SHELF_CHANGED_EVENT, reload);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);

  const merged = useMemo(() => mergeShelf(stash.entries, prompts, sessionId), [stash.entries, prompts, sessionId]);

  /**
   * TAKEN FROM WHICHEVER STORE HOLDS IT, and the two pops are not the same
   * shape. The ⌘S queue pops ATOMICALLY through storage — `take` there re-reads
   * before it removes, which is what makes a click and an Enter on one row
   * land once. The engine's is a delete over HTTP, so the row is removed
   * optimistically and the delete follows; a failed delete re-reads, which puts
   * the row back rather than leaving the list lying.
   */
  const take = useCallback(
    (row: ShelfRow, room: number) => {
      if (row.source === "stash") return stash.take(row.id, room);
      if (!projectId) return undefined;
      setPrompts((current) => current.filter((prompt) => prompt.id !== row.id));
      void api
        .deleteProjectPrompt(projectId, row.id)
        .then(() => announcePromptShelfChanged())
        .catch(() => reload());
      return { prompt: row.text ?? "", images: row.images, left: 0 };
    },
    [projectId, reload, stash],
  );

  const drop = useCallback(
    (row: ShelfRow) => {
      if (row.source === "stash") {
        stash.drop(row.id);
        return;
      }
      if (!projectId) return;
      setPrompts((current) => current.filter((prompt) => prompt.id !== row.id));
      void api
        .deleteProjectPrompt(projectId, row.id)
        .then(() => announcePromptShelfChanged())
        .catch(() => reload());
    },
    [projectId, reload, stash],
  );

  return {
    agents: merged.agents,
    yours: merged.yours,
    rows: merged.rows,
    // ⌘S STILL WRITES THE LOCAL QUEUE, and this is the one line the open
    // migration question turns on. It is spelled as a forward rather than
    // inlined so that switching it is a switch and not a rewrite.
    stash: stash.stash,
    take,
    put: stash.put,
    drop,
  };
}
