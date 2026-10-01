import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { statePaths } from "../../platform/fs/state-paths";
import { existsWithin, VolumeGate } from "../../platform/fs/volume-gate";

const REAP_EVERY_MS = 24 * 60 * 60 * 1000;
const TREE_TIMEOUT_MS = 120_000;

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
  standDown?: "swept-recently";
};

export type ReapDeps = {
  now?: () => number;
  gate?: VolumeGate;
  remove?: (directory: string) => Promise<void>;
};

async function treeSize(directory: string, signal: AbortSignal): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const frontier = [directory];
  while (frontier.length > 0) {
    if (signal.aborted) throw signal.reason;
    const at = frontier.pop()!;
    const entries = await fsp.readdir(at, { withFileTypes: true }).catch(() => []);
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(at, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) { frontier.push(full); return undefined; }
        return fsp.lstat(full).then((stat) => stat.size, () => undefined);
      }),
    );
    for (const size of sizes) if (size !== undefined) { bytes += size; files += 1; }
  }
  return { bytes, files };
}

export async function reapNodeModules(engineRoot: string, candidates: readonly ReapCandidate[], deps: ReapDeps = {}): Promise<NodeModulesReap> {
  const now = deps.now ?? (() => Date.now());
  const gate = deps.gate ?? new VolumeGate();
  const remove = deps.remove ?? ((directory: string) => fsp.rm(directory, { recursive: true, force: true }));

  const marker = statePaths(engineRoot).nodeModulesReaped;
  const last = Number(readMarker(marker));
  if (Number.isFinite(last) && last > 0 && now() - last < REAP_EVERY_MS) return { reaped: [], refused: { live: 0, working: 0 }, standDown: "swept-recently" };

  await gate.admit(candidates.filter((candidate) => candidate.archived && !candidate.live).map((candidate) => candidate.worktree));
  const reaped: ReapedTree[] = [];
  const refused = { live: 0, working: 0 };
  for (const candidate of candidates) {
    if (candidate.live) { if (candidate.archived) refused.working += 1; else refused.live += 1; continue; }
    if (!candidate.archived) { refused.live += 1; continue; }
    const tree = path.join(candidate.worktree, "node_modules");
    if (!(await existsWithin(gate, tree))) continue;
    const size = await gate.run(tree, (signal) => treeSize(tree, signal), TREE_TIMEOUT_MS);
    if (!size) continue;
    const removed = await gate.run(tree, () => remove(tree).then(() => true), TREE_TIMEOUT_MS);
    if (removed) reaped.push({ sessionId: candidate.sessionId, path: tree, ...size });
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
