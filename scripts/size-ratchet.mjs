#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";
import { WORKSPACES, git, mergeBaseOf } from "./comment-ratchet.mjs";

export const MAX_FILE_LINES = 800;
export const MAX_FUNCTION_LINES = 150;

const SCRIPT_KINDS = { ".ts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX, ".js": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS };
const SKIPPED = /(^|\/)(node_modules|dist|out|build|test-fixtures)\//;

const measured = (file) => !SKIPPED.test(file) && (extname(file) in SCRIPT_KINDS || extname(file) === ".swift");

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

/** `git diff -U0` hunks as { from, deleted, at, added }: `added` lines start at `at`; a pure deletion sits after line `at`. */
export function hunksOf(diff) {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    deleted: m[2] === undefined ? 1 : Number(m[2]),
    at: Number(m[3]),
    added: m[4] === undefined ? 1 : Number(m[4]),
  }));
}

export function sizeFailures(file, text, before, hunks) {
  const failures = [];
  const lines = lineCount(text);
  const was = before === undefined ? undefined : lineCount(before);
  if (lines > MAX_FILE_LINES && (was === undefined || lines > Math.max(was, MAX_FILE_LINES))) {
    failures.push(
      was === undefined || was <= MAX_FILE_LINES
        ? `${file}: ${lines} lines; the limit is ${MAX_FILE_LINES}. Split it.`
        : `${file}: grew from ${was} to ${lines} lines, over the ${MAX_FILE_LINES}-line limit. Extract what you changed instead of adding to it.`,
    );
  }
  for (const { name, first, last } of functionSpans(file, text)) {
    const length = last - first + 1;
    if (length <= MAX_FUNCTION_LINES) continue;
    let added = 0;
    let deleted = 0;
    for (const hunk of hunks) {
      const lastAdded = hunk.at + hunk.added - 1;
      if (hunk.added > 0) added += Math.max(0, Math.min(last, lastAdded) - Math.max(first, hunk.at) + 1);
      if (hunk.added === 0 ? hunk.at >= first && hunk.at < last : hunk.at >= first && lastAdded <= last) deleted += hunk.deleted;
    }
    if (added === 0) continue;
    const prior = length - added + deleted;
    if (before !== undefined && added * 2 <= length && length <= Math.max(prior, MAX_FUNCTION_LINES)) continue;
    failures.push(
      before === undefined || added * 2 > length
        ? `${file}:${first}: ${name} is ${length} lines; the limit is ${MAX_FUNCTION_LINES}. Split it.`
        : `${file}:${first}: ${name} grew from ${prior} to ${length} lines, over the ${MAX_FUNCTION_LINES}-line limit. Extract what you changed.`,
    );
  }
  return failures;
}

/** Files changed since `base` as [status, path, pathAtBase]. */
function changedFiles(root, base) {
  return git(root, ["diff", "--name-status", "-M30%", "--no-color", "--diff-filter=AMR", base, "--", ...WORKSPACES, "scripts"])
    .split("\n")
    .filter(Boolean)
    .map((row) => row.split("\t"))
    .map(([status, a, b]) => (status.startsWith("R") ? ["R", b, a] : [status, a, a]))
    .filter(([, file]) => measured(file) && existsSync(join(root, file)));
}

const show = (root, ref, file) => execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

export function sizeRatchet(root, baseRef = process.env.COMMENT_RATCHET_BASE || "origin/main") {
  const base = mergeBaseOf(root, baseRef);
  if (!base) return [`cannot find the merge base with ${baseRef}; fetch it (in CI, check out with fetch-depth: 0).`];
  return changedFiles(root, base).flatMap(([status, file, atBase]) => {
    const text = readFileSync(join(root, file), "utf8");
    if (status === "A") return sizeFailures(file, text, undefined, [{ deleted: 0, at: 1, added: lineCount(text) }]);
    const diff = git(root, ["diff", "-U0", "--no-color", "-M30%", base, "--", atBase, file]);
    return sizeFailures(file, text, show(root, base, atBase), hunksOf(diff));
  });
}

if (import.meta.main) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const failures = sizeRatchet(root);
  for (const failure of failures) console.error(failure);
  process.exit(failures.length > 0 ? 1 : 0);
}
