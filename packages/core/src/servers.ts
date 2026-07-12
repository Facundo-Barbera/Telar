// Per-project environment lane recipe (servers.yaml in each repo). Mirrors
// manifest.ts's read → YAML.parse → safeParse pipeline. ONE deliberate
// divergence: an ABSENT servers.yaml is a legitimate "no recipe" state (the
// file is committable + tracked, unlike the untracked telar.yaml), so it
// returns EMPTY_SERVERS_CONFIG (driver: "none") instead of throwing — and
// there is no self-heal registry cache. Malformed/invalid files still throw.
//
// M7 — a SECOND, higher-precedence tier: the HUMAN-ACCEPTED `.telar/servers.yaml`
// an approveEnv writes. Precedence (D5): acceptedRoot/.telar/servers.yaml →
// root/servers.yaml → driver:"none". First EXISTING file wins; only ENOENT
// falls through; malformed/invalid at any tier still throws. `.telar/` is
// gitignored + untracked, so the accepted config is project-local, reused
// forever (once it exists the env-review trigger's driver==="none" check is
// false → no re-proposal), and never committed.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ServersConfig } from "./schemas";
import { atomicWrite } from "./manifest";

const serversFile = (root: string) => path.join(root, "servers.yaml");
const acceptedServersFile = (root: string) => path.join(root, ".telar", "servers.yaml");

// Read + parse ONE tier. Returns null on ENOENT (fall through to the next
// tier); throws on malformed YAML or a schema-invalid file (never silently
// ignored). An empty / comment-only file (YAML.parse → null) coalesces to {} →
// a valid driver:"none" config, which counts as "existing" (first-existing-wins).
function readServersTier(file: string): ServersConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null; // ENOENT — this tier is absent, fall through
  }
  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (e) {
    throw new Error(`Malformed YAML in ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ServersConfig.safeParse(data ?? {});
  if (!parsed.success) throw new Error(`Invalid servers.yaml at ${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// D4/D5: the `.telar` tier reads from `acceptedRoot` (default `root`); the repo
// tier reads from `root`. Verify passes resolveServersConfig(wt, manifest.root)
// so an accepted config anchored at manifest.root is seen even inside a fresh
// frozen worktree `wt` where the gitignored `.telar/` is absent.
export function resolveServersConfig(root: string, acceptedRoot: string = root): ServersConfig {
  const accepted = readServersTier(acceptedServersFile(acceptedRoot));
  if (accepted) return accepted;
  const repo = readServersTier(serversFile(root));
  if (repo) return repo;
  // Neither tier present. Fresh parse (not the shared EMPTY_SERVERS_CONFIG
  // constant) so a consumer that mutates the result can't poison later absent
  // resolutions.
  return ServersConfig.parse({});
}

// M7 — persist a human-accepted proposal to `.telar/servers.yaml` under `root`.
// atomicWrite creates `.telar/` on demand (mkdir recursive) + tmp+rename, so a
// crash never leaves a half-written recipe. The moat: this is only ever called
// from approveEnv, AFTER a human `by` accepted the proposal.
export function writeAcceptedServersConfig(root: string, cfg: ServersConfig): void {
  atomicWrite(acceptedServersFile(root), YAML.stringify(cfg));
}
