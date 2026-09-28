"use client";

import { useCallback } from "react";
import type { DiffBaseOption, GitFileChange, GitFilePatch } from "@telar/engine-client";
import type { DiffScopeKind } from "@/lib/diff-scope";
import type { DiffTurn } from "@/lib/diff-turns";
import { api } from "../api";
import { journalPatch, patchRequestFor } from "../model";
import type { DiffView } from "./use-diff-view";

/** A row's patch reader. Its identity changes with the whitespace flag and the base, which makes open rows re-read. */
export function usePatchReader({
  sessionId,
  projectId,
  view,
  base,
  fromGit,
  kind,
  turn,
}: {
  sessionId: string | undefined;
  projectId: string | undefined;
  view: DiffView;
  base: DiffBaseOption | undefined;
  fromGit: boolean;
  kind: DiffScopeKind;
  turn: DiffTurn | undefined;
}) {
  return useCallback(
    (file: GitFileChange): Promise<{ file: GitFilePatch }> => {
      if (kind === "turn" && !fromGit) return Promise.resolve({ file: journalPatch(turn, file.path) });
      const options = patchRequestFor(file, view, base ?? {});
      return sessionId ? api.sessionFilePatch(sessionId, file.path, options) : api.projectFilePatch(projectId!, file.path, options);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, projectId, view.ignoreWhitespace, base?.base, base?.to, fromGit, kind, turn],
  );
}
