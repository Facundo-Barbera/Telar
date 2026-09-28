import fs from "node:fs";
import path from "node:path";
import { statePaths } from "../../state-paths";

const REAP_EVERY_MS = 24 * 60 * 60 * 1000;

export type ReapCandidate = {
  sessionId: string;
  worktree: string;
  archived: boolean;
  live: boolean;
};

type ReapedTree = { sessionId: string; path: string; bytes: number; files: number };

export type NodeModulesReap = {
  reaped: ReapedTree[];
  refused: { live: number; working: number };
  standDown?: "root-unreadable" | "swept-recently";
};

export type ReapDeps = {
  now?: () => number;
  remove?: (directory: string) => void;
  exists?: (target: string) => boolean;
};

function treeSize(directory: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const frontier = [directory];
  while (frontier.length > 0) {
    const at = frontier.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { frontier.push(full); continue; }
      try { bytes += fs.lstatSync(full).size; files += 1; } catch { }
    }
  }
  return { bytes, files };
}

export function reapNodeModules(
  engineRoot: string,
  input: { rootReadable: boolean; candidates: readonly ReapCandidate[] },
  deps: ReapDeps = {},
): NodeModulesReap {
  const now = deps.now ?? (() => Date.now());
  const remove = deps.remove ?? ((directory: string) => fs.rmSync(directory, { recursive: true, force: true }));
  const exists = deps.exists ?? ((target: string) => fs.existsSync(target));
  const empty: NodeModulesReap = { reaped: [], refused: { live: 0, working: 0 } };

  if (!input.rootReadable) return { ...empty, standDown: "root-unreadable" };

  const marker = statePaths(engineRoot).nodeModulesReaped;
  const last = Number(readMarker(marker));
  if (Number.isFinite(last) && last > 0 && now() - last < REAP_EVERY_MS) return { ...empty, standDown: "swept-recently" };

  const reaped: ReapedTree[] = [];
  const refused = { live: 0, working: 0 };
  for (const candidate of input.candidates) {
    if (candidate.live) { if (candidate.archived) refused.working += 1; else refused.live += 1; continue; }
    if (!candidate.archived) { refused.live += 1; continue; }
    const tree = path.join(candidate.worktree, "node_modules");
    if (!exists(tree)) continue;
    const { bytes, files } = treeSize(tree);
    try {
      remove(tree);
      reaped.push({ sessionId: candidate.sessionId, path: tree, bytes, files });
    } catch {
    }
  }

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${new Date(now()).toISOString()}\n`, "utf8");
  } catch {
  }
  return { reaped, refused };
}

function readMarker(marker: string): number {
  try { return Date.parse(fs.readFileSync(marker, "utf8").trim()); } catch { return 0; }
}

export function reapReport(reap: NodeModulesReap): string | undefined {
  if (reap.reaped.length === 0) return undefined;
  const bytes = reap.reaped.reduce((sum, tree) => sum + tree.bytes, 0);
  const size = bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${(bytes / 1_000_000).toFixed(0)} MB`;
  const trees = `${reap.reaped.length.toLocaleString("en-US")} ${reap.reaped.length === 1 ? "checkout" : "checkouts"}`;
  return `Telar engine: removed node_modules from ${trees} of archived sessions — up to ${size}, remade by the next install (#633)`;
}
