/**
 * INSTALLING AND REMOVING A PLUGIN FOLDER — `<TELAR_HOME>/plugins/<id>`.
 *
 *   copy   the folder is copied in; the source can then move or go away
 *   link   a symlink to the source, for a plugin being written: edits apply
 *          on the next start of its process, without reinstalling
 *
 * The manifest is checked BEFORE anything is written, with the same rules the
 * loader applies at start, so a folder that would be refused is never
 * installed. Removing deletes a copied folder and only UNLINKS a linked one —
 * the source is the owner's, never Telar's to delete.
 */
import fs from "node:fs";
import path from "node:path";
import { checkPluginFolder, type LoadedExternalPlugin, type Reservations } from "./manifest";

export type InstallMode = "copy" | "link";

export class PluginInstallError extends Error {}

export function installPluginFolder(pluginsDir: string, source: string, mode: InstallMode, reserved: Reservations): LoadedExternalPlugin {
  if (!path.isAbsolute(source)) throw new PluginInstallError("the folder must be an absolute path");
  const from = path.resolve(source);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(from).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDirectory) throw new PluginInstallError(`${from} is not a folder`);
  const checked = checkPluginFolder(from, undefined, reserved);
  if ("error" in checked) throw new PluginInstallError(checked.error);
  const { manifest } = checked;
  const target = path.join(pluginsDir, manifest.id);
  if (fs.existsSync(target) || isSymlink(target)) throw new PluginInstallError(`a plugin named "${manifest.id}" is already installed`);
  if (isInside(from, pluginsDir) || isInside(pluginsDir, from)) throw new PluginInstallError("the folder is inside Telar's plugins folder");
  fs.mkdirSync(pluginsDir, { recursive: true });
  if (mode === "link") {
    fs.symlinkSync(from, target, "dir");
  } else {
    // Into a staging name first, so a copy that fails half-way never looks installed.
    const staging = path.join(pluginsDir, `.installing-${manifest.id}-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      fs.cpSync(from, staging, { recursive: true, verbatimSymlinks: true });
      fs.renameSync(staging, target);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  return { dir: target, manifest };
}

/** Remove what `install` put there. Returns whether it was a link. */
export function removePluginFolder(pluginsDir: string, id: string): { linked: boolean } {
  const target = path.resolve(pluginsDir, id);
  if (path.dirname(target) !== path.resolve(pluginsDir) || id.startsWith(".")) throw new PluginInstallError(`"${id}" is not a plugin folder`);
  if (isSymlink(target)) {
    fs.unlinkSync(target);
    return { linked: true };
  }
  if (!fs.existsSync(target)) throw new PluginInstallError(`no plugin named "${id}" is installed`);
  fs.rmSync(target, { recursive: true, force: true });
  return { linked: false };
}

export function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
