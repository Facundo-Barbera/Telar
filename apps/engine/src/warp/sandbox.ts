/**
 * WARP SCRIPT SANDBOX — capability shaping and determinism, NOT a security
 * boundary.
 *
 * Ported from `packages/core/src/ultra/sandbox.ts`, whose header states the
 * honest limit and is repeated here because it governs what this file may be
 * asked to do: Node documents `vm` as "not a security mechanism", and a
 * determined script can still walk the prototype chain to host globals. We do
 * not pretend otherwise. The author of a Warp script is the session's own agent,
 * acting on the user's instruction in the user's own checkout — it holds no
 * authority this could fence, and a sandbox that implied otherwise would be a
 * lie told to whoever reads this next.
 *
 * WHAT IT IS FOR is narrower and real:
 *
 *   · DETERMINISM. `Date.now()`, `new Date()` and `Math.random()` THROW. That is
 *     what makes resume possible — replaying a run's settled prefix has to
 *     produce the same control flow, and a script that branched on the clock
 *     would take a different path on the second pass and silently re-run work
 *     that had already been paid for.
 *   · CAPABILITY SHAPE. `require`, `import`, `process` and `fs` are simply
 *     ABSENT, so an authoring slip is a ReferenceError at compile time rather
 *     than a surprise at agent 40 of 60. The script narrates through the
 *     injected `log()`, not `console`.
 *   · COMPILE BEFORE SPEND. Everything here is synchronous and free. A script
 *     that cannot parse, is missing its `meta`, or reaches for a banned
 *     identifier is rejected before a `runId` exists and before one token is
 *     spent — and the rejection goes back to the AUTHORING AGENT in a shape it
 *     can act on, never to the user as a stack trace.
 *
 * Zero new dependencies.
 */

import vm from "node:vm";
import type { WarpMeta, WarpSurface } from "./surface";

// ── Determinism bans ────────────────────────────────────────────────────────

const banned = (name: string) => () => {
  throw new Error(`${name} is banned in Warp scripts (determinism)`);
};

/** `Math`, with `random` replaced. Its properties are non-enumerable, so this
 *  copies by own-property name rather than spreading — a spread would produce
 *  an empty object and silently ban all of `Math`. */
function safeMath(): typeof Math {
  const clone: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Math)) clone[key] = (Math as unknown as Record<string, unknown>)[key];
  clone.random = banned("Math.random");
  return Object.freeze(clone) as unknown as typeof Math;
}

/** A `Date` whose construction AND static `now` both throw — `new Date()` hits
 *  the constructor, `Date.now()` hits the static, and banning one without the
 *  other leaves the obvious way in. */
function bannedDate(): DateConstructor {
  const stub = function () {
    throw new Error("Date is banned in Warp scripts (determinism)");
  } as unknown as DateConstructor;
  (stub as { now: unknown }).now = banned("Date.now");
  return stub;
}

/**
 * The context's globals.
 *
 * HOST-REALM INTRINSICS on purpose: promises the injected `agent()` returns are
 * host promises, and a context with its own `Promise` realm would make `await`
 * on them work in a subtly different way than it reads. Deliberately no
 * `console`, `require`, `process` or `fs`.
 */
export function deterministicGlobals(): Record<string, unknown> {
  return {
    Object,
    Array,
    JSON,
    Promise,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    TypeError,
    Symbol,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    Math: safeMath(),
    Date: bannedDate(),
  };
}

// ── The hygiene lint ────────────────────────────────────────────────────────

/**
 * Blank out comments and string literals, KEEPING NEWLINES.
 *
 * So the lint below reads code rather than prose: a script whose comment
 * mentions `process` is not reaching for `process`, and rejecting it would
 * teach authors to stop writing comments. Newlines survive so reported line
 * numbers stay true.
 */
function stripCommentsAndStrings(code: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i]!;
    const next = code[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; out += "  "; i += 1; continue; }
      if (c === "/" && next === "*") { mode = "block"; out += "  "; i += 1; continue; }
      if (c === "'") { mode = "single"; out += " "; continue; }
      if (c === '"') { mode = "double"; out += " "; continue; }
      if (c === "`") { mode = "template"; out += " "; continue; }
      out += c;
      continue;
    }
    if (c === "\n") { out += "\n"; if (mode === "line") mode = "code"; continue; }
    if (mode === "line") { out += " "; continue; }
    if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; out += "  "; i += 1; } else out += " ";
      continue;
    }
    // Honour backslash escapes, or `\"` would end the string early and the rest
    // of the line would be linted as code.
    if (c === "\\") { out += "  "; i += 1; continue; }
    if ((mode === "single" && c === "'") || (mode === "double" && c === '"') || (mode === "template" && c === "`")) mode = "code";
    out += " ";
  }
  return out;
}

const BANNED_IDENTIFIERS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /\brequire\b/, id: "require" },
  // Scripts use `export const meta`; they never import. A script that tries is
  // reaching for the host's module graph.
  { pattern: /\bimport\b/, id: "import" },
  { pattern: /\bprocess\b/, id: "process" },
  { pattern: /\bDate\b/, id: "Date" },
  { pattern: /\bMath\s*\.\s*random\b/, id: "Math.random" },
];

/**
 * WHAT A REJECTION LOOKS LIKE.
 *
 * Structured, and it goes to the authoring agent rather than the user: `kind`
 * so it can branch, `detail` so it knows which identifier, `line` so it can fix
 * the right one without re-reading the whole script.
 */
export type WarpReject = { ok: false; error: string; kind: string; detail: string; line: number };

function lintBannedIdentifiers(code: string): WarpReject | null {
  const lines = stripCommentsAndStrings(code).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const entry of BANNED_IDENTIFIERS) {
      if (entry.pattern.test(lines[index]!)) {
        return {
          ok: false,
          error: `banned identifier '${entry.id}' at line ${index + 1} (determinism/hygiene)`,
          kind: "banned-identifier",
          detail: entry.id,
          line: index + 1,
        };
      }
    }
  }
  return null;
}

// ── `meta`, read statically ─────────────────────────────────────────────────

/** The `{…}` after `export const meta =`, matched by brace depth and
 *  string-aware so a `}` inside a description does not end it early. */
function extractMetaLiteral(code: string): { text: string; line: number } | null {
  const match = /export\s+const\s+meta\s*=/.exec(code);
  if (!match) return null;
  const line = code.slice(0, match.index).split("\n").length;
  let i = match.index + match[0].length;
  while (i < code.length && /\s/.test(code[i]!)) i += 1;
  if (code[i] !== "{") return { text: "", line };
  const start = i;
  let depth = 0;
  let inString: string | null = null;
  for (; i < code.length; i += 1) {
    const c = code[i]!;
    if (inString) {
      if (c === "\\") { i += 1; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "{") depth += 1;
    else if (c === "}" && (depth -= 1) === 0) return { text: code.slice(start, i + 1), line };
  }
  return { text: "", line };
}

/**
 * Evaluate the literal in a throwaway deterministic context.
 *
 * THE PURITY REQUIREMENT ENFORCES ITSELF HERE: anything that references an
 * identifier out of scope, calls a function, or spreads a variable throws, and
 * a throw is the rejection. Nothing else has to check for it.
 */
function evalMetaLiteral(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const context = vm.createContext(deterministicGlobals());
    const value = new vm.Script(`(${text})`).runInContext(context);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Compilation ─────────────────────────────────────────────────────────────

export type CompiledWarpScript = {
  ok: true;
  meta: WarpMeta;
  /** Runs the body with the surface installed as context globals. The returned
   *  promise settles with whatever the script's top-level `return` produced. */
  run: (surface: WarpSurface) => Promise<unknown>;
};
export type WarpCompileResult = CompiledWarpScript | WarpReject;

/**
 * THE BODY BECOMES AN ASYNC FUNCTION BODY, which is what makes the ergonomics
 * work: top-level `await` and top-level `return` are both ordinary inside one,
 * and every example the authoring agent has read uses them. `"use strict"` makes
 * an assignment to a frozen surface global throw rather than silently doing
 * nothing.
 *
 * `meta` is stripped of its `export` because it has already been read
 * statically; keeping the declaration means a script may still reference its own
 * meta.
 */
function wrap(code: string): string {
  const body = code.replace(/export\s+const\s+meta\s*=/, "const meta =");
  return `"use strict";\n(async function(){\n${body}\n})`;
}

const REQUIRED_META = ["name", "description"] as const;

/**
 * Parse, lint and read a script WITHOUT running it or spending anything.
 *
 * Every failure here is a `WarpReject` handed back to the authoring agent. The
 * one thing this does not do is execute the body: the returned `run` is a
 * closure over a context that has been created but not entered, so nothing the
 * script does happens until the runner injects a surface and calls it.
 */
export function compileWarpScript(code: string): WarpCompileResult {
  const banned = lintBannedIdentifiers(code);
  if (banned) return banned;

  const literal = extractMetaLiteral(code);
  if (!literal) {
    return { ok: false, error: "script is missing `export const meta`", kind: "no-meta", detail: "meta", line: 1 };
  }
  const meta = evalMetaLiteral(literal.text);
  if (!meta) {
    return {
      ok: false,
      error: "`export const meta` must be a pure object literal — no variables, calls, spreads or template interpolation",
      kind: "meta-not-literal",
      detail: "meta",
      line: literal.line,
    };
  }
  for (const key of REQUIRED_META) {
    if (typeof meta[key] !== "string" || !(meta[key] as string).trim()) {
      return {
        ok: false,
        error: `\`meta.${key}\` is required and must be a non-empty string`,
        kind: "meta-incomplete",
        detail: key,
        line: literal.line,
      };
    }
  }

  // Compiled, not run: a syntax error surfaces here, synchronously, with the
  // script's own line number rather than one from inside the harness.
  let factory: (this: unknown) => Promise<unknown>;
  try {
    const context = vm.createContext(deterministicGlobals());
    factory = new vm.Script(wrap(code), { filename: "warp-script.js" }).runInContext(context) as () => Promise<unknown>;
  } catch (error) {
    return {
      ok: false,
      error: `script failed to compile: ${(error as Error)?.message ?? String(error)}`,
      kind: "compile-error",
      detail: "top-level",
      line: 1,
    };
  }

  return {
    ok: true,
    meta: meta as WarpMeta,
    /**
     * THE SURFACE IS INSTALLED ON THE CONTEXT, not passed as an argument, so the
     * script can call `agent()` bare. Rebuilt per run rather than shared: two
     * concurrent runs of one script must not see each other's `phase()`.
     */
    run: (surface: WarpSurface) => {
      const context = vm.createContext({ ...deterministicGlobals(), ...surface });
      const bound = new vm.Script(wrap(code), { filename: "warp-script.js" }).runInContext(context) as () => Promise<unknown>;
      return Promise.resolve(bound());
    },
  };
}
