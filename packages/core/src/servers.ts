// Per-project environment lane recipe (servers.yaml in each repo). Mirrors
// manifest.ts's read → YAML.parse → safeParse pipeline. ONE deliberate
// divergence: an ABSENT servers.yaml is a legitimate "no recipe" state (the
// file is committable + tracked, unlike the untracked telar.yaml), so it
// returns EMPTY_SERVERS_CONFIG (driver: "none") instead of throwing — and
// there is no self-heal registry cache. Malformed/invalid files still throw.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ServersConfig } from "./schemas";

const serversFile = (root: string) => path.join(root, "servers.yaml");

export function resolveServersConfig(root: string): ServersConfig {
  const file = serversFile(root);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // Absent is legitimate: no recipe → today's static-url path, unchanged.
    // Fresh parse (not the shared EMPTY_SERVERS_CONFIG constant) so a consumer
    // that mutates the result can't poison later absent-file resolutions.
    return ServersConfig.parse({});
  }
  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (e) {
    throw new Error(`Malformed YAML in ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // An empty / comment-only file (YAML.parse → null) is also "no recipe", not
  // an error — coalesce to {} so it degrades to the none-driver default.
  const parsed = ServersConfig.safeParse(data ?? {});
  if (!parsed.success) throw new Error(`Invalid servers.yaml at ${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
