"use client";

import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";

import type { LineSide } from "@/features/composer";

export type PatchReading = {
  complaint?: string;
  files: number;
  file?: {
    name: string;
    prevName?: string;
    type?: string;
    mode?: string;
    prevMode?: string;
    hunks: number;
  };
};

/** `throwOnError`: without it the parser logs a malformed patch and draws a plausible wrong answer. */
export function readPatchShape(patch: string): PatchReading {
  try {
    const files = parsePatchFiles(patch, undefined, true).flatMap((parsed) => parsed.files ?? []);
    const only = files.length === 1 ? files[0] : undefined;
    return {
      files: files.length,
      ...(only
        ? {
            file: {
              name: String(only.name ?? ""),
              ...(only.prevName ? { prevName: String(only.prevName) } : {}),
              ...(only.type ? { type: String(only.type) } : {}),
              ...(only.mode ? { mode: String(only.mode) } : {}),
              ...(only.prevMode ? { prevMode: String(only.prevMode) } : {}),
              hunks: only.hunks?.length ?? 0,
            },
          }
        : {}),
    };
  } catch (error) {
    return { complaint: error instanceof Error ? error.message : String(error), files: 0 };
  }
}

/** The library names a side by diff half; a reference names it by file version, so `deletions` count the file before. */
export function toLineRange(range: SelectedLineRange): { start: number; end: number; startSide: LineSide; endSide: LineSide } {
  const startSide: LineSide = range.side === "deletions" ? "before" : "after";
  const endSide: LineSide = (range.endSide ?? range.side) === "deletions" ? "before" : "after";
  return { start: range.start, end: range.end, startSide, endSide };
}

export type DiffLayout = "stacked" | "split";

const THEME = { light: "github-light", dark: "github-dark" } as const;

export function DiffCodeView({
  patch,
  layout,
  wrap,
  onLinesSelected,
}: {
  patch: string;
  layout: DiffLayout;
  wrap: boolean;
  onLinesSelected?: (range: SelectedLineRange | null) => void;
}) {
  return (
    <PatchDiff
      patch={patch}
      disableWorkerPool
      className="diff-code-view max-h-72"
      options={{
        theme: THEME,
        diffStyle: layout === "split" ? "split" : "unified",
        overflow: wrap ? "wrap" : "scroll",
        disableFileHeader: true,
        ...(onLinesSelected ? { enableLineSelection: true, onLineSelected: onLinesSelected } : {}),
      }}
    />
  );
}
