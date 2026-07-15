// Ultra script sandbox — capability-shaping + determinism, NOT a security
// boundary (doc §3). The script runs in a node:vm context whose global exposes
// ONLY pure intrinsics plus throwing determinism stubs; the injected surface
// (agent/parallel/…) is passed as the single ARGUMENT to the default export,
// never as a global. `require`/`import`/`process`/`fs` are simply absent, so an
// authoring slip is a ReferenceError, not a footgun. Node documents vm as "not
// a security mechanism" and a determined script can still walk the prototype
// chain to host globals — we do not pretend otherwise, because the first-party
// author holds no authority to fence (doc §3). Zero new deps.
import vm from "node:vm";
import type { UltraSurface } from "./surface";

// ── Determinism bans ────────────────────────────────────────────────────────
// Date.now / new Date() / Math.random THROW inside the context so a re-run is
// byte-identical given the same journal (doc §3, stricter than the reference
// which only documents the ban). The rest of Math is preserved.
const banned = (name: string) => () => {
  throw new Error(`${name} is banned in Ultra scripts (determinism)`);
};

// A Math clone with `random` replaced by a throwing stub. Math's props are
// non-enumerable, so we copy by own-property name rather than spread.
function safeMath(): typeof Math {
  const m: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(Math)) m[k] = (Math as unknown as Record<string, unknown>)[k];
  m.random = banned("Math.random");
  return Object.freeze(m) as unknown as typeof Math;
}

// A Date stub whose construction and .now() both throw. `new Date()` hits the
// constructor; `Date.now()` hits the static.
function bannedDate(): DateConstructor {
  const D = function () {
    throw new Error("Date is banned in Ultra scripts (determinism)");
  } as unknown as DateConstructor;
  (D as { now: unknown }).now = banned("Date.now");
  return D;
}

// The context globals: pure intrinsics (host-realm, so host promises from
// agent() interop cleanly) + the throwing determinism stubs. Deliberately no
// console/require/process/fs — the script narrates via the injected log().
export function deterministicGlobals(): Record<string, unknown> {
  return {
    Object, Array, JSON, Promise, Math: safeMath(),
    Number, String, Boolean, Symbol, BigInt,
    Map, Set, WeakMap, WeakSet,
    RegExp, Error, TypeError, RangeError, SyntaxError,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    Infinity, NaN, undefined,
    Date: bannedDate(),
  };
}

// ── Static hygiene lint ─────────────────────────────────────────────────────
// A determinism/hygiene AID, explicitly NOT a security control (doc §3): the vm
// stubs are the real defense-in-depth. We strip comments + string literals
// first so a benign word in meta.description ("summarize by date") never trips
// the scan. Regex-literal contents are not stripped — an acceptable blind spot
// for a hygiene aid.
function stripCommentsAndStrings(code: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tq" = "code";
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    const d = code[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") { mode = "line"; out += "  "; i++; continue; }
      if (c === "/" && d === "*") { mode = "block"; out += "  "; i++; continue; }
      if (c === "'") { mode = "sq"; out += " "; continue; }
      if (c === '"') { mode = "dq"; out += " "; continue; }
      if (c === "`") { mode = "tq"; out += " "; continue; }
      out += c;
      continue;
    }
    // Inside a string/comment: keep newlines (line numbers stay accurate),
    // blank everything else.
    if (c === "\n") { out += "\n"; if (mode === "line") mode = "code"; continue; }
    if (mode === "line") { out += " "; continue; }
    if (mode === "block") { if (c === "*" && d === "/") { mode = "code"; out += "  "; i++; } else out += " "; continue; }
    // sq/dq/tq: honor backslash escapes so \" or \' doesn't end the string early.
    if (c === "\\") { out += "  "; i++; continue; }
    if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tq" && c === "`")) mode = "code";
    out += " ";
  }
  return out;
}

const BANNED_IDENTIFIERS: Array<{ re: RegExp; id: string }> = [
  { re: /\brequire\b/, id: "require" },
  { re: /\bimport\b/, id: "import" }, // scripts use `export`, never `import`
  { re: /\bprocess\b/, id: "process" },
  { re: /\bDate\b/, id: "Date" },
  { re: /\bMath\s*\.\s*random\b/, id: "Math.random" },
];

export type SandboxReject = { ok: false; error: string; kind: string; detail: string; line: number };

function lint(code: string): SandboxReject | null {
  const lines = stripCommentsAndStrings(code).split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    for (const b of BANNED_IDENTIFIERS) {
      if (b.re.test(lines[ln]!)) {
        return {
          ok: false,
          error: `banned identifier '${b.id}' at line ${ln + 1} (determinism/hygiene)`,
          kind: "banned-identifier",
          detail: b.id,
          line: ln + 1,
        };
      }
    }
  }
  return null;
}

// ── meta: a PURE literal, statically read before any body execution ──────────
// We locate `export const meta = { … }` and brace-match the object literal, then
// evaluate JUST that literal in a capability-free deterministic context. A meta
// that references the surface, calls a function, or is not an object literal
// fails to evaluate to a plain object → reject (doc §3). This runs before the
// default body is ever invoked.
function extractMetaLiteral(code: string): { text: string; line: number } | null {
  const m = /export\s+const\s+meta\s*=/.exec(code);
  if (!m) return null;
  const line = code.slice(0, m.index).split("\n").length;
  let i = m.index + m[0].length;
  while (i < code.length && /\s/.test(code[i]!)) i++;
  if (code[i] !== "{") return { text: "", line }; // not an object literal
  const start = i;
  let depth = 0;
  let inStr: string | null = null;
  for (; i < code.length; i++) {
    const c = code[i]!;
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { text: code.slice(start, i + 1), line };
  }
  return { text: "", line }; // unbalanced
}

function evalMetaLiteral(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const ctx = vm.createContext(deterministicGlobals());
    const v = new vm.Script(`(${text})`).runInContext(ctx);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null; // references an identifier out of scope → not a pure literal
  }
}

// ── Compilation ──────────────────────────────────────────────────────────────
// A fixed CJS shim rewrites the ESM-shaped source (`export const meta = …` +
// `export default async function (surface) {}`) into an IIFE that evaluates to
// ({ meta, default }). "use strict" makes the frozen surface reject mutation
// (a silent no-op otherwise). Compiled once via new vm.Script — no experimental
// module flag. The default closure keeps the context alive; the body later runs
// in that context when called with the injected surface.
export type ScriptMeta = Record<string, unknown>;
export type CompiledScript = {
  ok: true;
  meta: ScriptMeta;
  run: (surface: UltraSurface) => unknown;
};
export type CompileResult = CompiledScript | SandboxReject;

function wrap(code: string): string {
  const body = code
    .replace(/export\s+const\s+meta\s*=/, "const meta =")
    .replace(/export\s+default\s+/, "const __ultra_default__ = ");
  return (
    `"use strict";\n(function(){\n${body}\n;` +
    `return { meta: (typeof meta!=="undefined"?meta:undefined),` +
    ` default: (typeof __ultra_default__!=="undefined"?__ultra_default__:undefined) };\n})`
  );
}

export function compileScript(code: string): CompileResult {
  const linted = lint(code);
  if (linted) return linted;

  const metaSrc = extractMetaLiteral(code);
  if (!metaSrc) {
    return { ok: false, error: "script is missing `export const meta`", kind: "no-meta", detail: "meta", line: 1 };
  }
  const meta = evalMetaLiteral(metaSrc.text);
  if (!meta) {
    return {
      ok: false,
      error: "`export const meta` must be a pure object literal (no function calls, no surface refs)",
      kind: "meta-not-literal",
      detail: "meta",
      line: metaSrc.line,
    };
  }

  let mod: { meta: unknown; default: unknown };
  try {
    const ctx = vm.createContext(deterministicGlobals());
    const factory = new vm.Script(wrap(code), { filename: "ultra-script.js" }).runInContext(ctx);
    mod = (factory as () => { meta: unknown; default: unknown })();
  } catch (e) {
    return {
      ok: false,
      error: `script failed to evaluate: ${(e as Error)?.message ?? String(e)}`,
      kind: "eval-error",
      detail: "top-level",
      line: 1,
    };
  }
  if (typeof mod.default !== "function") {
    return { ok: false, error: "script is missing `export default` function", kind: "no-default", detail: "default", line: 1 };
  }
  // meta is the statically-validated literal, not the module's copy — the
  // static read is the doctrine-mandated source of truth.
  return { ok: true, meta, run: mod.default as (surface: UltraSurface) => unknown };
}
