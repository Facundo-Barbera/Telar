#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

export const WORKSPACES = [
  "apps/engine",
  "apps/web",
  "apps/desktop",
  "apps/ios",
  "packages/engine-client",
  "workers/push-relay",
  "workers/updates-proxy",
];
export const MAX_NEW_BLOCK_LINES = 6;

const LANGUAGES = {
  ".ts": "js", ".tsx": "js", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".swift": "swift",
  ".css": "css",
};
const REGEX_AFTER_CHAR = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

export const languageOf = (file) => LANGUAGES[extname(file)];

/** Line numbers (1-based) that carry comment text. */
export function commentLines(source, language) {
  const lines = new Set();
  let i = 0;
  let line = 1;
  let prev = "";
  let word = "";
  const n = source.length;
  const at = (k) => source[k] ?? "";

  const advance = () => {
    if (source[i] === "\n") line += 1;
    i += 1;
  };
  const skipQuoted = (quote) => {
    advance();
    while (i < n && source[i] !== quote && source[i] !== "\n") {
      if (source[i] === "\\") advance();
      advance();
    }
    advance();
  };
  const skipBlockComment = () => {
    let depth = 0;
    do {
      if (at(i) === "/" && at(i + 1) === "*" && (depth === 0 || language === "swift")) {
        depth += 1;
        lines.add(line);
        i += 2;
      } else if (at(i) === "*" && at(i + 1) === "/") {
        depth -= 1;
        lines.add(line);
        i += 2;
      } else {
        if (!/\s/.test(source[i])) lines.add(line);
        advance();
      }
    } while (i < n && depth > 0);
  };
  const skipRegex = () => {
    advance();
    let inClass = false;
    while (i < n && source[i] !== "\n") {
      const c = source[i];
      if (c === "\\") advance();
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      advance();
    }
    advance();
    while (/[a-z]/.test(at(i))) advance();
  };
  const skipTemplate = () => {
    advance();
    while (i < n && source[i] !== "`") {
      if (source[i] === "\\") {
        advance();
        advance();
      } else if (source[i] === "$" && at(i + 1) === "{") {
        i += 2;
        scan("}");
      } else advance();
    }
    advance();
  };
  const skipSwiftMultiline = () => {
    i += 3;
    while (i < n && !(source[i] === '"' && at(i + 1) === '"' && at(i + 2) === '"')) {
      if (source[i] === "\\") advance();
      advance();
    }
    i += 3;
  };

  function scan(closer) {
    let depth = 0;
    while (i < n) {
      const c = source[i];
      const next = at(i + 1);
      if (closer && c === "{") depth += 1;
      if (closer && c === "}" && depth-- === 0) {
        i += 1;
        return;
      }
      if (c === "/" && next === "/" && language !== "css") {
        lines.add(line);
        while (i < n && source[i] !== "\n") i += 1;
        continue;
      }
      if (c === "/" && next === "*") {
        skipBlockComment();
        continue;
      }
      if (language === "swift" && c === '"' && next === '"' && at(i + 2) === '"') skipSwiftMultiline();
      else if (c === '"' || (c === "'" && language !== "swift")) skipQuoted(c);
      else if (c === "`" && language === "js") skipTemplate();
      else if (c === "/" && language === "js" && (prev === "" || REGEX_AFTER_CHAR.has(prev) || REGEX_AFTER_WORD.has(word))) skipRegex();
      else {
        if (/[A-Za-z0-9_$]/.test(c)) word = /[A-Za-z0-9_$]/.test(prev) ? word + c : c;
        if (!/\s/.test(c)) prev = c;
        advance();
        continue;
      }
      prev = "a";
      word = "";
    }
  }

  scan(null);
  return lines;
}

/** Added line numbers per file, from `git diff -U0` output. */
export function addedLines(diff) {
  const added = new Map();
  let file = null;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      file = text === "+++ /dev/null" ? null : text.slice(6);
      if (file) added.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let k = 0; k < count; k += 1) added.get(file).add(start + k);
  }
  return added;
}

/** Runs of consecutive added comment lines longer than `max`, as [first, last] pairs. */
export function newCommentRuns(comments, added, max = MAX_NEW_BLOCK_LINES) {
  const runs = [];
  let run = null;
  for (const lineNo of [...added].filter((l) => comments.has(l)).sort((a, b) => a - b)) {
    if (run && lineNo === run[1] + 1) run[1] = lineNo;
    else {
      if (run) runs.push(run);
      run = [lineNo, lineNo];
    }
  }
  if (run) runs.push(run);
  return runs.filter(([first, last]) => last - first + 1 > max);
}

export function countFailures(current, atBase) {
  return Object.entries(current)
    .filter(([workspace, count]) => count > (atBase[workspace] ?? 0))
    .map(([workspace, count]) => {
      const before = atBase[workspace] ?? 0;
      return `${workspace}: this change adds ${count - before} comment lines (${before} → ${count}). Delete comments rather than adding them.`;
    });
}

export const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });

const codeFiles = (list) => list.split("\n").filter((file) => file && languageOf(file));

export function workspaceCounts(root) {
  const counts = {};
  for (const workspace of WORKSPACES) {
    const files = codeFiles(git(root, ["ls-files", "--", workspace]));
    if (files.length === 0) continue;
    counts[workspace] = files.reduce((sum, file) => sum + commentLines(readFileSync(join(root, file), "utf8"), languageOf(file)).size, 0);
  }
  return counts;
}

export function countsAt(root, ref) {
  const counts = {};
  for (const workspace of WORKSPACES) {
    const files = codeFiles(git(root, ["ls-tree", "-r", "--name-only", ref, "--", workspace]));
    if (files.length === 0) continue;
    const blobs = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: files.map((file) => `${ref}:${file}`).join("\n"), maxBuffer: 1024 * 1024 * 1024 });
    let offset = 0;
    counts[workspace] = files.reduce((sum, file) => {
      const newline = blobs.indexOf(10, offset);
      const size = Number(blobs.subarray(offset, newline).toString().split(" ")[2]);
      const text = blobs.subarray(newline + 1, newline + 1 + size).toString("utf8");
      offset = newline + 1 + size + 1;
      return sum + commentLines(text, languageOf(file)).size;
    }, 0);
  }
  return counts;
}

export const mergeBaseOf = (root, baseRef) => {
  try {
    return git(root, ["merge-base", baseRef, "HEAD"]).trim();
  } catch {
    return undefined;
  }
};

export function newBlockFailures(root, base) {
  const diff = git(root, ["diff", "-U0", "--no-color", "--no-renames", "--diff-filter=AM", base, "--", ...WORKSPACES, "scripts"]);
  const failures = [];
  for (const [file, added] of addedLines(diff)) {
    const language = languageOf(file);
    if (!language) continue;
    const lines = commentLines(readFileSync(join(root, file), "utf8"), language);
    for (const [first, last] of newCommentRuns(lines, added)) {
      failures.push(`${file}:${first}-${last}: a new ${last - first + 1}-line comment. The limit is ${MAX_NEW_BLOCK_LINES}; AGENTS.md allows 3.`);
    }
  }
  return failures;
}

export function commentRatchet(root, baseRef = process.env.COMMENT_RATCHET_BASE || "origin/main") {
  const base = mergeBaseOf(root, baseRef);
  if (!base) return [`cannot find the merge base with ${baseRef}; fetch it (in CI, check out with fetch-depth: 0).`];
  return [...countFailures(workspaceCounts(root), countsAt(root, base)), ...newBlockFailures(root, base)];
}

if (import.meta.main) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const failures = commentRatchet(root);
  for (const failure of failures) console.error(failure);
  process.exit(failures.length > 0 ? 1 : 0);
}
