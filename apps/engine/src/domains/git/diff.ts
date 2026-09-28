export type PatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export const MAX_DIFF_CHARS = 12_000;

function isHunk(value: unknown): value is PatchHunk {
  if (!value || typeof value !== "object") return false;
  const hunk = value as Partial<PatchHunk>;
  return (
    typeof hunk.oldStart === "number" &&
    typeof hunk.oldLines === "number" &&
    typeof hunk.newStart === "number" &&
    typeof hunk.newLines === "number" &&
    Array.isArray(hunk.lines) &&
    hunk.lines.every((line) => typeof line === "string")
  );
}

export function patchHunksOf(value: unknown): PatchHunk[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const output = value as { structuredPatch?: unknown; content?: unknown; originalFile?: unknown };
  const patch = Array.isArray(output.structuredPatch) ? output.structuredPatch.filter(isHunk) : [];
  if (patch.length > 0) return patch;

  if (output.originalFile !== null || typeof output.content !== "string") return undefined;
  const lines = output.content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return undefined;
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`) }];
}

export function unifiedDiff(path: string, hunks: readonly PatchHunk[], max = MAX_DIFF_CHARS): { diff: string; truncated: boolean } {
  const absolute = path.startsWith("/");
  const [from, to] = absolute ? [path, path] : [`a/${path}`, `b/${path}`];
  const body: string[] = absolute ? [] : [`diff --git ${from} ${to}`];
  body.push(`--- ${from}`, `+++ ${to}`);
  for (const hunk of hunks) {
    const old = hunk.oldLines === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldLines}`;
    const now = hunk.newLines === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newLines}`;
    body.push(`@@ -${old} +${now} @@`);
    body.push(...hunk.lines);
  }
  const text = body.join("\n");
  if (text.length <= max) return { diff: text, truncated: false };
  return { diff: text.slice(0, max), truncated: true };
}

export function countDiffLines(hunks: readonly PatchHunk[]): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) linesAdded += 1;
      else if (line.startsWith("-")) linesRemoved += 1;
    }
  }
  return { linesAdded, linesRemoved };
}
