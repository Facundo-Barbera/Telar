/**
 * FINDING EXTERNAL PLUGINS — `<TELAR_HOME>/plugins/<id>/plugin.json`, read and
 * validated strictly, NEVER FATAL.
 *
 * A folder whose manifest does not parse, names another folder's id, reuses a
 * bundled id or a tool prefix somebody already owns, or points at a program
 * that is not there, is REFUSED: it is listed on Settings ▸ Plugins as failed,
 * with the sentence that says why, and it contributes nothing. The engine
 * starts either way — a typo in somebody's plugin is not a reason Telar did
 * not open.
 */
import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGIN_TOOL_PREFIXES, ExternalPluginManifest, PLUGIN_API_VERSION, PluginId, type PluginMeta } from "@telar/engine-client";
import { BUNDLED_PLUGIN_IDS } from "../bundled";

export const MANIFEST_FILE = "plugin.json";

export type LoadedExternalPlugin = { dir: string; manifest: ExternalPluginManifest };
export type RefusedExternalPlugin = { dir: string; meta: PluginMeta; error: string };

/** Where external plugins live, beside the engine's own state: `<TELAR_HOME>/plugins`. */
export function externalPluginsDir(engineRoot: string): string {
  return path.join(path.dirname(engineRoot), "plugins");
}

/** A refused plugin's listing: enough to name it, and nothing it could claim. */
function refusedMeta(id: string, name: string): PluginMeta {
  return { id, api: PLUGIN_API_VERSION, name, version: "?", toolPrefixes: [], readTools: [], eventKinds: [], settings: [] };
}

/** Every issue as one sentence: "tools.0.name: must start with …". */
function describe(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`).join("; ");
}

export function loadExternalPlugins(
  dir: string,
  reserved: { ids: ReadonlySet<string>; prefixes: ReadonlySet<string> },
): { loaded: LoadedExternalPlugin[]; refused: RefusedExternalPlugin[] } {
  const loaded: LoadedExternalPlugin[] = [];
  const refused: RefusedExternalPlugin[] = [];
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No folder yet is the normal case: nothing installed.
    return { loaded, refused };
  }
  const ids = new Set(reserved.ids);
  const prefixes = new Set(reserved.prefixes);
  for (const name of names) {
    const folder = path.join(dir, name);
    // A folder name that is not an id cannot be listed under itself; it is
    // listed under a safe stand-in so it is still visible.
    const listedAs = PluginId.safeParse(name).success
      ? name
      : `invalid-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 64);
    const refuse = (error: string, displayName?: string) => {
      refused.push({ dir: folder, meta: refusedMeta(listedAs, displayName ?? name), error: `${MANIFEST_FILE}: ${error}` });
    };

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(folder, MANIFEST_FILE), "utf8"));
    } catch (error) {
      refuse(error instanceof SyntaxError ? `not valid JSON (${error.message})` : "missing");
      continue;
    }
    const parsed = ExternalPluginManifest.safeParse(raw);
    if (!parsed.success) {
      const named = (raw as { name?: unknown } | null)?.name;
      refuse(describe(parsed.error), typeof named === "string" ? named : undefined);
      continue;
    }
    const manifest = parsed.data;
    if (manifest.id !== name) {
      refuse(`id "${manifest.id}" does not match its folder "${name}"`, manifest.name);
      continue;
    }
    if (ids.has(manifest.id)) {
      refuse(`id "${manifest.id}" is already taken`, manifest.name);
      continue;
    }
    if (manifest.toolPrefix && prefixes.has(manifest.toolPrefix)) {
      refuse(`tool prefix "${manifest.toolPrefix}" is already owned by another plugin`, manifest.name);
      continue;
    }
    const program = manifest.command[0]!;
    if (program.startsWith("./") && !fs.existsSync(path.join(folder, program))) {
      refuse(`command "${program}" is not in the plugin's folder`, manifest.name);
      continue;
    }
    ids.add(manifest.id);
    if (manifest.toolPrefix) prefixes.add(manifest.toolPrefix);
    loaded.push({ dir: folder, manifest });
  }
  return { loaded, refused };
}

/**
 * What the daemon and the out-of-process worker both load: the same folder,
 * the same reservations, so they agree on which plugins exist.
 */
export function loadInstalledPlugins(dir: string) {
  return loadExternalPlugins(dir, { ids: new Set(BUNDLED_PLUGIN_IDS), prefixes: new Set(BUNDLED_PLUGIN_TOOL_PREFIXES) });
}
