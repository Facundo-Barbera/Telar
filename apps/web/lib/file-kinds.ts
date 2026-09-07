/**
 * WHAT A FILE IS, FROM ITS NAME.
 *
 * One table, three readers: the Files tree draws its glyph and tint, the file
 * viewer asks which language to highlight, and a binary row explains itself as
 * "PNG image" rather than as "bytes".
 *
 * MODELLED ON t3 code's file browser, which resolves a coloured per-extension
 * icon and falls back to a generic one. Two of its decisions are worth copying
 * exactly:
 *
 *   - EXACT FILENAMES BEAT EXTENSIONS. `package.json` is not "a JSON file" to
 *     anybody who works in a repository, and neither is `tsconfig.json`,
 *     `Dockerfile` or `CLAUDE.md`. The name lookup runs first.
 *   - COLOUR IS IDENTITY, NOT STATE. A `.ts` file is not "info" and a `.rs` file
 *     is not "danger", so these tints deliberately do NOT come from the app's
 *     five-colour state vocabulary (globals.css) — they are the language's own
 *     colour, the way an editor shows it, and they must never be read as a
 *     status. That is the one place in this cockpit where a raw palette colour is
 *     the honest choice rather than a shortcut.
 *
 * THE GLYPH IS NAMED, NOT IMPORTED. This module stays free of React so it can be
 * tested as data; `components/session/file-icon.tsx` owns the drawing. The names
 * are a closed union, so a typo is a build error rather than a missing icon.
 */

/** The glyphs this table may ask for. Kept small on purpose: a tree of 40
 *  different shapes is noise, so the SHAPE says "roughly what kind of thing"
 *  and the TINT says which language. */
export type FileGlyph =
  | "code"
  | "braces"
  | "config"
  | "text"
  | "doc"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "lock"
  | "terminal"
  | "database"
  | "style"
  | "package"
  | "container"
  | "git"
  | "binary"
  | "table"
  | "plain";

/**
 * The tints, one token each.
 *
 * THESE USED TO BE RAW TAILWIND PAIRS — `text-sky-600 dark:text-sky-400` — and
 * a raw ramp is a fixed sRGB value, so it could not follow a theme: every file
 * icon in the panel stayed the same eight stock colours whether the canvas was
 * Telar's grey, Ember's warm sand or something a reader built. It also had to
 * restate itself in two halves, because a 400 that reads on the dark canvas is
 * washed out on the light one.
 *
 * `--tint-*` (globals.css) is that pair as one token: it flips with the scheme
 * on its own, so a call site names the FAMILY and nothing else, and a theme can
 * move it. Identity, never state — see the note beside the tokens for the law
 * these live under, which is the one file-kinds already set out.
 */
const TINTS = {
  blue: "text-tint-blue",
  yellow: "text-tint-yellow",
  orange: "text-tint-orange",
  green: "text-tint-green",
  purple: "text-tint-purple",
  red: "text-tint-red",
  cyan: "text-tint-cyan",
  pink: "text-tint-pink",
  /** The default. A token rather than a palette colour, because "no particular
   *  language" is exactly what the panel's muted foreground already means. */
  plain: "text-muted-foreground",
} as const;

export type FileKind = {
  /** What to call it in a sentence — "PNG image", "TypeScript". */
  label: string;
  glyph: FileGlyph;
  tint: string;
  /**
   * The shiki language id, when there is one. Absent means "do not highlight":
   * either the format has no grammar worth loading, or it is not text at all.
   */
  lang?: string;
  /** Bytes rather than text. The viewer says so instead of trying to read it. */
  binary?: boolean;
  /**
   * A surface other than the text editor. `notebook` opens an .ipynb as cells
   * in the session's kernel; `table` opens a CSV or Parquet as a grid — both
   * only on a project that opted into data science. `pdf` opens the browser's
   * own paged viewer and is NOT gated: a PDF is a document, not an analysis,
   * and other features (compiled LaTeX output, a downloaded paper) route
   * through this same kind. Absent means the plain file view.
   */
  viewer?: "notebook" | "table" | "pdf";
  /**
   * Bytes the file view can RENDER rather than merely name. `binary` alone
   * means "no text to show"; this says which media element shows the content
   * instead — an <img>, the browser's own PDF viewer in an <iframe>, an
   * <audio> or <video> control. The bytes come from the raw file route, which
   * exists precisely because the text route withholds them.
   */
  media?: "image" | "pdf" | "audio" | "video";
};

const KIND = (
  label: string,
  glyph: FileGlyph,
  tint: keyof typeof TINTS,
  lang?: string,
  binary?: boolean,
  viewer?: FileKind["viewer"],
  media?: FileKind["media"],
): FileKind => ({
  label,
  glyph,
  tint: TINTS[tint],
  ...(lang ? { lang } : {}),
  ...(binary ? { binary: true } : {}),
  ...(viewer ? { viewer } : {}),
  ...(media ? { media } : {}),
});

/**
 * EXACT NAMES FIRST, lowercased. The ones a repository actually has, not an
 * inventory: each of these is a file somebody looks for by name.
 */
const BY_NAME: Record<string, FileKind> = {
  "package.json": KIND("npm manifest", "package", "red", "json"),
  "package-lock.json": KIND("npm lockfile", "lock", "red", "json"),
  "bun.lock": KIND("Bun lockfile", "lock", "plain", "json"),
  "bun.lockb": KIND("Bun lockfile", "lock", "plain", undefined, true),
  "yarn.lock": KIND("Yarn lockfile", "lock", "cyan"),
  "pnpm-lock.yaml": KIND("pnpm lockfile", "lock", "yellow", "yaml"),
  "cargo.lock": KIND("Cargo lockfile", "lock", "orange", "toml"),
  "cargo.toml": KIND("Cargo manifest", "package", "orange", "toml"),
  "go.mod": KIND("Go module", "package", "cyan"),
  "go.sum": KIND("Go checksums", "lock", "cyan"),
  "tsconfig.json": KIND("TypeScript config", "config", "blue", "jsonc"),
  "dockerfile": KIND("Dockerfile", "container", "blue", "dockerfile"),
  "docker-compose.yml": KIND("Compose file", "container", "blue", "yaml"),
  "docker-compose.yaml": KIND("Compose file", "container", "blue", "yaml"),
  makefile: KIND("Makefile", "terminal", "green", "make"),
  ".gitignore": KIND("git ignore rules", "git", "orange"),
  ".gitattributes": KIND("git attributes", "git", "orange"),
  ".gitmodules": KIND("git submodules", "git", "orange", "ini"),
  ".env": KIND("environment file", "lock", "yellow", "ini"),
  ".env.example": KIND("environment template", "config", "yellow", "ini"),
  // The three files an agent reads first in this repository. Named because a
  // reader scanning a tree for instructions is scanning for these.
  "readme.md": KIND("README", "doc", "blue", "markdown"),
  "claude.md": KIND("Claude instructions", "doc", "orange", "markdown"),
  "agents.md": KIND("agent instructions", "doc", "green", "markdown"),
  license: KIND("licence", "doc", "plain"),
  "license.md": KIND("licence", "doc", "plain", "markdown"),
};

/**
 * THEN EXTENSIONS. Ordered by family so a reader can see the grouping, and each
 * one names a shiki grammar where highlighting it is worth a chunk download.
 */
const BY_EXTENSION: Record<string, FileKind> = {
  // TypeScript and JavaScript.
  ts: KIND("TypeScript", "code", "blue", "typescript"),
  tsx: KIND("TypeScript JSX", "code", "blue", "tsx"),
  mts: KIND("TypeScript", "code", "blue", "typescript"),
  cts: KIND("TypeScript", "code", "blue", "typescript"),
  js: KIND("JavaScript", "code", "yellow", "javascript"),
  jsx: KIND("JavaScript JSX", "code", "yellow", "jsx"),
  mjs: KIND("JavaScript", "code", "yellow", "javascript"),
  cjs: KIND("JavaScript", "code", "yellow", "javascript"),
  // Data and config.
  json: KIND("JSON", "braces", "yellow", "json"),
  jsonc: KIND("JSON with comments", "braces", "yellow", "jsonc"),
  json5: KIND("JSON5", "braces", "yellow", "json5"),
  yaml: KIND("YAML", "config", "red", "yaml"),
  yml: KIND("YAML", "config", "red", "yaml"),
  toml: KIND("TOML", "config", "orange", "toml"),
  ini: KIND("INI", "config", "plain", "ini"),
  cfg: KIND("config", "config", "plain", "ini"),
  conf: KIND("config", "config", "plain", "ini"),
  env: KIND("environment file", "lock", "yellow", "ini"),
  // Markup and prose.
  md: KIND("Markdown", "doc", "blue", "markdown"),
  mdx: KIND("MDX", "doc", "blue", "mdx"),
  txt: KIND("plain text", "text", "plain"),
  html: KIND("HTML", "code", "orange", "html"),
  htm: KIND("HTML", "code", "orange", "html"),
  xml: KIND("XML", "code", "orange", "xml"),
  svg: KIND("SVG image", "image", "purple", "xml"),
  csv: KIND("CSV", "table", "green", "csv", false, "table"),
  tsv: KIND("TSV", "table", "green", undefined, false, "table"),
  parquet: KIND("Parquet", "table", "green", undefined, true, "table"),
  ipynb: KIND("Jupyter notebook", "code", "orange", "json", false, "notebook"),
  // Styles.
  css: KIND("CSS", "style", "blue", "css"),
  scss: KIND("Sass", "style", "pink", "scss"),
  sass: KIND("Sass", "style", "pink", "sass"),
  less: KIND("Less", "style", "blue", "less"),
  // Shells and scripts.
  sh: KIND("shell script", "terminal", "green", "shellscript"),
  bash: KIND("shell script", "terminal", "green", "shellscript"),
  zsh: KIND("shell script", "terminal", "green", "shellscript"),
  fish: KIND("shell script", "terminal", "green", "fish"),
  ps1: KIND("PowerShell", "terminal", "blue", "powershell"),
  bat: KIND("batch file", "terminal", "plain", "bat"),
  // Other languages, alphabetically.
  c: KIND("C", "code", "blue", "c"),
  h: KIND("C header", "code", "purple", "c"),
  cc: KIND("C++", "code", "blue", "cpp"),
  cpp: KIND("C++", "code", "blue", "cpp"),
  hpp: KIND("C++ header", "code", "purple", "cpp"),
  cs: KIND("C#", "code", "purple", "csharp"),
  dart: KIND("Dart", "code", "cyan", "dart"),
  ex: KIND("Elixir", "code", "purple", "elixir"),
  exs: KIND("Elixir script", "code", "purple", "elixir"),
  go: KIND("Go", "code", "cyan", "go"),
  gleam: KIND("Gleam", "code", "pink", "gleam"),
  hs: KIND("Haskell", "code", "purple", "haskell"),
  java: KIND("Java", "code", "red", "java"),
  kt: KIND("Kotlin", "code", "purple", "kotlin"),
  lua: KIND("Lua", "code", "blue", "lua"),
  nix: KIND("Nix", "code", "blue", "nix"),
  php: KIND("PHP", "code", "purple", "php"),
  pl: KIND("Perl", "code", "blue", "perl"),
  py: KIND("Python", "code", "yellow", "python"),
  r: KIND("R", "code", "blue", "r"),
  rb: KIND("Ruby", "code", "red", "ruby"),
  rs: KIND("Rust", "code", "orange", "rust"),
  scala: KIND("Scala", "code", "red", "scala"),
  sql: KIND("SQL", "database", "cyan", "sql"),
  swift: KIND("Swift", "code", "orange", "swift"),
  vue: KIND("Vue component", "code", "green", "vue"),
  svelte: KIND("Svelte component", "code", "orange", "svelte"),
  zig: KIND("Zig", "code", "orange", "zig"),
  // Schemas and infrastructure.
  graphql: KIND("GraphQL", "braces", "pink", "graphql"),
  gql: KIND("GraphQL", "braces", "pink", "graphql"),
  prisma: KIND("Prisma schema", "database", "cyan", "prisma"),
  proto: KIND("Protocol Buffers", "braces", "blue", "protobuf"),
  tf: KIND("Terraform", "config", "purple", "terraform"),
  hcl: KIND("HCL", "config", "purple", "hcl"),
  patch: KIND("patch", "git", "green", "diff"),
  diff: KIND("diff", "git", "green", "diff"),
  // Bytes. `lang` absent AND `binary` set — but most of these carry `media`,
  // so the viewer renders the content instead of apologising for it.
  png: KIND("PNG image", "image", "purple", undefined, true, undefined, "image"),
  jpg: KIND("JPEG image", "image", "purple", undefined, true, undefined, "image"),
  jpeg: KIND("JPEG image", "image", "purple", undefined, true, undefined, "image"),
  gif: KIND("GIF image", "image", "purple", undefined, true, undefined, "image"),
  webp: KIND("WebP image", "image", "purple", undefined, true, undefined, "image"),
  avif: KIND("AVIF image", "image", "purple", undefined, true, undefined, "image"),
  ico: KIND("icon", "image", "purple", undefined, true, undefined, "image"),
  icns: KIND("icon", "image", "purple", undefined, true),
  pdf: KIND("PDF", "doc", "red", undefined, true, "pdf", "pdf"),
  woff: KIND("font", "binary", "plain", undefined, true),
  woff2: KIND("font", "binary", "plain", undefined, true),
  ttf: KIND("font", "binary", "plain", undefined, true),
  otf: KIND("font", "binary", "plain", undefined, true),
  mp3: KIND("audio", "audio", "pink", undefined, true, undefined, "audio"),
  wav: KIND("audio", "audio", "pink", undefined, true, undefined, "audio"),
  mp4: KIND("video", "video", "pink", undefined, true, undefined, "video"),
  mov: KIND("video", "video", "pink", undefined, true, undefined, "video"),
  webm: KIND("video", "video", "pink", undefined, true, undefined, "video"),
  zip: KIND("archive", "archive", "yellow", undefined, true),
  gz: KIND("archive", "archive", "yellow", undefined, true),
  tgz: KIND("archive", "archive", "yellow", undefined, true),
  tar: KIND("archive", "archive", "yellow", undefined, true),
  wasm: KIND("WebAssembly", "binary", "purple", undefined, true),
  so: KIND("shared library", "binary", "plain", undefined, true),
  dylib: KIND("shared library", "binary", "plain", undefined, true),
};

/** Nothing recognised. A file is still a file, and the tree says so rather than
 *  guessing at a language it might be. */
const UNKNOWN: FileKind = KIND("file", "plain", "plain");

/**
 * The extension, lowercased, or "".
 *
 * A LEADING DOT IS NOT AN EXTENSION: `.gitignore` is a whole name, and treating
 * `gitignore` as its type is how a dotfile ends up labelled as a language. Only
 * a dot with something before it counts.
 */
export function fileExtension(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(path: string): FileKind {
  const name = (path.split("/").at(-1) ?? path).toLowerCase();
  return BY_NAME[name] ?? BY_EXTENSION[fileExtension(name)] ?? UNKNOWN;
}
