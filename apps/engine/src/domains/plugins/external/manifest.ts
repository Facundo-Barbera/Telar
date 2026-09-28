import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGIN_TOOL_PREFIXES, ExternalPluginManifest, PLUGIN_API_VERSION, PluginId, type PluginMeta } from "@telar/engine-client";
import { BUNDLED_PLUGIN_IDS } from "../bundled";

const MANIFEST_FILE = "plugin.json";

export type LoadedExternalPlugin = { dir: string; manifest: ExternalPluginManifest };
export type RefusedExternalPlugin = { dir: string; meta: PluginMeta; error: string };

export function externalPluginsDir(engineRoot: string): string {
  return path.join(path.dirname(engineRoot), "plugins");
}

function refusedMeta(id: string, name: string): PluginMeta {
  return { id, api: PLUGIN_API_VERSION, name, version: "?", toolPrefixes: [], readTools: [], eventKinds: [], settings: [] };
}

function describe(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`).join("; ");
}

export type Reservations = { ids: ReadonlySet<string>; prefixes: ReadonlySet<string> };

const ROUTE_IDS = ["installed"];

export function checkPluginFolder(
  folder: string,
  expectedId: string | undefined,
  reserved: Reservations,
): { manifest: ExternalPluginManifest } | { error: string; name?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(folder, MANIFEST_FILE), "utf8"));
  } catch (error) {
    return { error: `${MANIFEST_FILE}: ${error instanceof SyntaxError ? `not valid JSON (${error.message})` : "missing"}` };
  }
  const parsed = ExternalPluginManifest.safeParse(raw);
  if (!parsed.success) {
    const named = (raw as { name?: unknown } | null)?.name;
    return { error: `${MANIFEST_FILE}: ${describe(parsed.error)}`, ...(typeof named === "string" ? { name: named } : {}) };
  }
  const manifest = parsed.data;
  const refuse = (error: string) => ({ error: `${MANIFEST_FILE}: ${error}`, name: manifest.name });
  if (expectedId !== undefined && manifest.id !== expectedId) return refuse(`id "${manifest.id}" does not match its folder "${expectedId}"`);
  if (reserved.ids.has(manifest.id) || ROUTE_IDS.includes(manifest.id)) return refuse(`id "${manifest.id}" is already taken`);
  if (manifest.toolPrefix && reserved.prefixes.has(manifest.toolPrefix)) {
    return refuse(`tool prefix "${manifest.toolPrefix}" is already owned by another plugin`);
  }
  const program = manifest.command[0]!;
  if (program.startsWith("./") && !fs.existsSync(path.join(folder, program))) return refuse(`command "${program}" is not in the plugin's folder`);
  return { manifest };
}

function listedId(name: string): string {
  return PluginId.safeParse(name).success ? name : `invalid-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 64);
}

function refusedPlugin(folder: string, error: string, name?: string): RefusedExternalPlugin {
  const folderName = path.basename(folder);
  return { dir: folder, meta: refusedMeta(listedId(folderName), name ?? folderName), error };
}

function loadExternalPlugins(dir: string, reserved: Reservations): { loaded: LoadedExternalPlugin[]; refused: RefusedExternalPlugin[] } {
  const loaded: LoadedExternalPlugin[] = [];
  const refused: RefusedExternalPlugin[] = [];
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .filter((name) => {
        try {
          return fs.statSync(path.join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return { loaded, refused };
  }
  const ids = new Set(reserved.ids);
  const prefixes = new Set(reserved.prefixes);
  for (const name of names) {
    const folder = path.join(dir, name);
    const checked = checkPluginFolder(folder, name, { ids, prefixes });
    if ("error" in checked) {
      refused.push(refusedPlugin(folder, checked.error, checked.name));
      continue;
    }
    ids.add(checked.manifest.id);
    if (checked.manifest.toolPrefix) prefixes.add(checked.manifest.toolPrefix);
    loaded.push({ dir: folder, manifest: checked.manifest });
  }
  return { loaded, refused };
}

export function loadInstalledPlugins(dir: string) {
  return loadExternalPlugins(dir, BUNDLED_RESERVATIONS);
}

export const BUNDLED_RESERVATIONS: Reservations = { ids: new Set(BUNDLED_PLUGIN_IDS), prefixes: new Set(BUNDLED_PLUGIN_TOOL_PREFIXES) };
