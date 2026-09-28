"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PreparedPrompt } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine/index";
import { mergeShelf, type ShelfRow } from "./prompt-shelf";
import { usePromptStash } from "./use-prompt-stash";
import type { StashEntry, StashedImage } from "./prompt-stash";

const api = createEngineApi();

const PROMPT_SHELF_CHANGED_EVENT = "telar:prompt-shelf";

export function announcePromptShelfChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROMPT_SHELF_CHANGED_EVENT));
}

export type ShelfHandle = {
  agents: ShelfRow[];
  yours: ShelfRow[];
  rows: ShelfRow[];
  stash: (entry: StashEntry) => boolean;
  take: (row: ShelfRow, room: number) => { prompt: string; images: StashedImage[]; left: number } | undefined;
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
      .then((result) => setPrompts(Array.isArray(result?.prompts) ? result.prompts : []))
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
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
    stash: stash.stash,
    take,
    put: stash.put,
    drop,
  };
}
