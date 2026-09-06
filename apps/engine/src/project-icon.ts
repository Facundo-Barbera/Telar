/**
 * A project's own icon, found in its checkout.
 *
 * A CANDIDATE LIST, NOT A SEARCH. Walking a repository looking for anything
 * icon-shaped would read thousands of entries to maybe find a PNG, and would
 * happily pick a test fixture. The places projects actually keep their icon
 * are few and conventional, so this is ~a dozen `stat` calls in a stated
 * order — `.telar/icon.*` first, because an explicit choice beats every
 * convention below it.
 *
 * The etag is content-derived (path + mtime + size), so a replaced file gets
 * a new URL and the client's immutable cache stays honest.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ProjectIcon = {
  /** Absolute path, already realpath-confined under the project root. */
  path: string;
  /** Opaque cache key; changes whenever the file does. */
  etag: string;
  contentType: string;
};

/** In preference order. An entry earlier in the list wins outright. */
const CANDIDATES = [
  ".telar/icon.svg",
  ".telar/icon.png",
  "icon.svg",
  "icon.png",
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "apple-touch-icon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/icon.png",
  "public/apple-touch-icon.png",
  "app/favicon.ico",
  "app/icon.png",
  "app/apple-icon.png",
  "src/app/favicon.ico",
  "src/app/icon.png",
  "build/icon.png",
  "assets/icon.png",
  "resources/icon.png",
  "static/favicon.ico",
] as const;

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Anything bigger is not an icon — it is a screenshot somebody misnamed, and
 *  the sidebar would download it once per session row. */
const MAX_ICON_BYTES = 1024 * 1024;

export function findProjectIcon(root: string): ProjectIcon | undefined {
  let confinedRoot: string;
  try {
    confinedRoot = fs.realpathSync.native(root);
  } catch {
    return undefined;
  }
  for (const candidate of CANDIDATES) {
    const absolute = path.join(confinedRoot, candidate);
    let stats: fs.Stats;
    let real: string;
    try {
      real = fs.realpathSync.native(absolute);
      stats = fs.statSync(real);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_ICON_BYTES) continue;
    // A symlink pointing OUTSIDE the checkout is refused, not followed: the
    // icon route serves these bytes to any client, and a project must not be
    // able to publish /etc/hosts by symlinking favicon.ico at it.
    if (real !== confinedRoot && !real.startsWith(confinedRoot + path.sep)) continue;
    const contentType = CONTENT_TYPES[path.extname(candidate)];
    if (!contentType) continue;
    return {
      path: real,
      etag: crypto.createHash("sha256").update(`${candidate}:${stats.mtimeMs}:${stats.size}`).digest("hex").slice(0, 16),
      contentType,
    };
  }
  return undefined;
}

export async function findProjectIconAsync(root: string): Promise<ProjectIcon | undefined> {
  let confinedRoot: string;
  try {
    confinedRoot = await fs.promises.realpath(root);
  } catch {
    return undefined;
  }
  for (const candidate of CANDIDATES) {
    const absolute = path.join(confinedRoot, candidate);
    let stats: fs.Stats;
    let real: string;
    try {
      real = await fs.promises.realpath(absolute);
      stats = await fs.promises.stat(real);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_ICON_BYTES) continue;
    // A symlink pointing OUTSIDE the checkout is refused, not followed: the
    // icon route serves these bytes to any client, and a project must not be
    // able to publish /etc/hosts by symlinking favicon.ico at it.
    if (real !== confinedRoot && !real.startsWith(confinedRoot + path.sep)) continue;
    const contentType = CONTENT_TYPES[path.extname(candidate)];
    if (!contentType) continue;
    return {
      path: real,
      etag: crypto.createHash("sha256").update(`${candidate}:${stats.mtimeMs}:${stats.size}`).digest("hex").slice(0, 16),
      contentType,
    };
  }
  return undefined;
}
