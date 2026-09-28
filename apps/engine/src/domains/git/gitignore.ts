import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GitignoreRemoval, GitignoreResult } from "@telar/engine-client";

export type IgnoreRule = { rule: string; alreadyCovered: string[]; why: string };

export const TELAR_IGNORE_RULES: IgnoreRule[] = [
  {
    rule: "telar.yaml",
    alreadyCovered: ["telar.yaml", "/telar.yaml"],
    why: "the legacy app's project manifest",
  },
  {
    rule: ".telar/",
    alreadyCovered: [".telar/", ".telar", "/.telar/", "/.telar"],
    why: "the legacy app's project-local state",
  },
  {
    rule: ".telar-worktrees/",
    alreadyCovered: [".telar-worktrees/", ".telar-worktrees", "/.telar-worktrees/", "/.telar-worktrees"],
    why: "reserved: Telar keeps worktrees outside the repository today",
  },
];

const HEADER = "# Telar — local state, not for sharing";

function existingRules(contents: string): Set<string> {
  return new Set(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
}

export function ensureTelarGitignore(root: string, rules: IgnoreRule[] = TELAR_IGNORE_RULES): GitignoreResult {
  const file = path.join(root, ".gitignore");
  let contents = "";
  let created = false;
  try {
    contents = readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    created = true;
  }

  const already = existingRules(contents);
  const added: string[] = [];
  const present: string[] = [];
  for (const entry of rules) {
    if (entry.alreadyCovered.some((pattern) => already.has(pattern))) present.push(entry.rule);
    else added.push(entry.rule);
  }
  if (added.length === 0) return { added, present, path: file, created: false };

  const prefix = contents.length > 0 && !contents.endsWith("\n") ? `${contents}\n` : contents;
  const gap = prefix.length > 0 && !prefix.endsWith("\n\n") ? "\n" : "";
  const block = [HEADER, ...added.map((rule) => rule)].join("\n");
  writeFileSync(file, `${prefix}${gap}${block}\n`, "utf8");
  return { added, present, path: file, created };
}

export function removeTelarGitignore(root: string, rules: IgnoreRule[] = TELAR_IGNORE_RULES): GitignoreRemoval {
  const file = path.join(root, ".gitignore");
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return { removed: [], path: file };
  }

  const lines = contents.split("\n");
  const at = lines.findIndex((line) => line.trim() === HEADER);
  if (at === -1) return { removed: [], path: file };

  const ours = new Set(rules.map((entry) => entry.rule));
  let end = at + 1;
  const removed: string[] = [];
  while (end < lines.length && ours.has(lines[end].trim())) {
    removed.push(lines[end].trim());
    end++;
  }
  const from = at > 0 && lines[at - 1].trim() === "" ? at - 1 : at;
  const kept = [...lines.slice(0, from), ...lines.slice(end)];
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  writeFileSync(file, kept.length === 0 ? "" : `${kept.join("\n")}\n`, "utf8");
  return { removed, path: file };
}
