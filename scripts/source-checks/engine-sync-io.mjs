import { filesUnder, read } from "./files.mjs";

const SCOPES = ["apps/engine/src/domains/worktrees", "apps/engine/src/domains/storage", "apps/engine/src/platform/git"];

/** Each file's exact count of `*Sync` names; a file that drops one must lower its count, so the list only shrinks. */
const ALLOWED = {
  "apps/engine/src/domains/worktrees/checkout.ts": { count: 4, reason: "lock reason's mount check and removing an unregistered checkout, one checkout per person-run reclaim" },
  "apps/engine/src/domains/worktrees/dependencies.ts": { count: 12, reason: "sharing a project's node_modules into a new worktree and pruning build output on archive, one worktree at a time" },
  "apps/engine/src/domains/worktrees/inventory.ts": { count: 4, reason: "the worktree inventory a person opens in Storage; reads the roots and the checkouts on them" },
  "apps/engine/src/domains/worktrees/location.ts": { count: 6, reason: "the worktrees-location record in the engine's own directory and the configured root's existence" },
  "apps/engine/src/domains/worktrees/maintenance.ts": { count: 2, reason: "existence checks before a release, a move or a lock, per worktree session" },
  "apps/engine/src/domains/worktrees/move.ts": { count: 1, reason: "creates the destination a person chose for a move" },
  "apps/engine/src/domains/worktrees/release.ts": { count: 1, reason: "existence check of the one checkout being released" },
  "apps/engine/src/domains/worktrees/session-worktree.ts": { count: 3, reason: "existence checks around removing the one session's worktree" },
  "apps/engine/src/domains/worktrees/setup.ts": { count: 5, reason: "setup status and log files under the engine's own directory" },
  "apps/engine/src/domains/storage/cleanup.ts": { count: 1, reason: "reads the cleanup policy file under the engine's own directory" },
  "apps/engine/src/domains/storage/copy.ts": { count: 7, reason: "copying the store to a folder a person chose, as a blocking step they asked for" },
  "apps/engine/src/domains/storage/decommission-sweep.ts": { count: 13, reason: "one-time removal of retired directories under the engine's own directory, fenced by a marker" },
  "apps/engine/src/domains/storage/measure.ts": { count: 1, reason: "existence of execution.sqlite under the engine's own directory" },
  "apps/engine/src/domains/storage/node-modules-reap.ts": { count: 3, reason: "the reap of archived checkouts' node_modules, at most once a day" },
  "apps/engine/src/domains/storage/package-caches.ts": { count: 1, reason: "default stat for the package-cache dedup probe; tests inject their own" },
  "apps/engine/src/platform/git/runner.ts": { count: 1, reason: "the bounded synchronous git runner, killed at its timeout" },
};

const strip = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/^import[\s\S]*?from\s*["'][^"']+["'];?$/gm, "")
    .replace(/\btypeof\s+\w+Sync\b/g, "");

/** How many `fooSync` names the code (not its comments or imports) uses. */
export const syncNames = (text) => strip(text).match(/\b[a-z]\w*Sync\b/g)?.length ?? 0;

export const engineSyncIoCheck = {
  name: "no-sync-io-on-worktree-paths",
  protects: "engine code under worktrees, storage and platform/git adds no *Sync fs or spawnSync call; a blocked one freezes the whole engine on a slow volume (#1293)",
  run() {
    const files = SCOPES.flatMap((dir) => filesUnder(dir, /\.ts$/));
    if (files.length < 20) return [`${SCOPES.join(", ")}: only ${files.length} files found; the scan has rotted.`];
    const failures = [];
    for (const file of files) {
      const count = syncNames(read(file));
      const allowed = ALLOWED[file];
      if (count === 0 && !allowed) continue;
      if (!allowed) failures.push(`${file}: ${count} *Sync call(s) — use fs.promises or the git pool`);
      else if (count > allowed.count) failures.push(`${file}: ${count} *Sync calls, ${allowed.count} allowed — use fs.promises or the git pool`);
      else if (count < allowed.count) failures.push(`${file}: ${count} *Sync calls, lower ALLOWED's count from ${allowed.count} in scripts/source-checks/engine-sync-io.mjs${count === 0 ? " (or drop the entry)" : ""}`);
    }
    for (const file of Object.keys(ALLOWED)) if (!files.includes(file)) failures.push(`${file}: listed in ALLOWED but gone; drop the entry`);
    return failures;
  },
};
