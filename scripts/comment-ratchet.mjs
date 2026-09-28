#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
export const BASELINE_FILE = "scripts/comment-baseline.json";

const LANGUAGES = {
  ".ts": "js", ".tsx": "js", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".swift": "swift",
  ".css": "css",
};
const REGEX_AFTER_CHAR = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

export const languageOf = (file) => LANGUAGES[extname(file)];

/** Line numbers (1-based) that carry comment text, and the count of non-blank lines. */
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
  const nonBlank = source.split("\n").filter((text) => text.trim() !== "").length;
  return { lines, nonBlank };
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

export const round4 = (value) => Math.round(value * 10_000) / 10_000;

export function ratioFailures(current, baseline) {
  const failures = [];
  for (const [workspace, ratio] of Object.entries(current)) {
    const limit = baseline[workspace];
    if (limit === undefined) failures.push(`${workspace}: no baseline in ${BASELINE_FILE}. Run \`bun scripts/comment-ratchet.mjs --write-baseline\`.`);
    else if (ratio > limit) failures.push(`${workspace}: comment ratio ${ratio} is above its baseline ${limit}. Delete comments rather than raising the baseline.`);
  }
  return failures;
}

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });

export function workspaceRatios(root) {
  const ratios = {};
  for (const workspace of WORKSPACES) {
    let comment = 0;
    let total = 0;
    for (const file of git(root, ["ls-files", "--", workspace]).split("\n")) {
      const language = file && languageOf(file);
      if (!language) continue;
      const { lines, nonBlank } = commentLines(readFileSync(join(root, file), "utf8"), language);
      comment += lines.size;
      total += nonBlank;
    }
    if (total > 0) ratios[workspace] = round4(comment / total);
  }
  return ratios;
}

export function newBlockFailures(root, baseRef) {
  let base;
  try {
    base = git(root, ["merge-base", baseRef, "HEAD"]).trim();
  } catch {
    return [`cannot find the merge base with ${baseRef}; fetch it (in CI, check out with fetch-depth: 0).`];
  }
  const diff = git(root, ["diff", "-U0", "--no-color", "--no-renames", "--diff-filter=AM", base, "--", ...WORKSPACES, "scripts"]);
  const failures = [];
  for (const [file, added] of addedLines(diff)) {
    const language = languageOf(file);
    if (!language) continue;
    const { lines } = commentLines(readFileSync(join(root, file), "utf8"), language);
    for (const [first, last] of newCommentRuns(lines, added)) {
      failures.push(`${file}:${first}-${last}: a new ${last - first + 1}-line comment. The limit is ${MAX_NEW_BLOCK_LINES}; AGENTS.md allows 3.`);
    }
  }
  return failures;
}

export function commentRatchetFailures(root, baseRef = process.env.COMMENT_RATCHET_BASE || "origin/main") {
  const baseline = JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));
  return [...ratioFailures(workspaceRatios(root), baseline), ...newBlockFailures(root, baseRef)];
}

if (import.meta.main) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(workspaceRatios(root), null, 2)}\n`);
    console.log(`wrote ${BASELINE_FILE}`);
  } else {
    const failures = commentRatchetFailures(root);
    for (const failure of failures) console.error(failure);
    process.exit(failures.length > 0 ? 1 : 0);
  }
}
