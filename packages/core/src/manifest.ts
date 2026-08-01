// Project manifests (telar.yaml in each repo) + global registry (~/.telar/projects.json).
// The repo owns its manifest; the registry only remembers where repos live.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { z } from "zod";
import { ProjectManifest } from "./schemas";

// `manifest` caches the last-known-good parsed manifest so getProject can
// self-heal a telar.yaml wiped by a build agent's `git clean`/`checkout`.
// Optional so pre-existing projects.json entries (without it) still parse.
export type RegistryEntry = { name: string; root: string; addedAt: number; manifest?: ProjectManifest };

// The state root. Lazy (never captured at module evaluation) so a test or a
// reconfigured process can re-point it, and exported because os.homedir() is
// resolved at process start under Bun — the unset fallback can only be
// asserted as a STRING, never by writing into a fake home in-process.
//
// WHY trim-and-check rather than `??`: `??` falls back on null/undefined but
// NOT on "", and an exported-but-empty `TELAR_HOME=` is routine in shell
// scripts and CI. Measured with root "": atomicWrite's
// mkdirSync(path.dirname("projects.json")) resolves to "." and SUCCEEDS, so
// the global registry is written to — and read back from — whatever the
// process's cwd happens to be, with no error anywhere. This resolver is also
// the one the spend ledger itself uses (usage-ledger.ts's usageFile()), so an
// empty root moves the money record too.
//
// The same guard is a like-for-like copy in looms.ts and in apps/web's
// store.ts, permissions.ts and session-log.ts. Five copies is deliberate here:
// collapsing the duplication into a shared helper is separately tracked and
// would widen this change well past the defect.
//
// DESIGN CALL on a RELATIVE root: path.resolve makes it absolute but still
// lands it under the cwd, and it pins NOTHING — this resolver is lazy, so
// path.resolve re-runs against the CURRENT cwd on every call and a process that
// chdir's mid-run reads and writes a different root afterwards (measured: with
// TELAR_HOME="rel-root", two calls straddling a process.chdir() returned two
// different absolute paths). Refusing a relative root outright is the stronger
// guarantee, but it is a behavior change beyond this fix, so we resolve and
// document.
export function telarDir(): string {
  const v = process.env.TELAR_HOME?.trim();
  return v ? path.resolve(v) : path.join(os.homedir(), ".telar");
}

const registryFile = () => path.join(telarDir(), "projects.json");
const manifestFile = (root: string) => path.join(root, "telar.yaml");

// Exported for servers.ts's writeAcceptedServersConfig (M7) — the same
// mkdir+tmp+rename idiom, so an accepted `.telar/servers.yaml` is written
// atomically and its parent dir is created on demand.
export function atomicWrite(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readRegistry(): Record<string, RegistryEntry> {
  try {
    return JSON.parse(fs.readFileSync(registryFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeRegistry(reg: Record<string, RegistryEntry>) {
  atomicWrite(registryFile(), JSON.stringify(reg, null, 2));
}

export function loadManifest(root: string): ProjectManifest {
  const file = manifestFile(root);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`No telar.yaml at ${file} — not a telar project (createProject to scaffold one).`);
  }
  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (e) {
    throw new Error(`Malformed YAML in ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ProjectManifest.safeParse(data);
  if (!parsed.success) throw new Error(`Invalid telar.yaml at ${file}: ${z.prettifyError(parsed.error)}`);
  // THE DIRECTORY WINS, always — over an absent `root:` and over a stale one a
  // teammate committed from their own machine. See the field's note in
  // schemas.ts: the manifest is shared, the path is not.
  return { ...parsed.data, root: path.resolve(root) };
}

// `root` is stripped rather than written. It is derived on every load from the
// directory the file lives in, so persisting it can only ever create a second,
// staler answer to a question that already has a correct one.
export function writeManifest(root: string, m: ProjectManifest): void {
  const { root: _derived, ...persisted } = m;
  atomicWrite(manifestFile(root), YAML.stringify(persisted));
}

export function registerProject(root: string): ProjectManifest {
  const manifest = loadManifest(root);
  const reg = readRegistry();
  reg[manifest.name] = {
    name: manifest.name,
    root: path.resolve(root),
    addedAt: reg[manifest.name]?.addedAt ?? Date.now(),
    manifest, // seed the last-known-good cache
  };
  writeRegistry(reg);
  return manifest;
}

export function createProject(root: string, partial?: Partial<ProjectManifest>): ProjectManifest {
  const abs = path.resolve(root);
  const file = manifestFile(abs);
  if (fs.existsSync(file)) throw new Error(`Refusing to scaffold: ${file} already exists.`);
  const manifest = ProjectManifest.parse({
    ...partial,
    name: partial?.name ?? path.basename(abs),
    root: abs,
  });
  writeManifest(abs, manifest);
  registerProject(abs);
  return manifest;
}

export function listProjects(): Array<{
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  error: string | null;
}> {
  return Object.values(readRegistry()).map((entry) => {
    try {
      return { entry, manifest: loadManifest(entry.root), error: null };
    } catch (e) {
      return { entry, manifest: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function getProject(name: string): { entry: RegistryEntry; manifest: ProjectManifest } {
  const reg = readRegistry();
  const entry = reg[name];
  if (!entry) throw new Error(`Unknown project "${name}" — not in the registry.`);

  // Self-heal: telar.yaml is untracked, so a build agent's `git clean`/
  // `checkout`/`reset` can wipe it. If the file is simply MISSING but we have a
  // last-known-good cache, restore it from cache and carry on. A present-but-
  // malformed/schema-invalid manifest is a real config error and must still
  // throw (loadManifest surfaces it) — never mask that with a stale cache.
  if (!fs.existsSync(manifestFile(entry.root))) {
    if (entry.manifest) {
      // Re-derive `root` here too, so the healed manifest obeys the same rule
      // as a loaded one: the registry entry says where this project is NOW, and
      // a cache seeded before a move must not outvote it.
      const healed = { ...entry.manifest, root: path.resolve(entry.root) };
      writeManifest(entry.root, healed);
      return { entry, manifest: healed };
    }
    return { entry, manifest: loadManifest(entry.root) }; // no cache — throws as before
  }

  const manifest = loadManifest(entry.root);
  // Refresh the cache whenever the live manifest drifts from what we remembered.
  if (!isDeepStrictEqual(manifest, entry.manifest)) {
    reg[name] = { ...entry, manifest };
    writeRegistry(reg);
    return { entry: reg[name], manifest };
  }
  return { entry, manifest };
}

export function unregisterProject(name: string): boolean {
  const reg = readRegistry();
  if (!(name in reg)) return false;
  delete reg[name];
  writeRegistry(reg);
  return true;
}
