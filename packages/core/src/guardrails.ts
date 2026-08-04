// THE PROJECT'S GUARDRAIL PREDICATE — one definition, for every seam that spawns.
//
// WHY IT MOVED HERE. This logic was written in apps/web/lib/permissions.ts and
// called from the chat route's two enforcement points (canUseTool and the
// PreToolUse hook). Its own comment said it was "callable from both canUseTool
// and, later, an SDK PreToolUse hook — neither of which this function knows
// about", and that generality was real. What it could NOT reach was the other
// half of the system: `engine.ts`'s agent() and `ultra/runner.ts` spawn children
// from THIS package, and a module in apps/web is not importable from core
// without inverting the dependency. So a session turn enforced `protectedPaths`
// and `disallowedTools`, and every child agent — every Ultra agent, every loom
// thread — enforced neither. Same shape of defect as claude-executable.ts: the
// knowledge lived one layer above the code that needed it.
//
// The app layer now re-exports these rather than holding a second copy. A second
// copy is how two enforcement points drift into one enforcement point and one
// decoration.
//
// PURE, and deliberately so: no state root, no TELAR_HOME composition, no
// process-wide anything. It takes an already-resolved `root` and a guardrail set
// and returns a decision. `node:fs` appears only for realpath, which is what
// makes the traversal defences below real rather than textual.
import fs from "node:fs";
import path from "node:path";

// Tool inputs that name a file, in priority order — Write/Edit/MultiEdit use
// file_path, NotebookEdit uses notebook_path.
const PATH_KEYS = ["file_path", "notebook_path", "path"];
export function inputPaths(input: Record<string, unknown>): string[] {
  return PATH_KEYS.map((k) => input[k]).filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

// Resolve symlinks as far up the tree as they exist. A tool's target may not
// exist yet (e.g. Write creating a new file), so this walks up to the first
// existing ancestor, realpath's that, then rejoins the remaining segments —
// a symlinked ancestor directory still gets caught even for a new file.
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathOrSelf(parent), path.basename(p));
  }
}

// True when `target` (a tool's file path, absolute or relative to `root`)
// resolves to, or lands inside, one of the project's protected paths. Both
// sides are resolved against `root` and then through realpath, so ../
// traversal, trailing slashes, absolute-vs-relative mismatches, and a
// symlink planted inside the repo that points at a protected file all
// reduce to a canonical comparison.
// NOTE: this guards MODIFICATION, not disclosure. Read/Grep/Glob are pre-allowed
// and never path-checked, so a protected file's *contents* can still be read.
export function isProtectedPath(root: string, protectedPaths: string[], target: string): boolean {
  if (!target) return false;
  const abs = realpathOrSelf(path.resolve(root, target));
  return protectedPaths.some((p) => {
    if (!p) return false;
    const base = realpathOrSelf(path.resolve(root, p));
    return abs === base || abs.startsWith(base + path.sep);
  });
}

// Bash carries its target in `command`, not in a path field, so
// isProtectedPath(inputPaths(...)) never sees it — protectedPaths would
// otherwise be silently bypassed by e.g. Bash(rm -rf .env). This is a
// best-effort static check: split the command on whitespace/shell
// metacharacters and test every resulting word as a candidate path. It
// cannot see through variable expansion or obfuscation, but it catches the
// direct case.
const BASH_WORD_SPLIT = /[\s;&|><$`"'(){}]+/;
export function bashTouchesProtectedPath(root: string, protectedPaths: string[], command: string): boolean {
  if (!protectedPaths.length) return false;
  return command
    .split(BASH_WORD_SPLIT)
    .filter(Boolean)
    .some((word) => isProtectedPath(root, protectedPaths, word));
}

/** The guardrail set, structurally — a SessionProfile and a ProjectManifest are
 *  both assignable, which is what lets one predicate serve the session seam and
 *  the child seam without either knowing about the other's type. */
export type GuardrailBearer = {
  guardrails: { disallowedTools: string[]; protectedPaths: string[] };
};

// The hard-deny checks, in cost order: disallowedTools first (no filesystem
// access), then protectedPaths over path-shaped inputs, then protectedPaths
// over a Bash command's words.
export function makeGuardrailDecision(
  manifest: GuardrailBearer,
  root: string,
  toolName: string,
  input: Record<string, unknown>,
): { behavior: "allow" } | { behavior: "deny"; message: string } {
  const g = manifest.guardrails;
  if (g.disallowedTools.includes(toolName)) {
    return { behavior: "deny", message: `${toolName} is disallowed by this project's guardrails.` };
  }
  const blocked = inputPaths(input).find((t) => isProtectedPath(root, g.protectedPaths, t));
  if (blocked) {
    return { behavior: "deny", message: `"${blocked}" is a protected path in this project.` };
  }
  // protectedPaths above only inspects path-shaped input keys, which Bash
  // never populates (its target lives in `command`) — check it separately
  // or the guardrail is a no-op for the most powerful tool.
  if (
    toolName === "Bash" &&
    typeof input.command === "string" &&
    bashTouchesProtectedPath(root, g.protectedPaths, input.command)
  ) {
    return { behavior: "deny", message: "This command touches a protected path in this project." };
  }
  return { behavior: "allow" };
}
