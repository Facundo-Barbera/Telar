// Stages 3 and 4 and extractIconHref are adapted from T3 Code under MIT; see LICENSE-t3code.txt.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ProjectIcon = {
  path: string;
  /** The realpath `path` was confined to; re-checked before every confirm and serve. */
  root: string;
  etag: string;
  contentType: string;
};

const EXPLICIT_CANDIDATES = [".telar/icon.svg", ".telar/icon.png", ".telar/icon.ico"] as const;

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

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "src/index.html",
  "app/root.tsx",
  "src/root.tsx",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
] as const;

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

const MAX_WORKSPACE_CHILDREN = 12;
const MAX_ICON_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_PROBES = 160;
const SNIFF_BYTES = 512;
const READ_CHUNK_BYTES = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// The extension is a claim; a file whose bytes match no image format is refused.
function sniffContentType(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && (head.subarray(0, 6).toString("latin1") === "GIF87a" || head.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.length >= 4 && head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) return "image/x-icon";
  if (/<svg[\s>]/i.test(head.toString("utf8"))) return "image/svg+xml";
  return undefined;
}

function etagFor(realPath: string, stats: { mtimeMs: number; size: number }): string {
  return crypto.createHash("sha256").update(`${realPath}:${stats.mtimeMs}:${stats.size}`).digest("hex").slice(0, 16);
}

function confined(real: string, confinedRoot: string): boolean {
  return real === confinedRoot || real.startsWith(confinedRoot + path.sep);
}

function statAcceptable(stats: fs.Stats): boolean {
  return stats.isFile() && stats.size > 0 && stats.size <= MAX_ICON_BYTES;
}

const LINK_ICON_HTML_RE = /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

// Object metadata is scanned per brace-free run: one unanchored pattern would be quadratic on large sources.
export function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}

// A root-relative href is a URL served from `public/`, so that is tried before the literal path.
export function candidatesForHref(href: string): string[] {
  const trimmed = href.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return [];
  const clean = trimmed.replace(/^\/+/, "");
  if (!clean || clean.split("/").includes("..")) return [];
  if (!CONTENT_TYPES[path.extname(clean).toLowerCase()]) return [];
  return [path.join("public", clean), clean];
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

/** Candidates in priority order: `.telar/icon.*`, well-known paths, a declared `<link rel="icon">`, then monorepo children. */
export async function findProjectIconAsync(root: string): Promise<ProjectIcon | undefined> {
  let confinedRoot: string;
  try {
    confinedRoot = await fs.promises.realpath(root);
  } catch {
    return undefined;
  }
  let probes = 0;
  const spend = (): boolean => ++probes <= MAX_PROBES;

  const accept = async (relative: string): Promise<ProjectIcon | undefined> => {
    if (!spend()) return undefined;
    try {
      const real = await fs.promises.realpath(path.join(confinedRoot, relative));
      const stats = await fs.promises.stat(real);
      if (!statAcceptable(stats) || !confined(real, confinedRoot)) return undefined;
      const contentType = sniffContentType(await readHead(real, Math.min(stats.size, SNIFF_BYTES)));
      return contentType ? { path: real, root: confinedRoot, etag: etagFor(real, stats), contentType } : undefined;
    } catch {
      return undefined;
    }
  };

  for (const relative of [...EXPLICIT_CANDIDATES, ...ROOT_CANDIDATES]) {
    const icon = await accept(relative);
    if (icon) return icon;
  }

  for (const source of ICON_SOURCE_FILES) {
    if (!spend()) return undefined;
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

/** One stat of a known icon. `undefined` means "resolve again", never "no icon". */
export async function confirmProjectIcon(icon: ProjectIcon): Promise<ProjectIcon | undefined> {
  const opened = await openConfined(icon);
  if (!opened) return undefined;
  const { handle, path: real } = opened;
  try {
    const stats = await handle.stat();
    if (!statAcceptable(stats)) return undefined;
    const etag = etagFor(real, stats);
    if (etag === icon.etag) return icon;
    const head = Buffer.alloc(Math.min(stats.size, SNIFF_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    const contentType = sniffContentType(head.subarray(0, bytesRead));
    if (!contentType) return undefined;
    return { ...icon, etag, contentType };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export async function readProjectIconBytes(icon: ProjectIcon): Promise<{ bytes: Buffer; contentType: string; etag: string } | undefined> {
  const opened = await openConfined(icon);
  if (!opened) return undefined;
  const { handle, path: real } = opened;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0 || before.size > MAX_ICON_BYTES) return undefined;
    const bytes = await readAllBounded(handle, before.size);
    if (!bytes) return undefined;
    // The etag is served immutable, so a file rewritten mid-read is refused rather than cached half-and-half.
    const after = await handle.stat();
    if (after.mtimeMs !== before.mtimeMs || after.size !== bytes.byteLength) return undefined;
    const contentType = sniffContentType(bytes.subarray(0, SNIFF_BYTES));
    if (!contentType) return undefined;
    return { bytes, contentType, etag: etagFor(real, after) };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

// Reads to EOF against a ceiling one byte past the limit, so growth after the stat is refused, never truncated.
async function readAllBounded(handle: fs.promises.FileHandle, expected: number): Promise<Buffer | undefined> {
  const ceiling = MAX_ICON_BYTES + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < ceiling) {
    const want = Math.min(total === 0 ? Math.max(expected, 1) : READ_CHUNK_BYTES, ceiling - total);
    const chunk = Buffer.alloc(want);
    const { bytesRead } = await handle.read(chunk, 0, want, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total === 0 || total > MAX_ICON_BYTES) return undefined;
  return Buffer.concat(chunks, total);
}

// O_NOFOLLOW guards the last component; re-resolving after the open and matching dev/ino catches a swapped parent.
async function openConfined(icon: ProjectIcon): Promise<{ handle: fs.promises.FileHandle; path: string } | undefined> {
  let real: string;
  try {
    real = await fs.promises.realpath(icon.path);
  } catch {
    return undefined;
  }
  if (real !== icon.path || !confined(real, icon.root)) return undefined;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const settled = await fs.promises.realpath(real);
    if (settled !== real || !confined(settled, icon.root)) {
      await handle.close();
      return undefined;
    }
    const [opened, named] = await Promise.all([handle.stat(), fs.promises.lstat(settled)]);
    if (opened.dev !== named.dev || opened.ino !== named.ino || !named.isFile()) {
      await handle.close();
      return undefined;
    }
    return { handle, path: settled };
  } catch {
    await handle.close();
    return undefined;
  }
}
