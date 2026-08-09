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

// True when `target` (a tool's file path, absolute or relative) resolves to, or
// lands inside, one of the project's protected paths. Both sides go through
// realpath after resolution, so ../ traversal, trailing slashes,
// absolute-vs-relative mismatches, and a symlink planted inside the repo that
// points at a protected file all reduce to a canonical comparison.
//
// TWO ROOTS, AND THE TARGET IS TESTED UNDER BOTH (story 13, deferred-work.md's
// Codex-guardrail residual). `protectedPaths` are a statement about the
// PROJECT, so they always resolve against `root` — letting a tool's cwd move
// them would let a tool escape the guardrail by `cd`. The TARGET is a statement
// about a running tool, and a tool invocation can carry its own working
// directory: Codex's approval requests do (`req.cwd`), and that cwd was
// captured and then never used, so `rm -rf .env` approved from a subdirectory
// was tested only as `<root>/.env` and the real `<root>/sub/.env` was invisible.
//
// UNION, NOT REPLACEMENT, AND THAT IS THE WHOLE CORRECTNESS ARGUMENT. The first
// cut of this resolved the target against `targetRoot` INSTEAD of `root`, which
// fixed the miss above and simultaneously opened a one-line evasion: with
// `<root>/.env` protected and an invocation cwd of `<root>/sub`, `cd .. && rm
// -rf .env` word-splits to `.env`, resolves to `<root>/sub/.env`, and ALLOWS a
// command that HEAD denied. The model controls both the exec's cwd and the
// command string, so replacement trades a fail-SAFE error (a subdirectory's own
// `.env` denied because the root's is protected) for a fail-OPEN one. On a
// best-effort static word check that trade is never worth taking, so a target is
// a hit if it lands in a protected path under EITHER root: every deny this
// function made before still happens, and the misses the residual named are
// added on top. `targetRoot` defaults to `root`, so a caller with no
// per-invocation cwd computes exactly one candidate and is unchanged by
// construction.
//
// NOTE: this guards MODIFICATION IN INTENT, not disclosure — but the code does
// NOT implement that restriction, and saying so is the point. `protectedPaths`
// is consulted for EVERY tool name (see makeGuardrailDecision), so a `Read` of a
// protected path is denied too. An earlier version of this note claimed
// "Read/Grep/Glob are pre-allowed and never path-checked"; that is true of
// `allowedTools` at the SDK's canUseTool fast path and FALSE at the PreToolUse
// hook, which runs for every tool. The contradiction (and the test that fails on
// it) is recorded in deferred-work.md's 5-13 section; it is a policy question,
// not a typo, and it predates story 13.
export function isProtectedPath(
  root: string,
  protectedPaths: string[],
  target: string,
  targetRoot: string = root,
): boolean {
  if (!target) return false;
  // Deduped rather than always-two, so the overwhelmingly common single-root
  // call does exactly the filesystem work it did before this parameter existed.
  const candidates =
    targetRoot === root
      ? [realpathOrSelf(path.resolve(root, target))]
      : [
          realpathOrSelf(path.resolve(root, target)),
          realpathOrSelf(path.resolve(targetRoot, target)),
        ];
  return protectedPaths.some((p) => {
    if (!p) return false;
    const base = realpathOrSelf(path.resolve(root, p));
    return candidates.some((abs) => abs === base || abs.startsWith(base + path.sep));
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
export function bashTouchesProtectedPath(
  root: string,
  protectedPaths: string[],
  command: string,
  targetRoot: string = root,
): boolean {
  if (!protectedPaths.length) return false;
  return command
    .split(BASH_WORD_SPLIT)
    .filter(Boolean)
    .some((word) => isProtectedPath(root, protectedPaths, word, targetRoot));
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
//
// `invocationCwd` is the OPTIONAL working directory of this one invocation (see
// isProtectedPath's two-roots note). Omitted, everything resolves against `root`
// exactly as before — which is why the three PRE-EXISTING call sites, none of
// which has such a cwd to give, did not change when this parameter arrived:
// canUseTool (`apps/web/app/api/chat/route.ts`), the PreToolUse hook
// (`apps/web/lib/server/turn-hooks.ts`), and every Ultra child
// (`packages/core/src/ultra/child-guard.ts`). That last one is the seam most
// likely to want a per-invocation cwd next; it is counted here so the next
// editor does not have to re-derive the list from a comment that miscounted it.
export function makeGuardrailDecision(
  manifest: GuardrailBearer,
  root: string,
  toolName: string,
  input: Record<string, unknown>,
  invocationCwd?: string,
): { behavior: "allow" } | { behavior: "deny"; message: string } {
  const g = manifest.guardrails;
  if (g.disallowedTools.includes(toolName)) {
    return { behavior: "deny", message: `${toolName} is disallowed by this project's guardrails.` };
  }
  // ONLY AN ABSOLUTE PATH IS A CWD HERE, and anything else falls through to
  // `root` — the same defaulting an omitted argument gets. This value arrives
  // from OUTSIDE this process (the Codex app-server's approval request), so it
  // is untrusted input, and `path.resolve` would happily blend a relative one
  // into the web server's own `process.cwd()`: `""` reaches it directly, and
  // `"sub"` reaches `<process.cwd()>/sub`. Both are the "third directory
  // neither the session nor the tool ever named" this guard exists to refuse,
  // and the empty-string case was only ever half of it. (An out-of-root
  // absolute cwd is accepted deliberately: under isProtectedPath's UNION it can
  // only add candidate hits, never remove one, so it cannot weaken a decision.)
  const targetRoot = invocationCwd && path.isAbsolute(invocationCwd) ? invocationCwd : root;
  const blocked = inputPaths(input).find((t) => isProtectedPath(root, g.protectedPaths, t, targetRoot));
  if (blocked) {
    return { behavior: "deny", message: `"${blocked}" is a protected path in this project.` };
  }
  // protectedPaths above only inspects path-shaped input keys, which Bash
  // never populates (its target lives in `command`) — check it separately
  // or the guardrail is a no-op for the most powerful tool.
  if (
    toolName === "Bash" &&
    typeof input.command === "string" &&
    bashTouchesProtectedPath(root, g.protectedPaths, input.command, targetRoot)
  ) {
    return { behavior: "deny", message: "This command touches a protected path in this project." };
  }
  return { behavior: "allow" };
}
