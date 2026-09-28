#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";
import { WORKSPACES, git } from "./comment-ratchet.mjs";

export const MAX_FILE_LINES = 800;
export const MAX_FUNCTION_LINES = 150;

// The only files allowed over the limits, each with the reason. One that fits again fails until it is removed here.
export const ALLOWED = {
};

const SCRIPT_KINDS = { ".ts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX, ".js": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS };
const SKIPPED = /(^|\/)(node_modules|dist|out|build|test-fixtures)\//;
// Test callbacks are exempt from the function limit: a describe block is a list, not logic.
const TEST_FILE = /\.(test|electron-test)\.[cm]?[jt]sx?$|(^|\/)test\//;

export const measured = (file) => !SKIPPED.test(file) && (extname(file) in SCRIPT_KINDS || extname(file) === ".swift");

export const lineCount = (text) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

function nameOf(node, source) {
  const name = node.name ?? (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent) ? node.parent.name : undefined);
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))) return name.text;
  if (ts.isCallExpression(node.parent)) {
    const label = node.parent.arguments.find((arg) => ts.isStringLiteralLike(arg));
    return `${node.parent.expression.getText(source).slice(0, 40)}${label ? `(${JSON.stringify(label.text)})` : ""} callback`;
  }
  return "anonymous function";
}

/** Every function with a body in `text`, outermost first, as { name, first, last } (1-based lines). */
export function functionSpans(file, text) {
  const kind = SCRIPT_KINDS[extname(file)];
  if (kind === undefined) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const spans = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      spans.push({ name: nameOf(node, source), first: lineOf(node.getStart(source)), last: lineOf(node.end) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return spans;
}

/** Failures for `files` ({ file, text }), against `allowed` (path → reason). */
export function limitFailures(files, allowed = ALLOWED) {
  const failures = [];
  const seen = new Set();
  for (const { file, text } of files) {
    seen.add(file);
    const lines = lineCount(text);
    const long = TEST_FILE.test(file)
      ? []
      : functionSpans(file, text).filter(({ first, last }) => last - first + 1 > MAX_FUNCTION_LINES);
    if (file in allowed) {
      if (lines <= MAX_FILE_LINES && long.length === 0) failures.push(`${file}: now within the limits; remove it from ALLOWED in scripts/size-limits.mjs.`);
      continue;
    }
    if (lines > MAX_FILE_LINES) failures.push(`${file}: ${lines} lines; the limit is ${MAX_FILE_LINES}. Split it.`);
    for (const { name, first, last } of long) {
      failures.push(`${file}:${first}: ${name} is ${last - first + 1} lines; the limit is ${MAX_FUNCTION_LINES}. Split it.`);
    }
  }
  for (const file of Object.keys(allowed)) if (!seen.has(file)) failures.push(`${file}: listed in ALLOWED but not tracked; remove it.`);
  return failures;
}

export function sizeLimits(root) {
  const files = git(root, ["ls-files", "--", ...WORKSPACES, "scripts"])
    .split("\n")
    .filter((file) => file && measured(file))
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
  return limitFailures(files);
}

if (import.meta.main) {
  const failures = sizeLimits(git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
  for (const failure of failures) console.error(failure);
  process.exit(failures.length > 0 ? 1 : 0);
}
