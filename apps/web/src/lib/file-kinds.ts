/**
 * What a file is, from its name: glyph, tint, highlight language and viewer.
 * Exact filenames beat extensions. Tints are the language's identity colour and must
 * never be read as status. Free of React; `components/session/file-icon.tsx` draws the glyphs.
 */

/** The shape says roughly what kind of thing; the tint says which language. */
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

/** `--tint-*` tokens (globals.css) flip with the scheme and follow the theme. Identity, never state. */
const TINTS = {
  blue: "text-tint-blue",
  yellow: "text-tint-yellow",
  orange: "text-tint-orange",
  green: "text-tint-green",
  purple: "text-tint-purple",
  red: "text-tint-red",
  cyan: "text-tint-cyan",
  pink: "text-tint-pink",
  /** No particular language. */
  plain: "text-muted-foreground",
} as const;

export type FileKind = {
  label: string;
  glyph: FileGlyph;
  tint: string;
  /** The shiki language id; absent means do not highlight. */
  lang?: string;
  binary?: boolean;
  /**
   * `notebook` and `table` open only on projects with data science enabled; `pdf` is not gated.
   * Absent means the plain file view.
   */
  viewer?: "notebook" | "table" | "pdf";
  /** Which media element renders the bytes, served by the raw file route. */
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

/** Exact names first, lowercased. */
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
  // The files an agent reads first in a repository.
  "readme.md": KIND("README", "doc", "blue", "markdown"),
  "claude.md": KIND("Claude instructions", "doc", "orange", "markdown"),
  "agents.md": KIND("agent instructions", "doc", "green", "markdown"),
  license: KIND("licence", "doc", "plain"),
  "license.md": KIND("licence", "doc", "plain", "markdown"),
};

/** Then extensions, grouped by family. */
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
  tex: KIND("LaTeX", "doc", "green", "latex"),
  bib: KIND("BibTeX", "doc", "green", "bibtex"),
  sty: KIND("LaTeX package", "doc", "green", "latex"),
  cls: KIND("LaTeX class", "doc", "green", "latex"),
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
  // Bytes: most carry `media`, so the viewer renders them.
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

/** Nothing recognised. */
const UNKNOWN: FileKind = KIND("file", "plain", "plain");

/** The extension, lowercased, or "". A leading dot (`.gitignore`) is not an extension. */
export function fileExtension(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(path: string): FileKind {
  const name = (path.split("/").at(-1) ?? path).toLowerCase();
  return BY_NAME[name] ?? BY_EXTENSION[fileExtension(name)] ?? UNKNOWN;
}
