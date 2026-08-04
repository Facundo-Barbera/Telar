// The file index behind the composer's `@` mention menu.
//
// SOURCE IS GIT, NOT A DIRECTORY WALK. `git ls-files` gives us the repo's
// tracked files — already .gitignore-filtered, already excluding node_modules
// and build output — in one process, where a recursive readdir would spend most
// of its time inside exactly the directories a human never wants to mention.
// The fallback for a non-git project is a bounded walk, because "this project
// isn't a repo" should degrade rather than offer nothing.
//
// EVERYTHING RETURNED IS REPO-RELATIVE. The absolute path is composed at the
// point of use (the chat route, against the project's own root) so that a path
// arriving back over the wire is re-validated against the root rather than
// trusted — see resolveMention.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Enough to fill the menu several times over; the ranking below is what makes
 *  the first ten good, not the size of the candidate set. */
const MAX_RESULTS = 50;
/** A walk of a non-git project stops here rather than exploring a monorepo's
 *  entire dependency tree. */
const WALK_LIMIT = 20_000;
const WALK_SKIP = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".turbo",
  ".venv",
  "__pycache__",
  "target",
]);

function gitFiles(root: string): string[] | null {
  try {
    // -z + split on NUL: a filename may legally contain a newline, and a
    // newline-split list would turn one such file into two bogus entries.
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return null; // not a repo, or no git on PATH — fall back to the walk
  }
}

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && found.length < WALK_LIMIT) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not a reason to fail the whole index
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      const full = path.join(dir, entry.name);
      // isDirectory() is false for a symlink, so this walk never follows one —
      // which is also what keeps it from looping through a self-referential link.
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        found.push(path.relative(root, full));
      }
    }
  }
  return found;
}

/**
 * Score one candidate against a query. Higher is better; null means "no match".
 *
 * The ordering this produces is the whole value of the menu: a human typing
 * `@route` means `app/api/chat/route.ts` far more often than
 * `docs/routing-notes.md`, so a basename hit outranks a path hit, and a prefix
 * outranks an interior match. Subsequence matching is last because it is the
 * one that matches almost everything.
 */
function score(rel: string, query: string): number | null {
  const haystack = rel.toLowerCase();
  const base = path.basename(haystack);
  const q = query.toLowerCase();

  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (haystack.startsWith(q)) return 2;
  if (base.includes(q)) return 3;
  if (haystack.includes(q)) return 4;

  // Fuzzy: every character of the query appears in order. "acr" finds
  // "app/api/chat/route.ts".
  let i = 0;
  for (const ch of haystack) {
    if (ch === q[i]) i++;
    if (i === q.length) return 5;
  }
  return null;
}

export type ProjectFile = { path: string; name: string };

/**
 * Pull `@path` mentions out of a turn's text and resolve them against the
 * project.
 *
 * EXTRACTED SERVER-SIDE, ON PURPOSE. The composer could track which of its
 * `@`-insertions were real and ship a parallel list, but then the list and the
 * text can disagree — the human edits the path by hand, deletes half of it, or
 * pastes one in — and the harness would receive a mention the message no longer
 * makes. Reading it back out of the final text means the two can never drift,
 * and it costs one regex plus a stat per candidate.
 *
 * EXISTENCE IS THE FILTER, which is what keeps this from mangling ordinary
 * prose: `@telar/core` in a sentence about a package, an email address, a
 * decorator — none of them resolve to a file, so none of them become mentions.
 */
export function extractMentions(text: string, root: string): ProjectFile[] {
  const out: ProjectFile[] = [];
  const seen = new Set<string>();
  // Preceded by start-of-string or whitespace so `foo@bar` and an email's
  // domain are never candidates in the first place.
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    let candidate = match[1]!;
    // Trailing punctuation belongs to the sentence, not to the path: "look at
    // @src/app.ts." must not go looking for a file called "app.ts.".
    candidate = candidate.replace(/[.,;:!?)\]}'"]+$/, "");
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (resolveMention(root, candidate)) {
      out.push({ name: path.basename(candidate), path: candidate });
    }
  }
  return out;
}

/**
 * Rank the project's files against a mention query. An empty query returns the
 * shallowest paths — the top-level files a human is most likely to mean before
 * they have typed anything to narrow by.
 */
export function searchProjectFiles(root: string, query: string): ProjectFile[] {
  const all = gitFiles(root) ?? walkFiles(root);
  const trimmed = query.trim();

  const ranked = trimmed
    ? all
        .map((rel) => ({ rel, rank: score(rel, trimmed) }))
        .filter((c): c is { rel: string; rank: number } => c.rank !== null)
        // Ties break on path length: the shorter path is the less-nested one,
        // and a `@config` that matches both `config.ts` and
        // `packages/x/src/deep/config.ts` should offer the former first.
        .sort((a, b) => a.rank - b.rank || a.rel.length - b.rel.length)
    : all
        .map((rel) => ({ rel, rank: rel.split("/").length }))
        .sort((a, b) => a.rank - b.rank || a.rel.localeCompare(b.rel));

  return ranked.slice(0, MAX_RESULTS).map(({ rel }) => ({
    name: path.basename(rel),
    path: rel,
  }));
}

/**
 * Turn a mention that arrived over the wire into an absolute path, or null.
 *
 * NEVER TRUST THE CLIENT'S PATH. The composer only ever offers paths this
 * module produced, but the wire is the wire: a `../../.ssh/id_rsa` would
 * otherwise become a `mention` input item pointing outside the project, and
 * hand a file the user never chose to a harness that will read it. Resolved and
 * re-checked against the root, with the file's existence as the last gate.
 */
export function resolveMention(root: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0 || path.isAbsolute(rel)) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  // The separator matters: without it, "/repo-secrets" passes a bare
  // startsWith("/repo") check.
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}
