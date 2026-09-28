#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.(js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** The file as TypeScript prints it with every comment removed. */
export function withoutComments(file: string, text: string): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

export const onlyCommentsChanged = (file: string, before: string, after: string) =>
  withoutComments(file, before) === withoutComments(file, after);

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Changed code files whose non-comment text differs from `base`. */
export function tokenChanges(base: string, paths: string[] = []): string[] {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const files = git(["diff", "--name-only", "--diff-filter=M", mergeBase, "--", ...paths]).split("\n").filter((f) => CODE.test(f));
  return files.filter((file) => !onlyCommentsChanged(file, git(["show", `${mergeBase}:${file}`]), readFileSync(file, "utf8")));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--base");
  const base = at === -1 ? "origin/main" : args.splice(at, 2)[1]!;
  const changed = tokenChanges(base, args);
  for (const file of changed) console.error(`code changed, not only comments: ${file}`);
  if (changed.length === 0) console.log(`only comments changed against ${base}`);
  process.exit(changed.length === 0 ? 0 : 1);
}
