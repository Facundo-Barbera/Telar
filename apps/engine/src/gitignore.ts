/**
 * IGNORING TELAR'S OWN FILES IN SOMEBODY'S REPOSITORY.
 *
 * WHAT vNEXT ACTUALLY WRITES INTO A CHECKOUT: nothing. Every write this engine
 * makes lands under `TELAR_HOME` — the state directory, the journals, the
 * attachments, and worktrees, which go to `<TELAR_HOME>/engine/worktrees` for the
 * reasons `worktree.ts` sets out. The single exception is `writeWorkspaceFile`,
 * which saves a file a person opened and edited on purpose.
 *
 * SO WHY THIS EXISTS. The rules below are DEFENSIVE, and the header says so in the
 * file it writes. `telar.yaml` and `.telar/` are the legacy app's project-local
 * manifest and state — it is the same repository and the same machine, and a
 * checkout that has ever been opened by the old app will grow them. The worktree
 * rule covers a mode that does not exist today: if an in-repo worktree layout is
 * ever added, a repository registered before that change would otherwise start
 * reporting a checkout as untracked files.
 *
 * IT NEVER REWRITES AND NEVER DUPLICATES. Ported from the frozen app's
 * `ensureTelarGitignore`, which got this right: read the file, compare against a
 * set of patterns that would ALREADY cover each rule, and append only what is
 * missing. Somebody who wrote `/.telar` gets nothing added; somebody who wrote a
 * comment about Telar gets the rules, because a comment is not a rule.
 *
 * THE RULES ARE HERE, NOT IN A REQUEST. The route takes a project id and nothing
 * else. A caller that could name the lines could append anything to a file inside
 * a repository, and this is the only write in the engine that touches a file the
 * user did not ask for by name.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GitignoreResult } from "@telar/engine-client";

/**
 * One rule, and every spelling that already covers it.
 *
 * `alreadyCovered` IS NOT COSMETIC. `.telar/`, `.telar`, `/.telar/` and `/.telar`
 * all ignore the same directory, and a repository that has any of them must not
 * grow a fifth line saying it again — that is how a `.gitignore` ends up with the
 * same rule four times in four different hands.
 */
type IgnoreRule = { rule: string; alreadyCovered: string[]; why: string };

export const TELAR_IGNORE_RULES: IgnoreRule[] = [
  {
    rule: "telar.yaml",
    alreadyCovered: ["telar.yaml", "/telar.yaml"],
    why: "the legacy app's project manifest",
  },
  {
    rule: ".telar/",
    alreadyCovered: [".telar/", ".telar", "/.telar/", "/.telar"],
    why: "the legacy app's project-local state",
  },
  {
    rule: ".telar-worktrees/",
    alreadyCovered: [".telar-worktrees/", ".telar-worktrees", "/.telar-worktrees/", "/.telar-worktrees"],
    why: "reserved: Telar keeps worktrees outside the repository today",
  },
];

/** The comment that goes above the rules, so the next person to read this file
 *  knows who wrote them and can delete them on purpose. */
const HEADER = "# Telar — local state, not for sharing";

/**
 * The rules a `.gitignore` already covers.
 *
 * BLANK LINES AND COMMENTS ARE NOT RULES. A file whose only mention of Telar is
 * `# telar stuff below` covers nothing, and treating that as a match would leave
 * the repository unignored while reporting success.
 */
function existingRules(contents: string): Set<string> {
  return new Set(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
}

/**
 * Append what is missing to `<root>/.gitignore`.
 *
 * NOT ATOMIC, AND THAT IS THE RIGHT CALL HERE — unlike `writeWorkspaceFile`, which
 * writes beside the target and renames. This appends to a file the user owns and
 * may have open in an editor; a rename would replace their inode, and an editor
 * holding the old one would write the whole file back over these lines the next
 * time it saved. Read-modify-write on the same inode is what `git` itself does.
 */
export function ensureTelarGitignore(root: string, rules: IgnoreRule[] = TELAR_IGNORE_RULES): GitignoreResult {
  const file = path.join(root, ".gitignore");
  let contents = "";
  let created = false;
  try {
    contents = readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    created = true;
  }

  const already = existingRules(contents);
  const added: string[] = [];
  const present: string[] = [];
  for (const entry of rules) {
    if (entry.alreadyCovered.some((pattern) => already.has(pattern))) present.push(entry.rule);
    else added.push(entry.rule);
  }
  if (added.length === 0) return { added, present, path: file, created: false };

  // A file that does not end in a newline would otherwise have the header
  // welded onto its last rule.
  const prefix = contents.length > 0 && !contents.endsWith("\n") ? `${contents}\n` : contents;
  // The blank line matters: appended flush against somebody else's section, these
  // rules read as part of it.
  const gap = prefix.length > 0 && !prefix.endsWith("\n\n") ? "\n" : "";
  const block = [HEADER, ...added.map((rule) => rule)].join("\n");
  writeFileSync(file, `${prefix}${gap}${block}\n`, "utf8");
  return { added, present, path: file, created };
}
