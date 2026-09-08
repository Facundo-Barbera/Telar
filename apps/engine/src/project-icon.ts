/**
 * A project's own icon, found in its checkout.
 *
 * A CANDIDATE LIST, NOT A SEARCH. Walking a repository looking for anything
 * icon-shaped would read thousands of entries to maybe find a PNG, and would
 * happily pick a test fixture. The places projects actually keep their icon
 * are few and conventional, so this is a bounded number of `stat` calls in a
 * stated order — `.telar/icon.*` first, because an explicit choice beats every
 * convention below it.
 *
 * FOUR STAGES, IN PRIORITY ORDER, and a hit in an earlier one ends the search:
 *
 *   1. `.telar/icon.*`       — the project SAID which file. Nothing outranks it.
 *   2. well-known paths      — `favicon.ico`, `public/`, `app/`, `src/app/`, …
 *   3. a declared `<link rel="icon">` — the href an `index.html` or a router
 *                              root file points at. This is what makes a plain
 *                              Vite app work: its icon is `public/vite.svg`,
 *                              a name no candidate list would ever guess.
 *   4. monorepo children     — `apps/<child>/…`, `packages/<child>/…`, in
 *                              alphabetical order, for the very common repo
 *                              whose root holds no app at all.
 *
 * The etag is content-derived (resolved path + mtime + size), so a replaced
 * file gets a new URL and the client's immutable cache stays honest.
 *
 * ------------------------------------------------------------------------
 * Stages 3 and 4 and the shape of the cache this feeds (see `state.ts`) are
 * adapted from T3 Code's `ProjectFaviconResolver`
 * (https://github.com/pingdotgg/t3code, revision 2120fbc1,
 * `apps/server/src/project/ProjectFaviconResolver.ts`). The two icon-href
 * regexes below are ported near-verbatim, including the reason the object-
 * metadata form is matched by scanning brace-free runs rather than by one
 * unanchored pattern.
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *   and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 *   THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 *   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 * ------------------------------------------------------------------------
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

/**
 * The project's own answer. Checked before every convention below, because a
 * repository that ships `.telar/icon.png` has already said which file it means
 * and a `favicon.ico` meant for its website must not outvote it.
 */
const EXPLICIT_CANDIDATES = [".telar/icon.svg", ".telar/icon.png", ".telar/icon.ico"] as const;

/**
 * Well-known locations, in preference order. An entry earlier in the list wins
 * outright.
 *
 * SVG BEFORE RASTER at each level: it is the one that scales to whatever size
 * the sidebar row asks for. Within a level, the more specific location wins —
 * `app/icon.png` is a Next app icon and says more than a bare `icon.png`.
 */
const ROOT_CANDIDATES = [
  "icon.svg",
  "icon.png",
  "logo.svg",
  "logo.png",
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "apple-touch-icon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/icon.svg",
  "public/icon.png",
  "public/logo.svg",
  "public/logo.png",
  "public/apple-touch-icon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/apple-icon.png",
  "src/favicon.svg",
  "src/favicon.ico",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/apple-icon.png",
  "src/assets/logo.svg",
  "src/assets/logo.png",
  "build/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "resources/icon.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  ".idea/icon.svg",
] as const;

/**
 * Files that may DECLARE an icon the list above cannot guess.
 *
 * This is the stage that fixes the single most common miss: a Vite app's icon
 * is whatever `index.html` names — `/vite.svg`, `/logo.svg`, `/brand/mark.png`
 * — and no candidate list reaches it.
 */
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "src/index.html",
  "app/root.tsx",
  "src/root.tsx",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
] as const;

/**
 * Where a monorepo keeps the app whose icon stands for the whole repository.
 *
 * A REPOSITORY ROOT OFTEN HOLDS NO APP AT ALL — Telar's own does not — and
 * every stage above it then finds nothing. Children are visited in
 * ALPHABETICAL order so the answer is the same on every machine, and both the
 * number of children and the candidates inside each are capped: this is still
 * a candidate list, not a walk.
 */
const WORKSPACE_DIRS = ["apps", "packages"] as const;
const WORKSPACE_CANDIDATES = [
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/icon.svg",
  "public/icon.png",
  "app/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "icon.svg",
  "icon.png",
] as const;

/** Children per workspace directory. Twelve covers a real monorepo; a
 *  directory with hundreds of packages is not going to answer this question
 *  and must not be allowed to turn a sidebar poll into a directory walk. */
const MAX_WORKSPACE_CHILDREN = 12;

/** Anything bigger is not an icon — it is a screenshot somebody misnamed, and
 *  the sidebar would download it once per session row. */
const MAX_ICON_BYTES = 1024 * 1024;

/** How much of a source file is read looking for a `<link rel="icon">`. The
 *  declaration is in the document head; a generated 4 MB HTML bundle must not
 *  be slurped to prove it has none. */
const MAX_SOURCE_BYTES = 128 * 1024;

/** A hard ceiling on filesystem probes for one resolution, counted across all
 *  four stages. A miss costs at most this many `stat`s no matter how the
 *  checkout is laid out. */
const MAX_PROBES = 160;

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * What the first bytes actually are, ignoring what the file is called.
 *
 * THE EXTENSION IS A CLAIM, NOT A FACT. A checkout may hold a `favicon.ico`
 * that is really an HTML error page a proxy saved, or an `icon.svg` symlinked
 * at a PNG. The daemon serves these bytes with a content type; declaring one
 * from the name alone is how a browser gets handed a broken image and the
 * fallback avatar never gets its chance. A file whose bytes match no image
 * format is REFUSED, and the search moves to the next candidate.
 */
function sniffContentType(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && (head.subarray(0, 6).toString("latin1") === "GIF87a" || head.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  // ICO and CUR share a header; only the icon type is served.
  if (head.length >= 4 && head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) return "image/x-icon";
  // SVG is text. A leading BOM, XML declaration, comment or doctype may precede
  // the root element, so this looks for the element rather than at offset zero.
  const text = head.toString("utf8");
  if (/<svg[\s>]/i.test(text)) return "image/svg+xml";
  return undefined;
}

/** The bounded head of a file, for sniffing. Separate from the size check
 *  because the size is already known by then — this is one small read of the
 *  winner, not of every candidate. */
const SNIFF_BYTES = 512;

function etagFor(realPath: string, stats: { mtimeMs: number; size: number }): string {
  return crypto.createHash("sha256").update(`${realPath}:${stats.mtimeMs}:${stats.size}`).digest("hex").slice(0, 16);
}

/** Whether a resolved path is still inside the checkout.
 *
 *  A symlink pointing OUTSIDE the checkout is refused, not followed: the icon
 *  route serves these bytes to any client, and a project must not be able to
 *  publish /etc/hosts by symlinking favicon.ico at it. */
function confined(real: string, confinedRoot: string): boolean {
  return real === confinedRoot || real.startsWith(confinedRoot + path.sep);
}

/** The size/shape judgements that need no IO beyond the stat already taken. */
function statAcceptable(stats: fs.Stats): boolean {
  return stats.isFile() && stats.size > 0 && stats.size <= MAX_ICON_BYTES;
}

/**
 * The href a source file declares, or null.
 *
 * Matches `<link ...>` tags or object-like icon metadata where rel/href can
 * appear in any order. The tag pattern is anchored on `<link`, so it only
 * starts at real candidates. Object metadata is matched by scanning brace-free
 * runs instead of by one combined pattern: an unanchored pattern restarts at
 * every offset and rescans forward, which is quadratic on large sources.
 *
 * Ported from T3 Code's `ProjectFaviconResolver` — see the file header.
 */
const LINK_ICON_HTML_RE = /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

export function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  // Icon metadata counts when `rel` and `href` share a brace-free run, so a run
  // holding `rel` but no href falls through to the next one rather than ending
  // the search.
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}

/**
 * Where a declared href could live on disk, relative to the checkout.
 *
 * A ROOT-RELATIVE HREF IS A URL, NOT A PATH: `/vite.svg` is served from
 * `public/vite.svg` in every framework that reads these files, so `public/`
 * is tried first and the literal path second (Vite's own `index.html` sits
 * beside a `public/`, a CRA-style one may not). An absolute or escaping href
 * is dropped rather than resolved — `..` in a URL is not a request to leave
 * the checkout.
 */
export function candidatesForHref(href: string): string[] {
  const trimmed = href.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return []; // http:, data:, file:…
  const clean = trimmed.replace(/^\/+/, "");
  if (!clean || clean.split("/").includes("..")) return [];
  if (!CONTENT_TYPES[path.extname(clean).toLowerCase()]) return [];
  return [path.join("public", clean), clean];
}

/** One resolution's bounded probe budget, shared across stages. */
class Budget {
  private spent = 0;
  spend(): boolean {
    this.spent += 1;
    return this.spent <= MAX_PROBES;
  }
}

/* -------------------------------------------------------------------------
 * The two drivers.
 *
 * WHY BOTH, AND WHY THEY ARE NOT ONE GENERIC FUNCTION. `state.ts` resolves an
 * icon from a synchronous store method and from an off-request async refresh;
 * a promise-returning-or-not abstraction over `fs` costs more to read than the
 * two loops it saves. What IS shared is every judgement — ordering, the size
 * and confinement refusals, sniffing, the etag — so the two drivers differ
 * only in which `fs` calls they make and must not be able to disagree about
 * what an icon is.
 * ------------------------------------------------------------------------- */

export function findProjectIcon(root: string): ProjectIcon | undefined {
  let confinedRoot: string;
  try {
    confinedRoot = fs.realpathSync.native(root);
  } catch {
    return undefined;
  }
  const budget = new Budget();

  const accept = (relative: string): ProjectIcon | undefined => {
    if (!budget.spend()) return undefined;
    let real: string;
    let stats: fs.Stats;
    try {
      real = fs.realpathSync.native(path.join(confinedRoot, relative));
      stats = fs.statSync(real);
    } catch {
      return undefined;
    }
    if (!statAcceptable(stats) || !confined(real, confinedRoot)) return undefined;
    let head: Buffer;
    try {
      head = readHeadSync(real, Math.min(stats.size, SNIFF_BYTES));
    } catch {
      return undefined;
    }
    const contentType = sniffContentType(head);
    if (!contentType) return undefined;
    return { path: real, etag: etagFor(real, stats), contentType };
  };

  for (const relative of [...EXPLICIT_CANDIDATES, ...ROOT_CANDIDATES]) {
    const icon = accept(relative);
    if (icon) return icon;
  }

  for (const source of ICON_SOURCE_FILES) {
    if (!budget.spend()) return undefined;
    let text: string;
    try {
      const absolute = path.join(confinedRoot, source);
      const real = fs.realpathSync.native(absolute);
      if (!confined(real, confinedRoot)) continue;
      const stats = fs.statSync(real);
      if (!stats.isFile()) continue;
      text = readHeadSync(real, Math.min(stats.size, MAX_SOURCE_BYTES)).toString("utf8");
    } catch {
      continue;
    }
    const href = extractIconHref(text);
    if (!href) continue;
    for (const relative of candidatesForHref(href)) {
      const icon = accept(relative);
      if (icon) return icon;
    }
  }

  for (const workspace of WORKSPACE_DIRS) {
    let children: string[];
    try {
      children = fs.readdirSync(path.join(confinedRoot, workspace), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const child of children.sort().slice(0, MAX_WORKSPACE_CHILDREN)) {
      for (const relative of WORKSPACE_CANDIDATES) {
        const icon = accept(path.join(workspace, child, relative));
        if (icon) return icon;
      }
    }
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
  const budget = new Budget();

  const accept = async (relative: string): Promise<ProjectIcon | undefined> => {
    if (!budget.spend()) return undefined;
    let real: string;
    let stats: fs.Stats;
    try {
      real = await fs.promises.realpath(path.join(confinedRoot, relative));
      stats = await fs.promises.stat(real);
    } catch {
      return undefined;
    }
    if (!statAcceptable(stats) || !confined(real, confinedRoot)) return undefined;
    let head: Buffer;
    try {
      head = await readHead(real, Math.min(stats.size, SNIFF_BYTES));
    } catch {
      return undefined;
    }
    const contentType = sniffContentType(head);
    if (!contentType) return undefined;
    return { path: real, etag: etagFor(real, stats), contentType };
  };

  for (const relative of [...EXPLICIT_CANDIDATES, ...ROOT_CANDIDATES]) {
    const icon = await accept(relative);
    if (icon) return icon;
  }

  for (const source of ICON_SOURCE_FILES) {
    if (!budget.spend()) return undefined;
    let text: string;
    try {
      const real = await fs.promises.realpath(path.join(confinedRoot, source));
      if (!confined(real, confinedRoot)) continue;
      const stats = await fs.promises.stat(real);
      if (!stats.isFile()) continue;
      text = (await readHead(real, Math.min(stats.size, MAX_SOURCE_BYTES))).toString("utf8");
    } catch {
      continue;
    }
    const href = extractIconHref(text);
    if (!href) continue;
    for (const relative of candidatesForHref(href)) {
      const icon = await accept(relative);
      if (icon) return icon;
    }
  }

  for (const workspace of WORKSPACE_DIRS) {
    let children: string[];
    try {
      const entries = await fs.promises.readdir(path.join(confinedRoot, workspace), { withFileTypes: true });
      children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const child of children.sort().slice(0, MAX_WORKSPACE_CHILDREN)) {
      for (const relative of WORKSPACE_CANDIDATES) {
        const icon = await accept(path.join(workspace, child, relative));
        if (icon) return icon;
      }
    }
  }
  return undefined;
}

/**
 * Re-read a KNOWN icon's file, cheaply.
 *
 * THE CONFIRMATION A CACHE NEEDS. A cached answer names a path; one `stat`
 * says whether that file is still there and, because the etag is derived from
 * mtime and size, whether it CHANGED — so a designer replacing `icon.png`
 * shows up on the next poll instead of at the end of a TTL, and a deleted one
 * falls back at once instead of leaving the serve route reading a path that no
 * longer exists. `undefined` means "ask again properly", never "no icon".
 */
export async function confirmProjectIcon(icon: ProjectIcon): Promise<ProjectIcon | undefined> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(icon.path);
  } catch {
    return undefined;
  }
  if (!statAcceptable(stats)) return undefined;
  const etag = etagFor(icon.path, stats);
  return etag === icon.etag ? icon : { ...icon, etag };
}

export function confirmProjectIconSync(icon: ProjectIcon): ProjectIcon | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(icon.path);
  } catch {
    return undefined;
  }
  if (!statAcceptable(stats)) return undefined;
  const etag = etagFor(icon.path, stats);
  return etag === icon.etag ? icon : { ...icon, etag };
}

/* --- the one primitive both drivers need that `fs` does not offer directly --- */

/** The first `length` bytes of a file. `length` is the CALLER's bound — the
 *  sniffer wants a few hundred bytes, a source-file scan wants the head of the
 *  document — so nothing here re-clamps it. */
function readHeadSync(file: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const handle = fs.openSync(file, "r");
  try {
    const read = fs.readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}

async function readHead(file: string, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const handle = await fs.promises.open(file, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
