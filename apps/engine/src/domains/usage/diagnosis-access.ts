import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { UsageDiagnosisTool } from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel";

const SECRET_PATTERNS = [
  /(^|\/)provider-secrets\.json$/,
  /(^|\/)usage-limit-secrets\.json$/,
  /(^|\/)mcp-oauth(-pending)?\.json$/,
  /(^|\/)[a-z-]*-mcp-secret\.json$/,
  /(^|\/)engine\.json$/,
  /(^|\/)engine\.lock$/,
  /(^|\/)remote\.json$/,
  /(^|\/)hosts\.json$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)auth\.json$/,
  /(^|\/)browser-profiles(\/|$)/,
  /(^|\/)adopted(\/|$)/,
  /secret|token|credential|password|\.pem$|\.key$|\.p12$/i,
];

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 60_000;
const MAX_MATCHES = 200;
const MAX_FILES = 500;
const MAX_GREP_FILE_BYTES = 5_000_000;
const MAX_SQL_ROWS = 200;
const MAX_CELL_CHARS = 2000;

function isSecretPath(relative: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(slashed(relative)));
}

const isDatabase = (relative: string): boolean => /(^|\/)execution\.sqlite(-wal|-shm)?$/.test(slashed(relative));

function refuse(message: string): never {
  throw new EngineStateError("invalid_request", message);
}

function inside(realRoot: string, requested: unknown): { full: string; relative: string } {
  const raw = typeof requested === "string" && requested.trim() ? requested.trim() : ".";
  const candidate = path.resolve(realRoot, raw);
  let full: string;
  try {
    full = fs.realpathSync(candidate);
  } catch {
    refuse(`${raw} does not exist`);
  }
  const relative = path.relative(realRoot, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) refuse("only the engine's data folder can be read");
  if (isSecretPath(relative)) refuse(`${relative} holds secrets and cannot be read`);
  return { full, relative: relative || "." };
}

function walk(root: string, start: string, visit: (full: string, relative: string, size: number) => boolean): void {
  const stack = [start];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (isSecretPath(relative) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && !visit(full, relative, fs.statSync(full).size)) return;
    }
  }
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += pattern[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") source += "(?:";
    else if (char === "}") source += ")";
    else if (char === ",") source += "|";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const slashed = (relative: string): string => relative.split(path.sep).join("/");

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at ${MAX_OUTPUT_CHARS} characters]` : text;
}

function readFile(root: string, args: Record<string, unknown>): string {
  const { full, relative } = inside(root, args.path);
  if (fs.statSync(full).isDirectory()) {
    return fs.readdirSync(full, { withFileTypes: true }).filter((entry) => !isSecretPath(path.join(relative, entry.name))).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n");
  }
  if (isDatabase(relative)) refuse("query the database with the sql tool instead");
  const buffer = fs.readFileSync(full);
  if (buffer.includes(0)) refuse(`${relative} is binary`);
  const lines = buffer.toString("utf8").split("\n");
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(args.limit) || MAX_READ_LINES));
  const shown = lines.slice(offset, offset + limit).map((line, index) => `${offset + index + 1}\t${line}`);
  const rest = lines.length - offset - shown.length;
  return clip(shown.join("\n") + (rest > 0 ? `\n[${rest} more lines; pass offset ${offset + shown.length}]` : ""));
}

function globFiles(root: string, args: Record<string, unknown>): string {
  const { full } = inside(root, args.path);
  const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern : "**/*";
  const matcher = globRegex(pattern);
  const found: string[] = [];
  walk(root, full, (file, relative, size) => {
    if (matcher.test(slashed(path.relative(full, file)))) found.push(`${slashed(relative)}\t${size}`);
    return found.length < MAX_FILES;
  });
  return found.length ? found.sort().join("\n") : "no files matched";
}

function grepFiles(root: string, args: Record<string, unknown>): string {
  const { full } = inside(root, args.path);
  if (typeof args.pattern !== "string" || !args.pattern) refuse("grep needs a pattern");
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
  } catch {
    refuse("the pattern is not a valid regular expression");
  }
  const only = typeof args.glob === "string" && args.glob ? globRegex(args.glob) : undefined;
  const hits: string[] = [];
  const scan = (file: string, relative: string, size: number) => {
    if (isDatabase(relative) || size > MAX_GREP_FILE_BYTES || (only && !only.test(path.basename(relative)))) return true;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) return true;
    buffer.toString("utf8").split("\n").forEach((line, index) => {
      if (hits.length < MAX_MATCHES && regex.test(line)) hits.push(`${slashed(relative)}:${index + 1}:${line.slice(0, 300)}`);
    });
    return hits.length < MAX_MATCHES;
  };
  if (fs.statSync(full).isDirectory()) walk(root, full, scan);
  else scan(full, path.relative(root, full), fs.statSync(full).size);
  return hits.length ? clip(hits.join("\n")) : "no matches";
}

const SQL_FORBIDDEN = /\b(attach|detach|pragma|insert|update|delete|drop|create|alter|vacuum|reindex|load_extension)\b/i;

type ReadOnlyDb = { prepare(sql: string): { all(): Array<Record<string, unknown>> }; exec(sql: string): void; close(): void };

function openReadOnly(file: string): ReadOnlyDb {
  const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite");
  return process.versions.bun ? new native.Database(file, { readonly: true }) : new native.DatabaseSync(file, { readOnly: true });
}

function runReadOnlySql(databaseFile: string, query: unknown): string {
  if (typeof query !== "string" || !query.trim()) refuse("sql needs a query");
  const statement = query.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(statement) || statement.includes(";")) refuse("only a single SELECT (or WITH … SELECT) is allowed");
  if (SQL_FORBIDDEN.test(statement.replace(/'(?:[^']|'')*'/g, "''"))) refuse("that statement is not allowed; only reads are");
  const db = openReadOnly(databaseFile);
  try {
    db.exec("PRAGMA query_only=1");
    const rows = db.prepare(statement).all();
    const shown = rows.slice(0, MAX_SQL_ROWS).map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" && value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value])),
    );
    return clip(JSON.stringify({ rows: shown, ...(rows.length > MAX_SQL_ROWS ? { truncated: rows.length } : {}) }));
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}

export function runDiagnosisTool(folder: string, tool: UsageDiagnosisTool, args: Record<string, unknown>): string {
  const root = fs.realpathSync(folder);
  switch (tool) {
    case "read":
      return readFile(root, args);
    case "glob":
      return globFiles(root, args);
    case "grep":
      return grepFiles(root, args);
    case "sql":
      return runReadOnlySql(path.join(root, "execution.sqlite"), args.query);
  }
}
